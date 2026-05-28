import * as mediasoup from 'mediasoup';


const DEFAULT_AUDIO_MEDIA_CODECS = [
  {
    kind: 'audio' as const,
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    parameters: {
      useinbandfec: 1,
    },
    rtcpFeedback: [{ type: 'transport-cc' }],
  },
];


type CreateLocalMediasoupServerOptions = {
  mediaCodecs?: typeof DEFAULT_AUDIO_MEDIA_CODECS;
  rtcMinPort?: number;
  rtcMaxPort?: number;
  listenIp?: string;
};


export async function createLocalMediasoupServer(
  {
    mediaCodecs = DEFAULT_AUDIO_MEDIA_CODECS,
    rtcMinPort = 40000,
    rtcMaxPort = 40100,
    listenIp = '127.0.0.1',
  }: CreateLocalMediasoupServerOptions = {},
)
{
  const worker = await mediasoup.createWorker({
    logLevel: 'warn',
    rtcMinPort,
    rtcMaxPort,
  });

  const router = await worker.createRouter({ mediaCodecs });

  const transportOptions = {
    listenInfos: [
      { protocol: 'udp' as const, ip: listenIp, announcedAddress: listenIp },
      { protocol: 'tcp' as const, ip: listenIp, announcedAddress: listenIp },
    ],
    preferUdp: true,
  };

  const sendTransport = await router.createWebRtcTransport(transportOptions);
  const recvTransport = await router.createWebRtcTransport(transportOptions);

  return {
    worker,
    router,
    sendTransport,
    recvTransport,
  };
}
