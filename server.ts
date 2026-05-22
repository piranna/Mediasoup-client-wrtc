#!/usr/bin/env node

import { Device } from 'mediasoup-client';
import * as wrtc from '@roamhq/wrtc';

import { WrtcHandler } from '.';


const routerRtpCapabilities = {
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
  const handlerFactory = WrtcHandler.createFactory(wrtc, {
    info: (...args) => console.info('[wrtc-handler]', ...args),
    warn: (...args) => console.warn('[wrtc-handler]', ...args),
    error: (...args) => console.error('[wrtc-handler]', ...args),
  });

  const nativeRtpCapabilities = await handlerFactory.getNativeRtpCapabilities({
    direction: 'send',
  });

  console.log(
    `Native codecs detected: ${nativeRtpCapabilities.codecs.length}`
  );

  const device = new Device({ handlerFactory });

  console.log('Loading device...');
  await device.load({
    routerRtpCapabilities,
  });

  console.log('Device loaded successfully');
  console.log(`Can produce audio: ${device.canProduce('audio')}`);
  console.log(`Can produce video: ${device.canProduce('video')}`);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exitCode = 1;
});
