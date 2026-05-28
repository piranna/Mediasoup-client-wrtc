#!/usr/bin/env node

/**
 * 01-load-device.ts
 *
 * Minimal mediasoup-client bootstrap example for Node.js using @roamhq/wrtc.
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

import { createRequire } from 'node:module';

import { Device, types as mediasoupTypes } from 'mediasoup-client';
import WrtcHandler from 'mediasoup-client-wrtc';

// @roamhq/wrtc is a CJS module; use createRequire so its constructors are
// accessible as named properties in an ESM project.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const wrtc = require('@roamhq/wrtc') as typeof import('@roamhq/wrtc');

// ---------------------------------------------------------------------------
// Router RTP capabilities fixture
//
// In production these are provided by the mediasoup router. We keep this
// object static in the example so Device.load() can run deterministically.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('[demo] Starting load-device example...');

  // Step 1: Create a handler factory
  //
  // The handler factory is the adapter used by mediasoup-client to interact
  // with the WebRTC runtime. Here we inject wrtc plus a logger sink so the
  // internals can be inspected from the console.
  const handlerFactory = WrtcHandler.createFactory(wrtc, {
    info: (...args) => console.info('[wrtc-handler]', ...args),
    warn: (...args) => console.warn('[wrtc-handler]', ...args),
    error: (...args) => console.error('[wrtc-handler]', ...args),
  });

  // Step 2: Probe native RTP capabilities
  //
  // This reports what the local WebRTC engine can encode/decode natively. We
  // request send-side probing because this example focuses on producer
  // readiness after loading the Device.
  const nativeRtpCapabilities = await handlerFactory.getNativeRtpCapabilities({
    direction: 'sendonly',
  });

  console.log(
    `Native codecs detected:`, nativeRtpCapabilities.codecs?.length ?? 0
  );

  // Step 3: Create a mediasoup-client Device
  //
  // The Device is the high-level endpoint abstraction. It keeps the effective
  // RTP capabilities computed from router capabilities + local native support.
  const device = new Device({ handlerFactory });

  // Step 4: Load the Device with router RTP capabilities
  //
  // Device.load() performs capability negotiation and prepares the instance for
  // creating send/recv transports later.
  console.log('Loading device...');
  await device.load({routerRtpCapabilities});

  // Step 5: Report production capability checks
  //
  // canProduce(kind) is the simplest readiness signal after load().
  console.log('Device loaded successfully');
  console.log(`Can produce audio: ${device.canProduce('audio')}`);
  console.log(`Can produce video: ${device.canProduce('video')}`);
}

// Keep top-level execution explicit so the script remains easy to run from CI
// while still producing a non-zero exit code if bootstrap fails.
try {
  await main();
}
catch (error)
{
  console.error('Error:', error);
  process.exitCode = 1;
}
