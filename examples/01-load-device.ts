#!/usr/bin/env node

import { createRequire } from 'node:module';

import { Device, types as mediasoupTypes } from 'mediasoup-client';
import WrtcHandler from 'mediasoup-client-wrtc';

// @roamhq/wrtc is a CJS module; use createRequire so its constructors are
// accessible as named properties in an ESM project.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const wrtc = require('@roamhq/wrtc') as typeof import('@roamhq/wrtc');


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

  const handlerFactory = WrtcHandler.createFactory(wrtc, {
    info: (...args) => console.info('[wrtc-handler]', ...args),
    warn: (...args) => console.warn('[wrtc-handler]', ...args),
    error: (...args) => console.error('[wrtc-handler]', ...args),
  });

  const nativeRtpCapabilities = await handlerFactory.getNativeRtpCapabilities({
    direction: 'sendonly',
  });

  console.log(
    `Native codecs detected:`, nativeRtpCapabilities.codecs?.length ?? 0
  );

  const device = new Device({ handlerFactory });

  console.log('Loading device...');
  await device.load({routerRtpCapabilities});

  console.log('Device loaded successfully');
  console.log(`Can produce audio: ${device.canProduce('audio')}`);
  console.log(`Can produce video: ${device.canProduce('video')}`);
}

try {
  await main();
}
catch (error)
{
  console.error('Error:', error);
  process.exitCode = 1;
}
