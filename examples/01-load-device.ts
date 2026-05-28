#!/usr/bin/env node

/**
 * 01-load-device.ts
 *
 * Minimal mediasoup-client bootstrap example for Node.js using an injected
 * WebRTC runtime implementation.
 *
 * What this demonstrates:
 *   - How to build a mediasoup-client handler factory backed by wrtc.
 *   - How to probe native RTP capabilities from the local WebRTC stack.
 *   - How to load a Device with router RTP capabilities.
 *   - How to verify whether the loaded Device can produce audio/video.
 *
 * This example does not create transports or media tracks. Its only goal is
 * validating capability negotiation and initial client bootstrap.
 */

import type { types as mediasoupTypes } from 'mediasoup-client';

import {
  createLoggerSink,
  createWrtcDevice,
  loadWrtcRuntimeModule,
  runMainTask,
} from 'mediasoup-client-wrtc/testing';

const injectedWrtcRuntime = loadWrtcRuntimeModule('@roamhq/wrtc');

const routerRtpCapabilities: mediasoupTypes.RtpCapabilities = {
  codecs: [
    {
      kind: 'audio' as const,
      mimeType: 'audio/opus',
      preferredPayloadType: 111,
      clockRate: 48000,
      channels: 2,
      parameters: {
        useinbandfec: 1,
      },
      rtcpFeedback: [
        { type: 'transport-cc' },
      ],
    },
    {
      kind: 'video' as const,
      mimeType: 'video/VP8',
      preferredPayloadType: 96,
      clockRate: 90000,
      parameters: {},
      rtcpFeedback: [
        { type: 'nack' },
        { type: 'nack', parameter: 'pli' },
        { type: 'ccm', parameter: 'fir' },
        { type: 'goog-remb' },
        { type: 'transport-cc' },
      ],
    },
  ],
  headerExtensions: [
    {
      kind: 'audio' as const,
      uri: 'urn:ietf:params:rtp-hdrext:sdes:mid',
      preferredId: 1,
      preferredEncrypt: false,
      direction: 'sendrecv' as const,
    },
    {
      kind: 'video' as const,
      uri: 'urn:ietf:params:rtp-hdrext:sdes:mid',
      preferredId: 1,
      preferredEncrypt: false,
      direction: 'sendrecv' as const,
    },
    {
      kind: 'video' as const,
      uri: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time',
      preferredId: 7,
      preferredEncrypt: false,
      direction: 'sendrecv' as const,
    },
  ],
};

async function main() {
  console.log('[demo] Starting load-device example...');

  const loggerSink = createLoggerSink();

  const {
    device,
    nativeRtpCapabilities,
  } = await createWrtcDevice({
    routerRtpCapabilities,
    wrtcRuntime: injectedWrtcRuntime,
    loggerSink,
    probeDirection: 'sendonly',
  });

  console.log(
    `Native codecs detected:`, nativeRtpCapabilities.codecs?.length ?? 0
  );

  console.log('Device loaded successfully');
  console.log(`Can produce audio: ${device.canProduce('audio')}`);
  console.log(`Can produce video: ${device.canProduce('video')}`);
}

await runMainTask(main, { errorPrefix: 'Error:' });
