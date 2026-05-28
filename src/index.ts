import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { EnhancedEventEmitter } from 'mediasoup-client/enhancedEvents';
import * as ortc from 'mediasoup-client/ortc';
import { parseScalabilityMode } from 'mediasoup-client';
import { RemoteSdp } from 'mediasoup-client/handlers/sdp/RemoteSdp';
import * as sdpCommonUtils from 'mediasoup-client/handlers/sdp/commonUtils';
import * as sdpUnifiedPlanUtils from 'mediasoup-client/handlers/sdp/unifiedPlanUtils';
import * as ortcUtils from 'mediasoup-client/handlers/ortc/utils';
import * as sdpTransform from 'sdp-transform';

import type {
  DtlsRole,
  HandlerFactory,
  HandlerInterface,
  HandlerOptions,
  HandlerGetNativeRtpCapabilitiesOptions,
  HandlerSendOptions,
  HandlerSendResult,
  HandlerReceiveOptions,
  HandlerReceiveResult,
  HandlerSendDataChannelOptions,
  HandlerSendDataChannelResult,
  HandlerReceiveDataChannelOptions,
  HandlerReceiveDataChannelResult,
  HandlerEvents,
  IceParameters,
  MediaKind,
  RtpCapabilities, RtpHeaderExtensionUri, RtpHeaderExtensionDirection
} from 'mediasoup-client/types';
import type * as SdpTransform from 'sdp-transform';


const NAME = 'wrtc';
const SCTP_NUM_STREAMS = { OS: 65535, MIS: 65535 };
const WRTC_HANDLER_TEST_HOOKS = Symbol.for('mediasoup-client-wrtc/test-hooks');


type LoggerSink = Pick<Console, 'info' | 'warn' | 'error'>;

type MediasoupLoggerInstance = {
  debug: { log?: (...args: unknown[]) => void; (...args: unknown[]): void };
  warn: { log?: (...args: unknown[]) => void; (...args: unknown[]): void };
  error: { log?: (...args: unknown[]) => void; (...args: unknown[]): void };
};

type MediasoupLoggerClass = new (prefix?: string) => MediasoupLoggerInstance;
type InvalidStateErrorClass = new (message: string) => Error;

const require = createRequire(import.meta.url);
const mediasoupMainPath = require.resolve('mediasoup-client');
const mediasoupLibPath = dirname(mediasoupMainPath);

const { Logger: MediasoupLogger } = require(join(mediasoupLibPath, 'Logger.js')) as {
  Logger: MediasoupLoggerClass;
};

const { InvalidStateError } = require(join(mediasoupLibPath, 'errors.js')) as {
  InvalidStateError: InvalidStateErrorClass;
};


function createLogger(prefix: string, sink: LoggerSink): MediasoupLoggerInstance
{
  const logger = new MediasoupLogger(prefix);

  logger.debug.log = sink.info.bind(sink);
  logger.warn.log = sink.warn.bind(sink);
  logger.error.log = sink.error.bind(sink);

  return logger;
}


/**
 * Minimum subset of the WebRTC API required by this handler.
 * Pass an instance of `@roamhq/wrtc`, one of its named exports, or any other
 * object that exposes structurally-compatible WebRTC constructors.
 */
export interface WrtcLike
{
  RTCPeerConnection: new (configuration?: RTCConfiguration) => RTCPeerConnection;
  MediaStream: new () => MediaStream;
}

type ReleasableMediaStream = MediaStream & {
  release?: (releaseTracks?: boolean) => void;
};


