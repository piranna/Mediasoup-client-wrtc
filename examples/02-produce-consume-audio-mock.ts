#!/usr/bin/env node

/**
 * produce-consume-audio.ts
 *
 * Minimal mediasoup-client Producer → Consumer audio PoC running entirely in
 * Node.js with an injected WebRTC runtime implementation.
 *
 * What this demonstrates:
 *   - Two Device instances (sender + receiver) loaded in the same process.
 *   - Synthetic audio generation via RTCAudioSource (no microphone needed).
 *   - Full send/recv Transport lifecycle with inline mock signaling callbacks.
 *   - Producer creation followed by Consumer setup.
 *   - RTCAudioSink wiring to verify the consumer track is live.
 *
 * Limitation — actual media packet delivery:
 *   Without a real mediasoup server the ICE/DTLS/SRTP handshake cannot
 *   complete, so audio frames do not travel end-to-end. The entire
 *   client-side API lifecycle (Device, Transport, Producer, Consumer) completes
 *   successfully; only the media plane requires real connectivity. Add a
 *   mediasoup server + real ICE candidates for a fully wired-up demo.
 */

import type { types as mediasoupTypes } from 'mediasoup-client';

import {
	attachTransportConnectHandler,
	cleanupMediaActions,
	createAudioSink,
	createLoggerSink,
	createSyntheticAudioTrack,
	createWrtcDevicePair,
	delay,
	loadWrtcRuntimeModule,
	runMainTask,
} from 'mediasoup-client-wrtc/testing';

const injectedWrtcRuntime = loadWrtcRuntimeModule('@roamhq/wrtc');

const loggerSink = createLoggerSink();

const routerRtpCapabilities: mediasoupTypes.RtpCapabilities = {
	codecs: [
		{
			kind: 'audio' as const,
			mimeType: 'audio/opus',
			preferredPayloadType: 111,
			clockRate: 48000,
			channels: 2,
			parameters: { useinbandfec: 1 },
			rtcpFeedback: [{ type: 'transport-cc' }],
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
			kind: 'audio' as const,
			uri: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time',
			preferredId: 7,
			preferredEncrypt: false,
			direction: 'sendrecv' as const,
		},
	],
};

const FAKE_ICE_PARAMETERS = {
	usernameFragment: 'aabbccdd11223344',
	password: 'aabbccddaabbccddaabbccddaabbccdd',
	iceLite: true,
};

const FAKE_ICE_CANDIDATES = [
	{
		foundation: 'udpcandidate',
		ip: '127.0.0.1',
		address: '127.0.0.1',
		port: 44444,
		priority: 1076302079,
		protocol: 'udp' as const,
		type: 'host' as const,
	},
];

const FAKE_DTLS_PARAMETERS = {
	role: 'auto' as const,
	fingerprints: [
		{
			algorithm: 'sha-256' as const,
			value:
				'00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:' +
				'00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
		},
	],
};

const OPUS_AUDIO_CODEC_OPTIONS = {
	opusStereo: false,
	opusDtx: true,
} as const;

async function main() {
	console.log('[demo] Starting produce-consume-audio PoC...');
	const wrtcRuntime = injectedWrtcRuntime;

	const { senderDevice, receiverDevice } = await createWrtcDevicePair({
		routerRtpCapabilities,
		wrtcRuntime,
		loggerSink,
	});

	console.log(
		`[sender]   device loaded — can produce audio:`,
		senderDevice.canProduce('audio')
	);

	console.log(
		`[receiver] device loaded — codecs:`,
		receiverDevice.recvRtpCapabilities.codecs?.length ?? 0
	);

	let capturedProducerId: string | undefined;
	let capturedRtpParameters: mediasoupTypes.RtpParameters | undefined;

	const sendTransport = attachTransportConnectHandler(
		senderDevice
		.createSendTransport({
			id: 'send-transport-1',
			iceParameters: FAKE_ICE_PARAMETERS,
			iceCandidates: FAKE_ICE_CANDIDATES,
			dtlsParameters: { ...FAKE_DTLS_PARAMETERS },
		})
		.on('produce', ({ kind, rtpParameters }, callback, errback) => {
			capturedRtpParameters = rtpParameters;
			capturedProducerId = `producer-${kind}-${Date.now()}`;
			console.log(
				`[send-transport] produce — kind: ${kind}, ssrc:`,
				rtpParameters.encodings?.[0]?.ssrc,
			);
			callback({ id: capturedProducerId });
		}),
	);

	const recvTransport = attachTransportConnectHandler(
		receiverDevice
		.createRecvTransport({
			id: 'recv-transport-1',
			iceParameters: FAKE_ICE_PARAMETERS,
			iceCandidates: FAKE_ICE_CANDIDATES,
			dtlsParameters: { ...FAKE_DTLS_PARAMETERS },
		}),
	);

	const syntheticAudio = createSyntheticAudioTrack(wrtcRuntime);

	const producer = await sendTransport.produce({
		track: syntheticAudio.track,
		codecOptions: OPUS_AUDIO_CODEC_OPTIONS,
	});

	console.log(
		`[sender]   producer created — id: ${producer.id}, kind: ${producer.kind},`,
		`paused: ${producer.paused}`,
	);

	if (capturedProducerId === undefined || capturedRtpParameters === undefined) {
		throw new Error('Producer signaling did not complete — cannot consume.');
	}

	const consumer = await recvTransport.consume({
		id: `consumer-${Date.now()}`,
		producerId: capturedProducerId,
		kind: 'audio',
		rtpParameters: capturedRtpParameters,
	});

	console.log(
		`[receiver] consumer created — id: ${consumer.id}, kind: ${consumer.kind},`,
		`paused: ${consumer.paused}`,
	);

	const audioSink = createAudioSink(wrtcRuntime, consumer.track);

	console.log(
		`[receiver] track.id: ${consumer.track.id}, readyState:`,
		consumer.track.readyState
	);
	await audioSink.wait(200);

	const framesReceived = audioSink.getFramesReceived();

	console.log(
		`[receiver] frames received: ${framesReceived}`,
		framesReceived === 0
			? '(expected — no real server; ICE/DTLS handshake did not complete)'
			: '✓',
	);

	await cleanupMediaActions({
		stopFirst: [
			audioSink,
			{ stop: () => consumer.track.stop() },
			syntheticAudio,
		],
		closeNext: [
			consumer,
			producer,
			sendTransport,
			recvTransport,
		],
	});
	await delay(50);

	console.log('[done] Example completed successfully.');
}

await runMainTask(main, { forceExitOnCompletion: true });
