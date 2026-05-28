#!/usr/bin/env node

/**
 * 03-produce-consume-audio-real-mediasoup.ts
 *
 * Real end-to-end audio PoC running in a single Node.js process:
 *   - mediasoup server side (Worker + Router + WebRtcTransports)
 *   - mediasoup-client side (two Device instances using mediasoup-client-wrtc)
 *   - synthetic audio source (RTCAudioSource) and sink verification
 *
 * Unlike the mock example, this file wires a real mediasoup instance so media
 * packets can flow between producer and consumer.
 */

import * as mediasoup from 'mediasoup';

import {
	attachTransportConnectHandler,
	cleanupMediaActions,
	createAudioSink,
	createLoggerSink,
	createLocalMediasoupServer,
	createSyntheticAudioTrack,
	createWrtcDevicePair,
	loadWrtcRuntimeModule,
	runMainTask,
} from 'mediasoup-client-wrtc/testing';

const injectedWrtcRuntime = loadWrtcRuntimeModule('@roamhq/wrtc');

const loggerSink = createLoggerSink();

const mediaCodecs = [
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
const OPUS_AUDIO_CODEC_OPTIONS = {
	opusStereo: false,
	opusDtx: true,
} as const;

async function main() {
	console.log('[demo] Starting real mediasoup produce-consume audio PoC...');
	const wrtcRuntime = injectedWrtcRuntime;

	const {
		worker,
		router,
		sendTransport: serverSendTransport,
		recvTransport: serverRecvTransport,
	} = await createLocalMediasoupServer(mediasoup, {
		mediaCodecs,
		rtcMinPort: 40000,
		rtcMaxPort: 40100,
		listenIp: '127.0.0.1',
	});
	console.log('[server] mediasoup Worker and Router created');
	console.log('[server] send/recv WebRtcTransports created');

	const { senderDevice, receiverDevice } = await createWrtcDevicePair({
		routerRtpCapabilities: router.rtpCapabilities,
		wrtcRuntime,
		loggerSink,
	});

	console.log(
		'[client] sender/receiver Devices loaded:',
		senderDevice.canProduce('audio'),
		receiverDevice.recvRtpCapabilities.codecs?.length ?? 0,
	);

	let serverProducer: Awaited<ReturnType<typeof serverSendTransport.produce>> | undefined;

	const clientSendTransport = attachTransportConnectHandler(
		senderDevice
		.createSendTransport({
			id: serverSendTransport.id,
			iceParameters: serverSendTransport.iceParameters,
			iceCandidates: serverSendTransport.iceCandidates,
			dtlsParameters: serverSendTransport.dtlsParameters,
		})
		.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
			try {
				serverProducer = await serverSendTransport.produce({
					kind,
					rtpParameters,
				});

				console.log('[server] producer created:', serverProducer.id);
				callback({ id: serverProducer.id });
			}
			catch (error) {
				errback(error as Error);
			}
		}),
		async (dtlsParameters) => {
			await serverSendTransport.connect({ dtlsParameters });
		},
	);

	const clientRecvTransport = attachTransportConnectHandler(
		receiverDevice
		.createRecvTransport({
			id: serverRecvTransport.id,
			iceParameters: serverRecvTransport.iceParameters,
			iceCandidates: serverRecvTransport.iceCandidates,
			dtlsParameters: serverRecvTransport.dtlsParameters,
		}),
		async (dtlsParameters) => {
			await serverRecvTransport.connect({ dtlsParameters });
		},
	);

	const syntheticAudio = createSyntheticAudioTrack(wrtcRuntime);

	const clientProducer = await clientSendTransport.produce({
		track: syntheticAudio.track,
		codecOptions: OPUS_AUDIO_CODEC_OPTIONS,
	});

	console.log('[client] producer created:', clientProducer.id);

	if (serverProducer === undefined) {
		throw new Error('Server producer was not created via produce signaling');
	}

	const options = {
		producerId: serverProducer.id,
		rtpCapabilities: receiverDevice.recvRtpCapabilities,
		paused: true,
	};

	if (!router.canConsume(options)) {
		throw new Error('Router cannot consume with receiver device RTP capabilities');
	}

	const serverConsumer = await serverRecvTransport.consume(options);

	console.log('[server] consumer created:', serverConsumer.id);

	const clientConsumer = await clientRecvTransport.consume({
		id: serverConsumer.id,
		producerId: serverProducer.id,
		kind: serverConsumer.kind,
		rtpParameters: serverConsumer.rtpParameters,
	});

	await serverConsumer.resume();

	console.log('[client] consumer created:', clientConsumer.id);

	const audioSink = createAudioSink(wrtcRuntime, clientConsumer.track);

	console.log('[client] waiting up to 1500 ms for real audio frames...');

	await audioSink.wait(1500);

	const framesReceived = audioSink.getFramesReceived();

	console.log('[client] frames received:', framesReceived);

	if (framesReceived === 0) {
		throw new Error('No audio frames received from real mediasoup pipeline');
	}

	await cleanupMediaActions({
		stopFirst: [
			audioSink,
			{ stop: () => clientConsumer.track.stop() },
			syntheticAudio,
		],
		closeNext: [
			clientConsumer,
			{ close: () => serverConsumer.close() },
			clientProducer,
			{ close: () => serverProducer.close() },
			clientSendTransport,
			clientRecvTransport,
			{ close: () => serverSendTransport.close() },
			{ close: () => serverRecvTransport.close() },
			{ close: () => worker.close() },
		],
	});

	console.log('[done] Real mediasoup audio pipeline succeeded.');
}

await runMainTask(main, { forceExitOnCompletion: true });