export class WrtcHandler
  extends EnhancedEventEmitter<HandlerEvents>
  implements HandlerInterface
{
  readonly #wrtcRuntime: WrtcLike;
  readonly #logger: MediasoupLoggerInstance;

  #closed = false;
  #direction: 'send' | 'recv' | undefined;
  #remoteSdp: RemoteSdp | undefined;
  #getSendExtendedRtpCapabilitiesCb: HandlerOptions['getSendExtendedRtpCapabilities'] | undefined;
  #forcedLocalDtlsRole: DtlsRole | undefined;
  #pc: RTCPeerConnection | undefined;
  readonly #mapMidTransceiver = new Map<string, RTCRtpTransceiver>();
  #sendStream: MediaStream | undefined;
  #hasDataChannelMediaSection = false;
  #nextSendSctpStreamId = 0;
  #transportReady = false;

  readonly [WRTC_HANDLER_TEST_HOOKS] = {
    setupTransportWithoutLocalSdp: async (localDtlsRole: DtlsRole): Promise<void> =>
    {
      await this.#setupTransport({ localDtlsRole });
    },
  };

  static createFactory(wrtc: WrtcLike, loggerSink: LoggerSink = console): HandlerFactory
  {
    const logger = createLogger(NAME, loggerSink);

    function factory(options: HandlerOptions): HandlerInterface
    {
      return new WrtcHandler(wrtc, options, logger);
    }

    async function getNativeRtpCapabilities(
      {direction}: HandlerGetNativeRtpCapabilitiesOptions
    ): Promise<RtpCapabilities>
    {
      logger.debug('getNativeRtpCapabilities() [direction:%o]', direction);

      let pc: RTCPeerConnection | undefined = new wrtc.RTCPeerConnection({
        iceServers: [],
        iceTransportPolicy: 'all',
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
      });

      try
      {
        pc.addTransceiver('audio', { direction });
        pc.addTransceiver('video', { direction });

        const offer = await pc.createOffer();

        try { pc.close(); } catch (error) { /* ignore */ }
        pc = undefined;

        const sdpObject = sdpTransform.parse(offer.sdp!);

        return WrtcHandler.getLocalRtpCapabilities(sdpObject);
      }
      catch (error)
      {
        try { pc?.close(); } catch (error2) { /* ignore */ }
        pc = undefined;
        throw error;
      }
    }

    async function getNativeSctpCapabilities()
    {
      logger.debug('getNativeSctpCapabilities()');

      return { numStreams: SCTP_NUM_STREAMS };
    }

    return {
      name: NAME,

      factory,
      getNativeRtpCapabilities,
      getNativeSctpCapabilities
    };
  }

  constructor(wrtc: WrtcLike, options: HandlerOptions, logger: MediasoupLoggerInstance)
  {
    super();
    this.#logger = logger;
    this.#logger.debug('constructor()');

    this.#wrtcRuntime = wrtc;

    const {
      direction,
      iceParameters,
      iceCandidates,
      dtlsParameters,
      sctpParameters,
      iceServers,
      iceTransportPolicy,
      additionalSettings,
      getSendExtendedRtpCapabilities,
    } = options;

    this.#direction = direction;
    this.#remoteSdp = new RemoteSdp({
      iceParameters,
      iceCandidates,
      dtlsParameters,
      sctpParameters,
    });
    this.#getSendExtendedRtpCapabilitiesCb = getSendExtendedRtpCapabilities;

    if (dtlsParameters.role && dtlsParameters.role !== 'auto')
    {
      this.#forcedLocalDtlsRole =
        (dtlsParameters.role === 'server' ? 'client' : 'server') as DtlsRole;
    }

    this.#sendStream = new this.#wrtcRuntime.MediaStream();

    this.#pc = new this.#wrtcRuntime.RTCPeerConnection({
      iceServers: iceServers ?? [],
      iceTransportPolicy: iceTransportPolicy ?? 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      ...additionalSettings,
    });

    this.#pc.addEventListener('icegatheringstatechange', this.#onIceGatheringStateChange);
    this.#pc.addEventListener('icecandidateerror', this.#onIceCandidateError);

    if (this.#pc.connectionState)
    {
      this.#pc.addEventListener('connectionstatechange', this.#onConnectionStateChange);
    }
    else
    {
      this.#logger.warn('constructor() | pc.connectionState not supported, using pc.iceConnectionState');
      this.#pc.addEventListener('iceconnectionstatechange', this.#onIceConnectionStateChange);
    }
  }

  static getLocalRtpCapabilities(
    localSdpObject: SdpTransform.SessionDescription,
    extraHeaderExtensions: { uri: RtpHeaderExtensionUri; kind: MediaKind; direction: RtpHeaderExtensionDirection }[] = []
  )
  {
    const nativeRtpCapabilities = sdpCommonUtils.extractRtpCapabilities({
      sdpObject: localSdpObject,
    });

    ortc.validateAndNormalizeRtpCapabilities(nativeRtpCapabilities);
    ortcUtils.addNackSupportForOpus(nativeRtpCapabilities);

    for (const headerExtension of extraHeaderExtensions)
    {
      ortcUtils.addHeaderExtensionSupport(nativeRtpCapabilities, headerExtension);
    }

    return nativeRtpCapabilities;
  }

  get name(): string
  {
    return NAME;
  }

  close(): void
  {
    this.#logger.debug('close()');

    if (this.#closed)
      return;

    this.#closed = true;

    const sendStream = this.#sendStream as ReleasableMediaStream | undefined;

    try
    {
      sendStream?.release?.(false);
    }
    catch (error) { /* ignore */ }

    try
    {
      this.#pc!.close();
    }
    catch (error) { /* ignore */ }

    this.#pc!.removeEventListener('icegatheringstatechange', this.#onIceGatheringStateChange);
    this.#pc!.removeEventListener('icecandidateerror', this.#onIceCandidateError);
    this.#pc!.removeEventListener('connectionstatechange', this.#onConnectionStateChange);
    this.#pc!.removeEventListener('iceconnectionstatechange', this.#onIceConnectionStateChange);

    this.emit('@close');
    super.close();
  }

  async updateIceServers(iceServers: RTCIceServer[]): Promise<void>
  {
    this.#assertNotClosed();
    this.#logger.debug('updateIceServers()');

    const configuration = this.#pc!.getConfiguration();

    configuration.iceServers = iceServers;
    this.#pc!.setConfiguration(configuration);
  }

  async restartIce(iceParameters: IceParameters): Promise<void>
  {
    this.#assertNotClosed();
    this.#logger.debug('restartIce()');

    this.#remoteSdp!.updateIceParameters(iceParameters);

    if (!this.#transportReady)
      return;

    if (this.#direction === 'send')
    {
      const offer = await this.#pc!.createOffer({ iceRestart: true });

      this.#logger.debug('restartIce() | calling pc.setLocalDescription() [offer:%o]', offer);
      await this.#pc!.setLocalDescription(offer);

      const answer = { type: 'answer' as const, sdp: this.#remoteSdp!.getSdp() };

      this.#logger.debug('restartIce() | calling pc.setRemoteDescription() [answer:%o]', answer);
      await this.#pc!.setRemoteDescription(answer);
    }
    else
    {
      const offer = { type: 'offer' as const, sdp: this.#remoteSdp!.getSdp() };

      this.#logger.debug('restartIce() | calling pc.setRemoteDescription() [offer:%o]', offer);
      await this.#pc!.setRemoteDescription(offer);

      const answer = await this.#pc!.createAnswer();

      this.#logger.debug('restartIce() | calling pc.setLocalDescription() [answer:%o]', answer);
      await this.#pc!.setLocalDescription(answer);
    }
  }

  async getTransportStats(): Promise<RTCStatsReport>
  {
    this.#assertNotClosed();
    return this.#pc!.getStats();
  }

  async send({
    track,
    streamId,
    encodings,
    codecOptions,
    headerExtensionOptions,
    codec,
    onRtpSender,
  }: HandlerSendOptions): Promise<HandlerSendResult>
  {
    this.#assertNotClosed();
    this.#assertSendDirection();

    this.#logger.debug('send() [kind:%s, track.id:%s, streamId:%s]', track.kind, track.id, streamId);

    if (encodings && encodings.length > 1)
    {
      encodings.forEach((encoding, idx) =>
      {
        encoding.rid = `r${idx}`;
      });
    }

    const mediaSectionIdx = this.#remoteSdp!.getNextMediaSectionIdx();
    const transceiver = this.#pc!.addTransceiver(track, {
      direction: 'sendonly',
      streams: [ this.#sendStream! ],
      sendEncodings: encodings,
    });

    if (onRtpSender)
      onRtpSender(transceiver.sender);

    let offer = await this.#pc!.createOffer();
    let localSdpObject = sdpTransform.parse(offer.sdp!);

    if ((localSdpObject as any).extmapAllowMixed)
      this.#remoteSdp!.setSessionExtmapAllowMixed();

    const extraHeaderExtensions = [
      {
        uri: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time' as RtpHeaderExtensionUri,
        kind: track.kind as MediaKind,
        direction: 'sendonly' as RtpHeaderExtensionDirection,
      },
    ];

    const nativeRtpCapabilities =
      WrtcHandler.getLocalRtpCapabilities(localSdpObject, extraHeaderExtensions);
    const sendExtendedRtpCapabilities =
      this.#getSendExtendedRtpCapabilitiesCb!(nativeRtpCapabilities);

    const sendingRtpParameters =
      ortc.getSendingRtpParameters(track.kind as MediaKind, sendExtendedRtpCapabilities);

    sendingRtpParameters.codecs = ortc.reduceCodecs(sendingRtpParameters.codecs, codec);

    const sendingRemoteRtpParameters =
      ortc.getSendingRemoteRtpParameters(track.kind as MediaKind, sendExtendedRtpCapabilities);

    sendingRemoteRtpParameters.codecs =
      ortc.reduceCodecs(sendingRemoteRtpParameters.codecs, codec);

    if (!this.#transportReady)
    {
      await this.#setupTransport({
        localDtlsRole: this.#forcedLocalDtlsRole ?? 'client',
        localSdpObject,
      });
    }

    let hackVp9Svc = false;
    const layers = parseScalabilityMode((encodings ?? [ {} ])[0].scalabilityMode);
    let offerMediaObject: any;

    if (
      encodings?.length === 1 &&
      layers.spatialLayers > 1 &&
      sendingRtpParameters.codecs[0].mimeType.toLowerCase() === 'video/vp9'
    )
    {
      this.#logger.debug('send() | enabling legacy simulcast for VP9 SVC');
      hackVp9Svc = true;
      localSdpObject = sdpTransform.parse(offer.sdp!);
      offerMediaObject = (localSdpObject as any).media[mediaSectionIdx.idx];
      sdpUnifiedPlanUtils.addLegacySimulcast({
        offerMediaObject,
        numStreams: layers.spatialLayers,
      });
      offer = { type: 'offer', sdp: sdpTransform.write(localSdpObject) };
    }

    if (headerExtensionOptions?.absCaptureTime)
    {
      offerMediaObject = (localSdpObject as any).media[mediaSectionIdx.idx];
      sdpCommonUtils.addHeaderExtension({
        offerMediaObject,
        headerExtensionUri:
          'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time',
        headerExtensionId: sendingRemoteRtpParameters.headerExtensions!.find(
          (he) =>
            he.uri === 'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time'
        )!.id,
      });
      offer = { type: 'offer', sdp: sdpTransform.write(localSdpObject) };
    }

    this.#logger.debug('send() | calling pc.setLocalDescription() [offer:%o]', offer);
    await this.#pc!.setLocalDescription(offer);

    let localId: string | undefined = transceiver.mid ?? undefined;

    if (!localId)
      this.#logger.warn('send() | missing transceiver.mid, applying delayed MID workaround');

    sendingRtpParameters.mid = localId;

    localSdpObject = sdpTransform.parse(this.#pc!.localDescription!.sdp);
    offerMediaObject = (localSdpObject as any).media[mediaSectionIdx.idx];

    sendingRtpParameters.rtcp!.cname = sdpCommonUtils.getCname({ offerMediaObject });
    sendingRtpParameters.msid = `${streamId ?? this.#sendStream!.id} ${track.id}`;

    if (!encodings)
    {
      sendingRtpParameters.encodings = sdpUnifiedPlanUtils.getRtpEncodings({
        offerMediaObject,
        codecs: sendingRtpParameters.codecs,
      });
    }
    else if (encodings.length === 1)
    {
      let newEncodings = sdpUnifiedPlanUtils.getRtpEncodings({
        offerMediaObject,
        codecs: sendingRtpParameters.codecs,
      });

      Object.assign(newEncodings[0], encodings[0]);

      if (hackVp9Svc)
        newEncodings = [ newEncodings[0] ];

      sendingRtpParameters.encodings = newEncodings;
    }
    else
    {
      sendingRtpParameters.encodings = encodings;
    }

    if (
      sendingRtpParameters.encodings.length > 1 &&
      (sendingRtpParameters.codecs[0].mimeType.toLowerCase() === 'video/vp8' ||
        sendingRtpParameters.codecs[0].mimeType.toLowerCase() === 'video/h264')
    )
    {
      for (const encoding of sendingRtpParameters.encodings)
      {
        encoding.scalabilityMode = encoding.scalabilityMode
          ? `L1T${layers.temporalLayers}`
          : 'L1T3';
      }
    }

    this.#remoteSdp!.send({
      offerMediaObject,
      reuseMid: mediaSectionIdx.reuseMid,
      offerRtpParameters: sendingRtpParameters,
      answerRtpParameters: sendingRemoteRtpParameters,
      codecOptions,
    });

    const answer = { type: 'answer' as const, sdp: this.#remoteSdp!.getSdp() };

    this.#logger.debug('send() | calling pc.setRemoteDescription() [answer:%o]', answer);
    await this.#pc!.setRemoteDescription(answer);

    if (!localId)
    {
      localId = transceiver.mid!;
      sendingRtpParameters.mid = localId;
    }

    this.#mapMidTransceiver.set(localId, transceiver);

    return {
      localId,
      rtpParameters: sendingRtpParameters,
      rtpSender: transceiver.sender,
    };
  }

  async stopSending(localId: string): Promise<void>
  {
    this.#assertSendDirection();

    if (this.#closed)
      return;

    this.#logger.debug('stopSending() [localId:%s]', localId);

    const transceiver = this.#mapMidTransceiver.get(localId);

    if (!transceiver)
      throw new Error('associated RTCRtpTransceiver not found');

    void transceiver.sender.replaceTrack(null);
    this.#pc!.removeTrack(transceiver.sender);

    const mediaSectionClosed = this.#remoteSdp!.closeMediaSection(transceiver.mid!);

    if (mediaSectionClosed)
    {
      try
      {
        transceiver.stop();
      }
      catch (error) { /* ignore */ }
    }

    const offer = await this.#pc!.createOffer();

    this.#logger.debug('stopSending() | calling pc.setLocalDescription() [offer:%o]', offer);
    await this.#pc!.setLocalDescription(offer);

    const answer = { type: 'answer' as const, sdp: this.#remoteSdp!.getSdp() };

    this.#logger.debug('stopSending() | calling pc.setRemoteDescription() [answer:%o]', answer);
    await this.#pc!.setRemoteDescription(answer);

    this.#mapMidTransceiver.delete(localId);
  }

  async pauseSending(localId: string): Promise<void>
  {
    this.#assertNotClosed();
    this.#assertSendDirection();

    this.#logger.debug('pauseSending() [localId:%s]', localId);

    const transceiver = this.#mapMidTransceiver.get(localId);

    if (!transceiver)
      throw new Error('associated RTCRtpTransceiver not found');

    transceiver.direction = 'inactive';
    this.#remoteSdp!.pauseMediaSection(localId);

    const offer = await this.#pc!.createOffer();

    this.#logger.debug('pauseSending() | calling pc.setLocalDescription() [offer:%o]', offer);
    await this.#pc!.setLocalDescription(offer);

    const answer = { type: 'answer' as const, sdp: this.#remoteSdp!.getSdp() };

    this.#logger.debug('pauseSending() | calling pc.setRemoteDescription() [answer:%o]', answer);
    await this.#pc!.setRemoteDescription(answer);
  }

  async resumeSending(localId: string): Promise<void>
  {
    this.#assertNotClosed();
    this.#assertSendDirection();

    this.#logger.debug('resumeSending() [localId:%s]', localId);

    const transceiver = this.#mapMidTransceiver.get(localId);

    this.#remoteSdp!.resumeSendingMediaSection(localId);

    if (!transceiver)
      throw new Error('associated RTCRtpTransceiver not found');

    transceiver.direction = 'sendonly';

    const offer = await this.#pc!.createOffer();

    this.#logger.debug('resumeSending() | calling pc.setLocalDescription() [offer:%o]', offer);
    await this.#pc!.setLocalDescription(offer);

    const answer = { type: 'answer' as const, sdp: this.#remoteSdp!.getSdp() };

    this.#logger.debug('resumeSending() | calling pc.setRemoteDescription() [answer:%o]', answer);
    await this.#pc!.setRemoteDescription(answer);
  }

  async replaceTrack(
    localId: string,
    track: MediaStreamTrack | null
  ): Promise<void>
  {
    this.#assertNotClosed();
    this.#assertSendDirection();

    if (track)
      this.#logger.debug('replaceTrack() [localId:%s, track.id:%s]', localId, track.id);
    else
      this.#logger.debug('replaceTrack() [localId:%s, no track]', localId);

    const transceiver = this.#mapMidTransceiver.get(localId);

    if (!transceiver)
      throw new Error('associated RTCRtpTransceiver not found');

    await transceiver.sender.replaceTrack(track);
  }

  async setMaxSpatialLayer(localId: string, spatialLayer: number): Promise<void>
  {
    this.#assertNotClosed();
    this.#assertSendDirection();

    this.#logger.debug(
      'setMaxSpatialLayer() [localId:%s, spatialLayer:%s]',
      localId,
      spatialLayer
    );

    const transceiver = this.#mapMidTransceiver.get(localId);

    if (!transceiver)
      throw new Error('associated RTCRtpTransceiver not found');

    const parameters = transceiver.sender.getParameters();

    parameters.encodings.forEach((encoding, idx) =>
    {
      encoding.active = idx <= spatialLayer;
    });

    await transceiver.sender.setParameters(parameters);
    this.#remoteSdp!.muxMediaSectionSimulcast(localId, parameters.encodings);

    const offer = await this.#pc!.createOffer();

    this.#logger.debug(
      'setMaxSpatialLayer() | calling pc.setLocalDescription() [offer:%o]',
      offer
    );
    await this.#pc!.setLocalDescription(offer);

    const answer = { type: 'answer' as const, sdp: this.#remoteSdp!.getSdp() };

    this.#logger.debug(
      'setMaxSpatialLayer() | calling pc.setRemoteDescription() [answer:%o]',
      answer
    );
    await this.#pc!.setRemoteDescription(answer);
  }

  async setRtpEncodingParameters(
    localId: string,
    params: Partial<RTCRtpEncodingParameters>
  ): Promise<void>
  {
    this.#assertNotClosed();
    this.#assertSendDirection();

    this.#logger.debug(
      'setRtpEncodingParameters() [localId:%s, params:%o]',
      localId,
      params
    );

    const transceiver = this.#mapMidTransceiver.get(localId);

    if (!transceiver)
      throw new Error('associated RTCRtpTransceiver not found');

    const parameters = transceiver.sender.getParameters();

    parameters.encodings.forEach((encoding, idx) =>
    {
      parameters.encodings[idx] = { ...encoding, ...params };
    });

    await transceiver.sender.setParameters(parameters);
    this.#remoteSdp!.muxMediaSectionSimulcast(localId, parameters.encodings);

    const offer = await this.#pc!.createOffer();

    this.#logger.debug(
      'setRtpEncodingParameters() | calling pc.setLocalDescription() [offer:%o]',
      offer
    );
    await this.#pc!.setLocalDescription(offer);

    const answer = { type: 'answer' as const, sdp: this.#remoteSdp!.getSdp() };

    this.#logger.debug(
      'setRtpEncodingParameters() | calling pc.setRemoteDescription() [answer:%o]',
      answer
    );
    await this.#pc!.setRemoteDescription(answer);
  }

  async getSenderStats(localId: string): Promise<RTCStatsReport>
  {
    this.#assertNotClosed();
    this.#assertSendDirection();

    const transceiver = this.#mapMidTransceiver.get(localId);

    if (!transceiver)
      throw new Error('associated RTCRtpTransceiver not found');

    return transceiver.sender.getStats();
  }

  async sendDataChannel({
    sctpStreamParameters,
  }: HandlerSendDataChannelOptions): Promise<HandlerSendDataChannelResult>
  {
    this.#assertNotClosed();
    this.#assertSendDirection();

    const options = {
      negotiated: true,
      id: this.#nextSendSctpStreamId,
      ordered: sctpStreamParameters.ordered,
      maxPacketLifeTime: sctpStreamParameters.maxPacketLifeTime,
      maxRetransmits: sctpStreamParameters.maxRetransmits,
      protocol: sctpStreamParameters.protocol,
    };

    this.#logger.debug('sendDataChannel() [options:%o]', options);

    const dataChannel = this.#pc!.createDataChannel(
      sctpStreamParameters.label ?? '',
      options
    );

    this.#nextSendSctpStreamId =
      ++this.#nextSendSctpStreamId % SCTP_NUM_STREAMS.MIS;

    if (!this.#hasDataChannelMediaSection)
    {
      const offer = await this.#pc!.createOffer();
      const localSdpObject = sdpTransform.parse(offer.sdp!);
      const offerMediaObject = (localSdpObject as any).media.find(
        (m: any) => m.type === 'application'
      );

      if (!this.#transportReady)
      {
        await this.#setupTransport({
          localDtlsRole: this.#forcedLocalDtlsRole ?? 'client',
          localSdpObject,
        });
      }

      this.#logger.debug(
        'sendDataChannel() | calling pc.setLocalDescription() [offer:%o]',
        offer
      );
      await this.#pc!.setLocalDescription(offer);

      this.#remoteSdp!.sendSctpAssociation({ offerMediaObject });

      const answer = { type: 'answer' as const, sdp: this.#remoteSdp!.getSdp() };

      this.#logger.debug(
        'sendDataChannel() | calling pc.setRemoteDescription() [answer:%o]',
        answer
      );
      await this.#pc!.setRemoteDescription(answer);

      this.#hasDataChannelMediaSection = true;
    }

    const newSctpStreamParameters = {
      streamId: options.id,
      ordered: options.ordered,
      maxPacketLifeTime: options.maxPacketLifeTime,
      maxRetransmits: options.maxRetransmits,
    };

    return { dataChannel, sctpStreamParameters: newSctpStreamParameters };
  }

  async receive(optionsList: HandlerReceiveOptions[]): Promise<HandlerReceiveResult[]>
  {
    this.#assertNotClosed();
    this.#assertRecvDirection();

    const results: HandlerReceiveResult[] = [];
    const mapLocalId = new Map<string, string>();

    for (const options of optionsList)
    {
      const { trackId, kind, rtpParameters, streamId } = options;

      this.#logger.debug('receive() [trackId:%s, kind:%s]', trackId, kind);

      const localId =
        rtpParameters.mid ?? String(this.#mapMidTransceiver.size);

      mapLocalId.set(trackId, localId);

      const { msidStreamId } =
        ortcUtils.getMsidStreamIdAndTrackId(rtpParameters.msid);

      this.#remoteSdp!.receive({
        mid: localId,
        kind,
        offerRtpParameters: rtpParameters,
        streamId: streamId ?? msidStreamId ?? rtpParameters.rtcp?.cname ?? '-',
        trackId,
      });
    }

    const offer = { type: 'offer' as const, sdp: this.#remoteSdp!.getSdp() };

    this.#logger.debug('receive() | calling pc.setRemoteDescription() [offer:%o]', offer);
    await this.#pc!.setRemoteDescription(offer);

    for (const options of optionsList)
    {
      const { trackId, onRtpReceiver } = options;

      if (onRtpReceiver)
      {
        const localId = mapLocalId.get(trackId)!;
        const transceiver = this.#pc!
          .getTransceivers()
          .find((t) => t.mid === localId);

        if (!transceiver)
          throw new Error('transceiver not found');

        onRtpReceiver(transceiver.receiver);
      }
    }

    let answer = await this.#pc!.createAnswer();
    const localSdpObject = sdpTransform.parse(answer.sdp!);

    for (const options of optionsList)
    {
      const { trackId, rtpParameters } = options;
      const localId = mapLocalId.get(trackId)!;
      const answerMediaObject = (localSdpObject as any).media.find(
        (m: any) => String(m.mid) === localId
      );

      sdpCommonUtils.applyCodecParameters({
        offerRtpParameters: rtpParameters,
        answerMediaObject,
      });
    }

    answer = {
      type: 'answer',
      sdp: sdpTransform.write(localSdpObject),
    };

    if (!this.#transportReady)
    {
      await this.#setupTransport({
        localDtlsRole: this.#forcedLocalDtlsRole ?? 'client',
        localSdpObject,
      });
    }

    this.#logger.debug('receive() | calling pc.setLocalDescription() [answer:%o]', answer);
    await this.#pc!.setLocalDescription(answer);

    for (const options of optionsList)
    {
      const { trackId } = options;
      const localId = mapLocalId.get(trackId)!;
      const transceiver = this.#pc!
        .getTransceivers()
        .find((t) => t.mid === localId);

      if (!transceiver)
        throw new Error('new RTCRtpTransceiver not found');

      this.#mapMidTransceiver.set(localId, transceiver);
      results.push({
        localId,
        track: transceiver.receiver.track,
        rtpReceiver: transceiver.receiver,
      });
    }

    return results;
  }

  async stopReceiving(localIds: string[]): Promise<void>
  {
    this.#assertRecvDirection();

    if (this.#closed)
      return;

    for (const localId of localIds)
    {
      this.#logger.debug('stopReceiving() [localId:%s]', localId);

      const transceiver = this.#mapMidTransceiver.get(localId);

      if (!transceiver)
        throw new Error('associated RTCRtpTransceiver not found');

      this.#remoteSdp!.closeMediaSection(transceiver.mid!);
    }

    const offer = { type: 'offer' as const, sdp: this.#remoteSdp!.getSdp() };

    this.#logger.debug(
      'stopReceiving() | calling pc.setRemoteDescription() [offer:%o]',
      offer
    );
    await this.#pc!.setRemoteDescription(offer);

    const answer = await this.#pc!.createAnswer();

    this.#logger.debug(
      'stopReceiving() | calling pc.setLocalDescription() [answer:%o]',
      answer
    );
    await this.#pc!.setLocalDescription(answer);

    for (const localId of localIds)
      this.#mapMidTransceiver.delete(localId);
  }

  async pauseReceiving(localIds: string[]): Promise<void>
  {
    this.#assertNotClosed();
    this.#assertRecvDirection();

    for (const localId of localIds)
    {
      this.#logger.debug('pauseReceiving() [localId:%s]', localId);

      const transceiver = this.#mapMidTransceiver.get(localId);

      if (!transceiver)
        throw new Error('associated RTCRtpTransceiver not found');

      transceiver.direction = 'inactive';
      this.#remoteSdp!.pauseMediaSection(localId);
    }

    const offer = { type: 'offer' as const, sdp: this.#remoteSdp!.getSdp() };

    this.#logger.debug(
      'pauseReceiving() | calling pc.setRemoteDescription() [offer:%o]',
      offer
    );
    await this.#pc!.setRemoteDescription(offer);

    const answer = await this.#pc!.createAnswer();

    this.#logger.debug(
      'pauseReceiving() | calling pc.setLocalDescription() [answer:%o]',
      answer
    );
    await this.#pc!.setLocalDescription(answer);
  }

  async resumeReceiving(localIds: string[]): Promise<void>
  {
    this.#assertNotClosed();
    this.#assertRecvDirection();

    for (const localId of localIds)
    {
      this.#logger.debug('resumeReceiving() [localId:%s]', localId);

      const transceiver = this.#mapMidTransceiver.get(localId);

      if (!transceiver)
        throw new Error('associated RTCRtpTransceiver not found');

      transceiver.direction = 'recvonly';
      this.#remoteSdp!.resumeReceivingMediaSection(localId);
    }

    const offer = { type: 'offer' as const, sdp: this.#remoteSdp!.getSdp() };

    this.#logger.debug(
      'resumeReceiving() | calling pc.setRemoteDescription() [offer:%o]',
      offer
    );
    await this.#pc!.setRemoteDescription(offer);

    const answer = await this.#pc!.createAnswer();

    this.#logger.debug(
      'resumeReceiving() | calling pc.setLocalDescription() [answer:%o]',
      answer
    );
    await this.#pc!.setLocalDescription(answer);
  }

  async getReceiverStats(localId: string): Promise<RTCStatsReport>
  {
    this.#assertNotClosed();
    this.#assertRecvDirection();

    const transceiver = this.#mapMidTransceiver.get(localId);

    if (!transceiver)
      throw new Error('associated RTCRtpTransceiver not found');

    return transceiver.receiver.getStats();
  }

  async receiveDataChannel({
    maxMessageSize,
    sctpStreamParameters,
    label,
    protocol,
  }: HandlerReceiveDataChannelOptions): Promise<HandlerReceiveDataChannelResult>
  {
    this.#assertNotClosed();
    this.#assertRecvDirection();

    const {
      streamId,
      ordered,
      maxPacketLifeTime,
      maxRetransmits,
    } = sctpStreamParameters;

    const options = {
      negotiated: true,
      id: streamId,
      ordered,
      maxPacketLifeTime,
      maxRetransmits,
      protocol,
    };

    this.#logger.debug('receiveDataChannel() [options:%o]', options);

    const dataChannel = this.#pc!.createDataChannel(label ?? '', options);

    if (!this.#hasDataChannelMediaSection)
    {
      this.#remoteSdp!.receiveSctpAssociation();

      const offer = { type: 'offer' as const, sdp: this.#remoteSdp!.getSdp() };

      this.#logger.debug(
        'receiveDataChannel() | calling pc.setRemoteDescription() [offer:%o]',
        offer
      );
      await this.#pc!.setRemoteDescription(offer);

      let answer = await this.#pc!.createAnswer();
      const localSdpObject = sdpTransform.parse(answer.sdp!);
      const answerMediaObject = (localSdpObject as any).media.find(
        (m: any) => m.type === 'application'
      );

      answerMediaObject.maxMessageSize = maxMessageSize;

      if (!this.#transportReady)
      {
        await this.#setupTransport({
          localDtlsRole: this.#forcedLocalDtlsRole ?? 'client',
          localSdpObject,
        });
      }

      answer = { type: 'answer', sdp: sdpTransform.write(localSdpObject) };

      this.#logger.debug(
        'receiveDataChannel() | calling pc.setLocalDescription() [answer:%o]',
        answer
      );
      await this.#pc!.setLocalDescription(answer);

      this.#hasDataChannelMediaSection = true;
    }

    return { dataChannel };
  }

  getDataChannelMaxMessageSize(): number | undefined
  {
    return this.#pc!.sctp?.maxMessageSize;
  }

  async #setupTransport({
    localDtlsRole,
    localSdpObject,
  }: {
    localDtlsRole: DtlsRole;
    localSdpObject?: SdpTransform.SessionDescription;
  }): Promise<void>
  {
    if (!localSdpObject)
      localSdpObject = sdpTransform.parse(this.#pc!.localDescription!.sdp);

    const dtlsParameters = sdpCommonUtils.extractDtlsParameters({
      sdpObject: localSdpObject,
    });

    dtlsParameters.role = localDtlsRole;
    this.#remoteSdp!.updateDtlsRole(
      (localDtlsRole === 'client' ? 'server' : 'client') as DtlsRole
    );

    await new Promise<void>((resolve, reject) =>
    {
      this.safeEmit('@connect', { dtlsParameters }, resolve, reject);
    });

    this.#transportReady = true;
  }

  readonly #onIceGatheringStateChange = (): void =>
  {
    this.emit('@icegatheringstatechange', this.#pc!.iceGatheringState);
  };

  readonly #onIceCandidateError = (event: Event): void =>
  {
    this.emit('@icecandidateerror', event as RTCPeerConnectionIceErrorEvent);
  };

  readonly #onConnectionStateChange = (): void =>
  {
    this.emit('@connectionstatechange', this.#pc!.connectionState);
  };

  readonly #onIceConnectionStateChange = (): void =>
  {
    switch (this.#pc!.iceConnectionState)
    {
      case 'checking':
        this.emit('@connectionstatechange', 'connecting');
        break;

      case 'connected':
      case 'completed':
        this.emit('@connectionstatechange', 'connected');
        break;

      case 'failed':
        this.emit('@connectionstatechange', 'failed');
        break;

      case 'disconnected':
        this.emit('@connectionstatechange', 'disconnected');
        break;

      case 'closed':
        this.emit('@connectionstatechange', 'closed');
        break;
    }
  };

  #assertNotClosed(): void
  {
    if (this.#closed)
      throw new InvalidStateError('method called in a closed handler');
  }

  #assertSendDirection(): void
  {
    if (this.#direction !== 'send')
      throw new Error(
        'method can just be called for handlers with "send" direction'
      );
  }

  #assertRecvDirection(): void
  {
    if (this.#direction !== 'recv')
      throw new Error(
        'method can just be called for handlers with "recv" direction'
      );
  }
}

export default WrtcHandler;
