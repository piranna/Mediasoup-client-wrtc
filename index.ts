import createDebug from 'debug';
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
const logger = new Logger(NAME);


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


class WrtcHandler
  extends EnhancedEventEmitter<HandlerEvents>
  implements HandlerInterface
{
  private readonly _wrtc: WrtcLike;

  private _closed = false;
  private _direction: 'send' | 'recv' | undefined;
  private _remoteSdp: RemoteSdp | undefined;
  private _getSendExtendedRtpCapabilities: HandlerOptions['getSendExtendedRtpCapabilities'] | undefined;
  private _forcedLocalDtlsRole: DtlsRole | undefined;
  private _pc: RTCPeerConnection | undefined;
  private readonly _mapMidTransceiver = new Map<string, RTCRtpTransceiver>();
  private _sendStream: MediaStream | undefined;
  private _hasDataChannelMediaSection = false;
  private _nextSendSctpStreamId = 0;
  private _transportReady = false;

  constructor(wrtc: WrtcLike, options: HandlerOptions)
  {
    super();
    logger.debug('constructor()');

    this._wrtc = wrtc;

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

    this._direction = direction;
    this._remoteSdp = new RemoteSdp({
      iceParameters,
      iceCandidates,
      dtlsParameters,
      sctpParameters,
    });
    this._getSendExtendedRtpCapabilities = getSendExtendedRtpCapabilities;

    if (dtlsParameters.role && dtlsParameters.role !== 'auto')
    {
      this._forcedLocalDtlsRole =
        (dtlsParameters.role === 'server' ? 'client' : 'server') as DtlsRole;
    }

    this._sendStream = new this._wrtc.MediaStream();

    this._pc = new this._wrtc.RTCPeerConnection({
      iceServers: iceServers ?? [],
      iceTransportPolicy: iceTransportPolicy ?? 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      ...additionalSettings,
    });

    this._pc.addEventListener('icegatheringstatechange', this._onIceGatheringStateChange);
    this._pc.addEventListener('icecandidateerror', this._onIceCandidateError);

    if (this._pc.connectionState)
    {
      this._pc.addEventListener('connectionstatechange', this._onConnectionStateChange);
    }
    else
    {
      logger.warn('constructor() | pc.connectionState not supported, using pc.iceConnectionState');
      this._pc.addEventListener('iceconnectionstatechange', this._onIceConnectionStateChange);
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
    logger.debug('close()');

    if (this._closed)
      return;

    this._closed = true;

    try
    {
      this._pc!.close();
    }
    catch (error) { /* ignore */ }

    this._pc!.removeEventListener('icegatheringstatechange', this._onIceGatheringStateChange);
    this._pc!.removeEventListener('icecandidateerror', this._onIceCandidateError);
    this._pc!.removeEventListener('connectionstatechange', this._onConnectionStateChange);
    this._pc!.removeEventListener('iceconnectionstatechange', this._onIceConnectionStateChange);

    this.emit('@close');
    super.close();
  }

  async updateIceServers(iceServers: RTCIceServer[]): Promise<void>
  {
    this._assertNotClosed();
    logger.debug('updateIceServers()');

    const configuration = this._pc!.getConfiguration();

    configuration.iceServers = iceServers;
    this._pc!.setConfiguration(configuration);
  }

  async restartIce(iceParameters: IceParameters): Promise<void>
  {
    this._assertNotClosed();
    logger.debug('restartIce()');

    this._remoteSdp!.updateIceParameters(iceParameters);

    if (!this._transportReady)
      return;

    if (this._direction === 'send')
    {
      const offer = await this._pc!.createOffer({ iceRestart: true });

      logger.debug('restartIce() | calling pc.setLocalDescription() [offer:%o]', offer);
      await this._pc!.setLocalDescription(offer);

      const answer = { type: 'answer' as const, sdp: this._remoteSdp!.getSdp() };

      logger.debug('restartIce() | calling pc.setRemoteDescription() [answer:%o]', answer);
      await this._pc!.setRemoteDescription(answer);
    }
    else
    {
      const offer = { type: 'offer' as const, sdp: this._remoteSdp!.getSdp() };

      logger.debug('restartIce() | calling pc.setRemoteDescription() [offer:%o]', offer);
      await this._pc!.setRemoteDescription(offer);

      const answer = await this._pc!.createAnswer();

      logger.debug('restartIce() | calling pc.setLocalDescription() [answer:%o]', answer);
      await this._pc!.setLocalDescription(answer);
    }
  }

  async getTransportStats(): Promise<RTCStatsReport>
  {
    this._assertNotClosed();
    return this._pc!.getStats();
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
    this._assertNotClosed();
    this._assertSendDirection();

    logger.debug('send() [kind:%s, track.id:%s, streamId:%s]', track.kind, track.id, streamId);

    if (encodings && encodings.length > 1)
    {
      encodings.forEach((encoding, idx) =>
      {
        encoding.rid = `r${idx}`;
      });
    }

    const mediaSectionIdx = this._remoteSdp!.getNextMediaSectionIdx();
    const transceiver = this._pc!.addTransceiver(track, {
      direction: 'sendonly',
      streams: [ this._sendStream! ],
      sendEncodings: encodings,
    });

    if (onRtpSender)
      onRtpSender(transceiver.sender);

    let offer = await this._pc!.createOffer();
    let localSdpObject = sdpTransform.parse(offer.sdp!);

    if ((localSdpObject as any).extmapAllowMixed)
      this._remoteSdp!.setSessionExtmapAllowMixed();

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
      this._getSendExtendedRtpCapabilities!(nativeRtpCapabilities);

    const sendingRtpParameters =
      ortc.getSendingRtpParameters(track.kind as MediaKind, sendExtendedRtpCapabilities);

    sendingRtpParameters.codecs = ortc.reduceCodecs(sendingRtpParameters.codecs, codec);

    const sendingRemoteRtpParameters =
      ortc.getSendingRemoteRtpParameters(track.kind as MediaKind, sendExtendedRtpCapabilities);

    sendingRemoteRtpParameters.codecs =
      ortc.reduceCodecs(sendingRemoteRtpParameters.codecs, codec);

    if (!this._transportReady)
    {
      await this._setupTransport({
        localDtlsRole: this._forcedLocalDtlsRole ?? 'client',
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
      logger.debug('send() | enabling legacy simulcast for VP9 SVC');
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

    logger.debug('send() | calling pc.setLocalDescription() [offer:%o]', offer);
    await this._pc!.setLocalDescription(offer);

    let localId: string | undefined = transceiver.mid ?? undefined;

    sendingRtpParameters.mid = localId;

    localSdpObject = sdpTransform.parse(this._pc!.localDescription!.sdp);
    offerMediaObject = (localSdpObject as any).media[mediaSectionIdx.idx];

    sendingRtpParameters.rtcp!.cname = sdpCommonUtils.getCname({ offerMediaObject });
    sendingRtpParameters.msid = `${streamId ?? this._sendStream!.id} ${track.id}`;

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

    this._remoteSdp!.send({
      offerMediaObject,
      reuseMid: mediaSectionIdx.reuseMid,
      offerRtpParameters: sendingRtpParameters,
      answerRtpParameters: sendingRemoteRtpParameters,
      codecOptions,
    });

    const answer = { type: 'answer' as const, sdp: this._remoteSdp!.getSdp() };

    logger.debug('send() | calling pc.setRemoteDescription() [answer:%o]', answer);
    await this._pc!.setRemoteDescription(answer);

    if (!localId)
    {
      localId = transceiver.mid!;
      sendingRtpParameters.mid = localId;
    }

    this._mapMidTransceiver.set(localId, transceiver);

    return {
      localId,
      rtpParameters: sendingRtpParameters,
      rtpSender: transceiver.sender,
    };
  }

  async stopSending(localId: string): Promise<void>
  {
    this._assertSendDirection();

    if (this._closed)
      return;

    logger.debug('stopSending() [localId:%s]', localId);

    const transceiver = this._mapMidTransceiver.get(localId);

    if (!transceiver)
      throw new Error('associated RTCRtpTransceiver not found');

    void transceiver.sender.replaceTrack(null);
    this._pc!.removeTrack(transceiver.sender);

    const mediaSectionClosed = this._remoteSdp!.closeMediaSection(transceiver.mid!);

    if (mediaSectionClosed)
    {
      try
      {
        transceiver.stop();
      }
      catch (error) { /* ignore */ }
    }

    const offer = await this._pc!.createOffer();

    logger.debug('stopSending() | calling pc.setLocalDescription() [offer:%o]', offer);
    await this._pc!.setLocalDescription(offer);

    const answer = { type: 'answer' as const, sdp: this._remoteSdp!.getSdp() };

    logger.debug('stopSending() | calling pc.setRemoteDescription() [answer:%o]', answer);
    await this._pc!.setRemoteDescription(answer);

    this._mapMidTransceiver.delete(localId);
  }

  async pauseSending(localId: string): Promise<void>
  {
    this._assertNotClosed();
    this._assertSendDirection();

    logger.debug('pauseSending() [localId:%s]', localId);

    const transceiver = this._mapMidTransceiver.get(localId);

    if (!transceiver)
      throw new Error('associated RTCRtpTransceiver not found');

    transceiver.direction = 'inactive';
    this._remoteSdp!.pauseMediaSection(localId);

    const offer = await this._pc!.createOffer();

    logger.debug('pauseSending() | calling pc.setLocalDescription() [offer:%o]', offer);
    await this._pc!.setLocalDescription(offer);

    const answer = { type: 'answer' as const, sdp: this._remoteSdp!.getSdp() };

    logger.debug('pauseSending() | calling pc.setRemoteDescription() [answer:%o]', answer);
    await this._pc!.setRemoteDescription(answer);
  }

  async resumeSending(localId: string): Promise<void>
  {
    this._assertNotClosed();
    this._assertSendDirection();

    logger.debug('resumeSending() [localId:%s]', localId);

    const transceiver = this._mapMidTransceiver.get(localId);

    this._remoteSdp!.resumeSendingMediaSection(localId);

    if (!transceiver)
      throw new Error('associated RTCRtpTransceiver not found');

    transceiver.direction = 'sendonly';

    const offer = await this._pc!.createOffer();

    logger.debug('resumeSending() | calling pc.setLocalDescription() [offer:%o]', offer);
    await this._pc!.setLocalDescription(offer);

    const answer = { type: 'answer' as const, sdp: this._remoteSdp!.getSdp() };

    logger.debug('resumeSending() | calling pc.setRemoteDescription() [answer:%o]', answer);
    await this._pc!.setRemoteDescription(answer);
  }

  async replaceTrack(
    localId: string,
    track: MediaStreamTrack | null
  ): Promise<void>
  {
    this._assertNotClosed();
    this._assertSendDirection();

    if (track)
      logger.debug('replaceTrack() [localId:%s, track.id:%s]', localId, track.id);
    else
      logger.debug('replaceTrack() [localId:%s, no track]', localId);

    const transceiver = this._mapMidTransceiver.get(localId);

    if (!transceiver)
      throw new Error('associated RTCRtpTransceiver not found');

    await transceiver.sender.replaceTrack(track);
  }

  async setMaxSpatialLayer(localId: string, spatialLayer: number): Promise<void>
  {
    this._assertNotClosed();
    this._assertSendDirection();

    logger.debug(
      'setMaxSpatialLayer() [localId:%s, spatialLayer:%s]',
      localId,
      spatialLayer
    );

    const transceiver = this._mapMidTransceiver.get(localId);

    if (!transceiver)
      throw new Error('associated RTCRtpTransceiver not found');

    const parameters = transceiver.sender.getParameters();

    parameters.encodings.forEach((encoding, idx) =>
    {
      encoding.active = idx <= spatialLayer;
    });

    await transceiver.sender.setParameters(parameters);
    this._remoteSdp!.muxMediaSectionSimulcast(localId, parameters.encodings);

    const offer = await this._pc!.createOffer();

    logger.debug(
      'setMaxSpatialLayer() | calling pc.setLocalDescription() [offer:%o]',
      offer
    );
    await this._pc!.setLocalDescription(offer);

    const answer = { type: 'answer' as const, sdp: this._remoteSdp!.getSdp() };

    logger.debug(
      'setMaxSpatialLayer() | calling pc.setRemoteDescription() [answer:%o]',
      answer
    );
    await this._pc!.setRemoteDescription(answer);
  }

  async setRtpEncodingParameters(
    localId: string,
    params: Partial<RTCRtpEncodingParameters>
  ): Promise<void>
  {
    this._assertNotClosed();
    this._assertSendDirection();

    logger.debug(
      'setRtpEncodingParameters() [localId:%s, params:%o]',
      localId,
      params
    );

    const transceiver = this._mapMidTransceiver.get(localId);

    if (!transceiver)
      throw new Error('associated RTCRtpTransceiver not found');

    const parameters = transceiver.sender.getParameters();

    parameters.encodings.forEach((encoding, idx) =>
    {
      parameters.encodings[idx] = { ...encoding, ...params };
    });

    await transceiver.sender.setParameters(parameters);
    this._remoteSdp!.muxMediaSectionSimulcast(localId, parameters.encodings);

    const offer = await this._pc!.createOffer();

    logger.debug(
      'setRtpEncodingParameters() | calling pc.setLocalDescription() [offer:%o]',
      offer
    );
    await this._pc!.setLocalDescription(offer);

    const answer = { type: 'answer' as const, sdp: this._remoteSdp!.getSdp() };

    logger.debug(
      'setRtpEncodingParameters() | calling pc.setRemoteDescription() [answer:%o]',
      answer
    );
    await this._pc!.setRemoteDescription(answer);
  }

  async getSenderStats(localId: string): Promise<RTCStatsReport>
  {
    this._assertNotClosed();
    this._assertSendDirection();

    const transceiver = this._mapMidTransceiver.get(localId);

    if (!transceiver)
      throw new Error('associated RTCRtpTransceiver not found');

    return transceiver.sender.getStats();
  }

  async sendDataChannel({
    sctpStreamParameters,
  }: HandlerSendDataChannelOptions): Promise<HandlerSendDataChannelResult>
  {
    this._assertNotClosed();
    this._assertSendDirection();

    const options = {
      negotiated: true,
      id: this._nextSendSctpStreamId,
      ordered: sctpStreamParameters.ordered,
      maxPacketLifeTime: sctpStreamParameters.maxPacketLifeTime,
      maxRetransmits: sctpStreamParameters.maxRetransmits,
      protocol: sctpStreamParameters.protocol,
    };

    logger.debug('sendDataChannel() [options:%o]', options);

    const dataChannel = this._pc!.createDataChannel(
      sctpStreamParameters.label ?? '',
      options
    );

    this._nextSendSctpStreamId =
      ++this._nextSendSctpStreamId % SCTP_NUM_STREAMS.MIS;

    if (!this._hasDataChannelMediaSection)
    {
      const offer = await this._pc!.createOffer();
      const localSdpObject = sdpTransform.parse(offer.sdp!);
      const offerMediaObject = (localSdpObject as any).media.find(
        (m: any) => m.type === 'application'
      );

      if (!this._transportReady)
      {
        await this._setupTransport({
          localDtlsRole: this._forcedLocalDtlsRole ?? 'client',
          localSdpObject,
        });
      }

      logger.debug(
        'sendDataChannel() | calling pc.setLocalDescription() [offer:%o]',
        offer
      );
      await this._pc!.setLocalDescription(offer);

      this._remoteSdp!.sendSctpAssociation({ offerMediaObject });

      const answer = { type: 'answer' as const, sdp: this._remoteSdp!.getSdp() };

      logger.debug(
        'sendDataChannel() | calling pc.setRemoteDescription() [answer:%o]',
        answer
      );
      await this._pc!.setRemoteDescription(answer);

      this._hasDataChannelMediaSection = true;
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
    this._assertNotClosed();
    this._assertRecvDirection();

    const results: HandlerReceiveResult[] = [];
    const mapLocalId = new Map<string, string>();

    for (const options of optionsList)
    {
      const { trackId, kind, rtpParameters, streamId } = options;

      logger.debug('receive() [trackId:%s, kind:%s]', trackId, kind);

      const localId =
        rtpParameters.mid ?? String(this._mapMidTransceiver.size);

      mapLocalId.set(trackId, localId);

      const { msidStreamId } =
        ortcUtils.getMsidStreamIdAndTrackId(rtpParameters.msid);

      this._remoteSdp!.receive({
        mid: localId,
        kind,
        offerRtpParameters: rtpParameters,
        streamId: streamId ?? msidStreamId ?? rtpParameters.rtcp?.cname ?? '-',
        trackId,
      });
    }

    const offer = { type: 'offer' as const, sdp: this._remoteSdp!.getSdp() };

    logger.debug('receive() | calling pc.setRemoteDescription() [offer:%o]', offer);
    await this._pc!.setRemoteDescription(offer);

    for (const options of optionsList)
    {
      const { trackId, onRtpReceiver } = options;

      if (onRtpReceiver)
      {
        const localId = mapLocalId.get(trackId)!;
        const transceiver = this._pc!
          .getTransceivers()
          .find((t) => t.mid === localId);

        if (!transceiver)
          throw new Error('transceiver not found');

        onRtpReceiver(transceiver.receiver);
      }
    }

    let answer = await this._pc!.createAnswer();
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

    if (!this._transportReady)
    {
      await this._setupTransport({
        localDtlsRole: this._forcedLocalDtlsRole ?? 'client',
        localSdpObject,
      });
    }

    logger.debug('receive() | calling pc.setLocalDescription() [answer:%o]', answer);
    await this._pc!.setLocalDescription(answer);

    for (const options of optionsList)
    {
      const { trackId } = options;
      const localId = mapLocalId.get(trackId)!;
      const transceiver = this._pc!
        .getTransceivers()
        .find((t) => t.mid === localId);

      if (!transceiver)
        throw new Error('new RTCRtpTransceiver not found');

      this._mapMidTransceiver.set(localId, transceiver);
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
    this._assertRecvDirection();

    if (this._closed)
      return;

    for (const localId of localIds)
    {
      logger.debug('stopReceiving() [localId:%s]', localId);

      const transceiver = this._mapMidTransceiver.get(localId);

      if (!transceiver)
        throw new Error('associated RTCRtpTransceiver not found');

      this._remoteSdp!.closeMediaSection(transceiver.mid!);
    }

    const offer = { type: 'offer' as const, sdp: this._remoteSdp!.getSdp() };

    logger.debug(
      'stopReceiving() | calling pc.setRemoteDescription() [offer:%o]',
      offer
    );
    await this._pc!.setRemoteDescription(offer);

    const answer = await this._pc!.createAnswer();

    logger.debug(
      'stopReceiving() | calling pc.setLocalDescription() [answer:%o]',
      answer
    );
    await this._pc!.setLocalDescription(answer);

    for (const localId of localIds)
      this._mapMidTransceiver.delete(localId);
  }

  async pauseReceiving(localIds: string[]): Promise<void>
  {
    this._assertNotClosed();
    this._assertRecvDirection();

    for (const localId of localIds)
    {
      logger.debug('pauseReceiving() [localId:%s]', localId);

      const transceiver = this._mapMidTransceiver.get(localId);

      if (!transceiver)
        throw new Error('associated RTCRtpTransceiver not found');

      transceiver.direction = 'inactive';
      this._remoteSdp!.pauseMediaSection(localId);
    }

    const offer = { type: 'offer' as const, sdp: this._remoteSdp!.getSdp() };

    logger.debug(
      'pauseReceiving() | calling pc.setRemoteDescription() [offer:%o]',
      offer
    );
    await this._pc!.setRemoteDescription(offer);

    const answer = await this._pc!.createAnswer();

    logger.debug(
      'pauseReceiving() | calling pc.setLocalDescription() [answer:%o]',
      answer
    );
    await this._pc!.setLocalDescription(answer);
  }

  async resumeReceiving(localIds: string[]): Promise<void>
  {
    this._assertNotClosed();
    this._assertRecvDirection();

    for (const localId of localIds)
    {
      logger.debug('resumeReceiving() [localId:%s]', localId);

      const transceiver = this._mapMidTransceiver.get(localId);

      if (!transceiver)
        throw new Error('associated RTCRtpTransceiver not found');

      transceiver.direction = 'recvonly';
      this._remoteSdp!.resumeReceivingMediaSection(localId);
    }

    const offer = { type: 'offer' as const, sdp: this._remoteSdp!.getSdp() };

    logger.debug(
      'resumeReceiving() | calling pc.setRemoteDescription() [offer:%o]',
      offer
    );
    await this._pc!.setRemoteDescription(offer);

    const answer = await this._pc!.createAnswer();

    logger.debug(
      'resumeReceiving() | calling pc.setLocalDescription() [answer:%o]',
      answer
    );
    await this._pc!.setLocalDescription(answer);
  }

  async getReceiverStats(localId: string): Promise<RTCStatsReport>
  {
    this._assertNotClosed();
    this._assertRecvDirection();

    const transceiver = this._mapMidTransceiver.get(localId);

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
    this._assertNotClosed();
    this._assertRecvDirection();

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

    logger.debug('receiveDataChannel() [options:%o]', options);

    const dataChannel = this._pc!.createDataChannel(label ?? '', options);

    if (!this._hasDataChannelMediaSection)
    {
      this._remoteSdp!.receiveSctpAssociation();

      const offer = { type: 'offer' as const, sdp: this._remoteSdp!.getSdp() };

      logger.debug(
        'receiveDataChannel() | calling pc.setRemoteDescription() [offer:%o]',
        offer
      );
      await this._pc!.setRemoteDescription(offer);

      let answer = await this._pc!.createAnswer();
      const localSdpObject = sdpTransform.parse(answer.sdp!);
      const answerMediaObject = (localSdpObject as any).media.find(
        (m: any) => m.type === 'application'
      );

      answerMediaObject.maxMessageSize = maxMessageSize;

      if (!this._transportReady)
      {
        await this._setupTransport({
          localDtlsRole: this._forcedLocalDtlsRole ?? 'client',
          localSdpObject,
        });
      }

      answer = { type: 'answer', sdp: sdpTransform.write(localSdpObject) };

      logger.debug(
        'receiveDataChannel() | calling pc.setLocalDescription() [answer:%o]',
        answer
      );
      await this._pc!.setLocalDescription(answer);

      this._hasDataChannelMediaSection = true;
    }

    return { dataChannel };
  }

  getDataChannelMaxMessageSize(): number | undefined
  {
    return this._pc!.sctp?.maxMessageSize;
  }

  private async _setupTransport({
    localDtlsRole,
    localSdpObject,
  }: {
    localDtlsRole: DtlsRole;
    localSdpObject?: SdpTransform.SessionDescription;
  }): Promise<void>
  {
    if (!localSdpObject)
      localSdpObject = sdpTransform.parse(this._pc!.localDescription!.sdp);

    const dtlsParameters = sdpCommonUtils.extractDtlsParameters({
      sdpObject: localSdpObject,
    });

    dtlsParameters.role = localDtlsRole;
    this._remoteSdp!.updateDtlsRole(
      (localDtlsRole === 'client' ? 'server' : 'client') as DtlsRole
    );

    await new Promise<void>((resolve, reject) =>
    {
      this.safeEmit('@connect', { dtlsParameters }, resolve, reject);
    });

    this._transportReady = true;
  }

  private readonly _onIceGatheringStateChange = (): void =>
  {
    this.emit('@icegatheringstatechange', this._pc!.iceGatheringState);
  };

  private readonly _onIceCandidateError = (event: Event): void =>
  {
    this.emit('@icecandidateerror', event as RTCPeerConnectionIceErrorEvent);
  };

  private readonly _onConnectionStateChange = (): void =>
  {
    this.emit('@connectionstatechange', this._pc!.connectionState);
  };

  private readonly _onIceConnectionStateChange = (): void =>
  {
    switch (this._pc!.iceConnectionState)
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

  private _assertNotClosed(): void
  {
    if (this._closed)
      throw new InvalidStateError('method called in a closed handler');
  }

  private _assertSendDirection(): void
  {
    if (this._direction !== 'send')
      throw new Error(
        'method can just be called for handlers with "send" direction'
      );
  }

  private _assertRecvDirection(): void
  {
    if (this._direction !== 'recv')
      throw new Error(
        'method can just be called for handlers with "recv" direction'
      );
  }
}


export function createHandlerFactory(wrtc: WrtcLike): HandlerFactory
{
  function factory(options: HandlerOptions): HandlerInterface
  {
    return new WrtcHandler(wrtc, options);
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

export default createHandlerFactory;
