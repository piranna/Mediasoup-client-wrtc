#!/usr/bin/env node

import { Device } from 'mediasoup-client';
import { RTCPeerConnection } from '@roamhq/wrtc';

import createHandlerFactory from '.';



async function main() {
  const handlerFactory = createHandlerFactory()

  const device = new Device({ handlerFactory });

  console.log('Loading device...');
  await device.load({
    routerRtpCapabilities: {
      codecs: [
        {
          kind: 'audio',
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
        },
        {
          kind: 'video',
          mimeType: 'video/VP8',
          clockRate: 90000,
        },
      ],
    },
  });

  console.log('Device loaded successfully');
}

main().catch((error) => {
  console.error('Error:', error);
});
