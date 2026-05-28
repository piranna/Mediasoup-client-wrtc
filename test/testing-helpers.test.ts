import assert from 'node:assert/strict';
import test from 'node:test';

import * as mediasoup from 'mediasoup';

import {
  createAudioSink,
  createLocalMediasoupServer,
  createLoggerSink,
  createSyntheticAudioTrack,
  createWrtcDevice,
  createWrtcHandlerFactory,
  type WrtcRuntimeWithNonstandard,
} from '../src/testing/index.ts';
import { createMockWrtcRuntime } from './fixtures/mockWrtcRuntime.ts';
import {
  AUDIO_VIDEO_ROUTER_RTP_CAPABILITIES,
} from './fixtures/rtpCapabilities.ts';

const injectedWrtcRuntime = {
	...createMockWrtcRuntime(),
} as unknown as WrtcRuntimeWithNonstandard;


test('createLoggerSink supports default and custom prefixes', () => {
  const infoCalls: unknown[][] = [];
  const warnCalls: unknown[][] = [];
  const errorCalls: unknown[][] = [];

  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;

  console.info = (...args: unknown[]) => {
    infoCalls.push(args);
  };
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };
  console.error = (...args: unknown[]) => {
    errorCalls.push(args);
  };

  try {
    const defaultSink = createLoggerSink();
    defaultSink.info('a');
    defaultSink.warn('b');
    defaultSink.error('c');

    const customSink = createLoggerSink('[custom]');
    customSink.info('x');

    assert.deepEqual(infoCalls[0], ['[wrtc-handler]', 'a']);
    assert.deepEqual(warnCalls[0], ['[wrtc-handler]', 'b']);
    assert.deepEqual(errorCalls[0], ['[wrtc-handler]', 'c']);
    assert.deepEqual(infoCalls[1], ['[custom]', 'x']);
  }
  finally {
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
  }
});


test('createWrtcHandlerFactory and createWrtcDevice work with and without probeDirection', async () => {
  assert.ok(injectedWrtcRuntime.RTCPeerConnection);

  const handlerFactory = createWrtcHandlerFactory(injectedWrtcRuntime);
  const sctpCapabilities = await handlerFactory.getNativeSctpCapabilities();
  assert.deepEqual(sctpCapabilities, { numStreams: { OS: 65535, MIS: 65535 } });

  const withProbe = await createWrtcDevice({
    routerRtpCapabilities: AUDIO_VIDEO_ROUTER_RTP_CAPABILITIES,
    handlerFactory,
    probeDirection: 'sendonly',
  });

  assert.equal(withProbe.handlerFactory, handlerFactory);
  assert.ok(withProbe.nativeRtpCapabilities);

  const withoutProbe = await createWrtcDevice({
    routerRtpCapabilities: AUDIO_VIDEO_ROUTER_RTP_CAPABILITIES,
    handlerFactory,
  });

  assert.equal(withoutProbe.handlerFactory, handlerFactory);
  assert.equal(withoutProbe.nativeRtpCapabilities, undefined);

  const autoFactory = await createWrtcDevice({
    routerRtpCapabilities: AUDIO_VIDEO_ROUTER_RTP_CAPABILITIES,
    wrtcRuntime: injectedWrtcRuntime,
    loggerSink: createLoggerSink('[auto-factory]'),
  });

  assert.equal(typeof autoFactory.handlerFactory.factory, 'function');
  assert.equal(autoFactory.nativeRtpCapabilities, undefined);
});


test('createWrtcDevice throws if neither handlerFactory nor wrtcRuntime are provided', async () => {
  await assert.rejects(
    createWrtcDevice({ routerRtpCapabilities: AUDIO_VIDEO_ROUTER_RTP_CAPABILITIES }),
    /Either handlerFactory or wrtcRuntime must be provided/,
  );
});


test('createSyntheticAudioTrack generates frames and stop() halts the track', async () => {
  class FakeRTCAudioSource {
    readonly calls: Array<Record<string, unknown>> = [];

    private readonly track = {
      stopped: false,
      stop(): void {
        this.stopped = true;
      },
    };

    createTrack() {
      return this.track;
    }

    onData(data: Record<string, unknown>): void {
      this.calls.push(data);
    }
  }

  const fakeWrtc = {
    nonstandard: {
      RTCAudioSource: FakeRTCAudioSource,
    },
  } as unknown as WrtcRuntimeWithNonstandard;

  const syntheticAudio = createSyntheticAudioTrack(fakeWrtc, {
    sampleRate: 48000,
    channelCount: 1,
    intervalMs: 5,
  });

  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  assert.equal(syntheticAudio.sampleRate, 48000);
  assert.equal(syntheticAudio.channelCount, 1);
  assert.equal(syntheticAudio.numberOfFrames, 480);
  assert.equal(syntheticAudio.samples.length, 480);
  assert.ok((syntheticAudio.audioSource as unknown as FakeRTCAudioSource).calls.length > 0);

  syntheticAudio.stop();
  assert.equal((syntheticAudio.track as { stopped: boolean }).stopped, true);
});


test('createAudioSink tracks frames, waits, and stops', async () => {
  class FakeRTCAudioSink {
    ondata: (() => void) | undefined;
    stopped = false;

    constructor(_track: MediaStreamTrack) {}

    stop(): void {
      this.stopped = true;
    }
  }

  const fakeWrtc = {
    nonstandard: {
      RTCAudioSink: FakeRTCAudioSink,
    },
  } as unknown as WrtcRuntimeWithNonstandard;

  const sinkApi = createAudioSink(fakeWrtc, {} as MediaStreamTrack);

  assert.equal(sinkApi.getFramesReceived(), 0);

  await sinkApi.wait(5, 1);
  assert.equal(sinkApi.getFramesReceived(), 0);

  setTimeout(() => {
    sinkApi.sink.ondata?.();
  }, 1);

  await sinkApi.wait(25, 1);
  assert.equal(sinkApi.getFramesReceived(), 1);

  sinkApi.stop();
  assert.equal((sinkApi.sink as FakeRTCAudioSink).stopped, true);
  assert.equal(sinkApi.sink.ondata, undefined);
});


test('createLocalMediasoupServer boots worker/router/transports with defaults', async () => {
  const server = await createLocalMediasoupServer(mediasoup);

  try {
    assert.ok(server.worker.pid > 0);
    assert.ok(server.router.id);
    assert.ok(server.sendTransport.id);
    assert.ok(server.recvTransport.id);
  }
  finally {
    server.sendTransport.close();
    server.recvTransport.close();
    server.worker.close();
  }
});

test('createLocalMediasoupServer accepts custom options', async () => {
  const server = await createLocalMediasoupServer(mediasoup, {
    rtcMinPort: 41000,
    rtcMaxPort: 41100,
    listenIp: '127.0.0.1',
  });

  try {
    assert.ok(server.sendTransport.iceCandidates.length > 0);
    assert.ok(server.recvTransport.iceCandidates.length > 0);
  }
  finally {
    server.sendTransport.close();
    server.recvTransport.close();
    server.worker.close();
  }
});
