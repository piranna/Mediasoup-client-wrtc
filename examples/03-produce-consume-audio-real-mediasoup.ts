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

import {
	createAudioSink,
	createLocalMediasoupServer,
	createLoggerSink,
	createSyntheticAudioTrack,
	createWrtcDevice,
	createWrtcHandlerFactory,
	getWrtcRuntime,
} from 'mediasoup-client-wrtc/testing';

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

const loggerSink = createLoggerSink();

// ---------------------------------------------------------------------------
// mediasoup Router media codecs (audio-only for this PoC)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	console.log('[demo] Starting real mediasoup produce-consume audio PoC...');
	const wrtc = getWrtcRuntime();

	// Step 1: Boot mediasoup server primitives (Worker + Router).
	const {
		worker,
		router,
		sendTransport: serverSendTransport,
		recvTransport: serverRecvTransport,
	} = await createLocalMediasoupServer({
		mediaCodecs,
		rtcMinPort: 40000,
		rtcMaxPort: 40100,
		listenIp: '127.0.0.1',
	});
	console.log('[server] mediasoup Worker and Router created');

	console.log('[server] send/recv WebRtcTransports created');

	// Step 3: Build mediasoup-client Devices using mediasoup-client-wrtc.
	const handlerFactory = createWrtcHandlerFactory({ loggerSink });

	const { device: senderDevice } = await createWrtcDevice({
		routerRtpCapabilities: router.rtpCapabilities,
		handlerFactory,
	});

	const { device: receiverDevice } = await createWrtcDevice({
		routerRtpCapabilities: router.rtpCapabilities,
		handlerFactory,
	});

	console.log(
		'[client] sender/receiver Devices loaded:',
		senderDevice.canProduce('audio'),
		receiverDevice.recvRtpCapabilities.codecs?.length ?? 0,
	);

	// Step 4: Create client-side send transport and wire signaling to mediasoup.
	let serverProducer: Awaited<ReturnType<typeof serverSendTransport.produce>> | undefined;

	const clientSendTransport = senderDevice
		.createSendTransport({
			id: serverSendTransport.id,
			iceParameters: serverSendTransport.iceParameters,
			iceCandidates: serverSendTransport.iceCandidates,
			dtlsParameters: serverSendTransport.dtlsParameters,
		})
		.on('connect', async ({ dtlsParameters }, callback, errback) => {
			try {
				await serverSendTransport.connect({ dtlsParameters });
				callback();
			}
			catch (error) {
				errback(error as Error);
			}
		})
		.on('connectionstatechange', (state) => {
			console.log('[client-send-transport] connectionstatechange ->', state);
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
		});

	// Step 5: Create client-side recv transport and wire signaling to mediasoup.
	const clientRecvTransport = receiverDevice
		.createRecvTransport({
			id: serverRecvTransport.id,
			iceParameters: serverRecvTransport.iceParameters,
			iceCandidates: serverRecvTransport.iceCandidates,
			dtlsParameters: serverRecvTransport.dtlsParameters,
		})
		.on('connect', async ({ dtlsParameters }, callback, errback) => {
			try {
				await serverRecvTransport.connect({ dtlsParameters });
				callback();
			}
			catch (error) {
				errback(error as Error);
			}
		})
		.on('connectionstatechange', (state) => {
			console.log('[client-recv-transport] connectionstatechange ->', state);
		});

	// Step 6: Generate synthetic audio and start producing from sender (silence).
	const syntheticAudio = createSyntheticAudioTrack(wrtc);

	const clientProducer = await clientSendTransport.produce({
		track: syntheticAudio.track,
		codecOptions: {
			opusStereo: false,
			opusDtx: true,
		},
	});

	console.log('[client] producer created:', clientProducer.id);

	if (serverProducer === undefined) {
		throw new Error('Server producer was not created via produce signaling');
	}

	// Step 7: Server consumes producer into recv transport (paused first).
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

	// Step 8: Create client consumer from server parameters and resume media.
	const clientConsumer = await clientRecvTransport.consume({
		id: serverConsumer.id,
		producerId: serverProducer.id,
		kind: serverConsumer.kind,
		rtpParameters: serverConsumer.rtpParameters,
	});

	await serverConsumer.resume();

	console.log('[client] consumer created:', clientConsumer.id);

	// Step 9: Verify real media flow using RTCAudioSink frame callbacks.
	const audioSink = createAudioSink(wrtc, clientConsumer.track);

	console.log('[client] waiting up to 1500 ms for real audio frames...');

	await audioSink.wait(1500);

	const framesReceived = audioSink.getFramesReceived();

	console.log('[client] frames received:', framesReceived);

	if (framesReceived === 0) {
		throw new Error('No audio frames received from real mediasoup pipeline');
	}

	// Step 10: Cleanup in reverse order.
	audioSink.stop();

	clientConsumer.track.stop();
	syntheticAudio.stop();

	clientConsumer.close();
	await serverConsumer.close();

	clientProducer.close();
	await serverProducer.close();

	clientSendTransport.close();
	clientRecvTransport.close();

	await serverSendTransport.close();
	await serverRecvTransport.close();

	await worker.close();

	console.log('[done] Real mediasoup audio pipeline succeeded.');

	// Keep deterministic termination in CI where native finalizers may be noisy.
	process.exit(0);
}

try {
	await main();
}
catch (error) {
	console.error('Fatal error:', error);
	process.exitCode = 1;
}
