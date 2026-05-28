#!/usr/bin/env node

/**
 * produce-consume-audio.ts
 *
 * Minimal mediasoup-client Producer → Consumer audio PoC running entirely in
 * Node.js with @roamhq/wrtc as the WebRTC runtime.
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
	createAudioSink,
	createLoggerSink,
	createSyntheticAudioTrack,
	createWrtcDevice,
	createWrtcHandlerFactory,
	getWrtcRuntime,
} from 'mediasoup-client-wrtc/testing';

// ---------------------------------------------------------------------------
// Logging helpers — mirror the style used in 01-load-device.ts
// ---------------------------------------------------------------------------

const loggerSink = createLoggerSink();

// ---------------------------------------------------------------------------
// Router RTP capabilities (audio-only subset)
//
// In production these come from router.rtpCapabilities on the mediasoup server.
// We keep only Opus here because this example produces audio only.
// ---------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Fake WebRTC transport parameters
//
// In production the server returns these after calling
// router.createWebRtcTransport().  We use plausible but non-connectable values
// so mediasoup-client can complete the signaling lifecycle without trying to
// reach a real server.
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
	console.log('[demo] Starting produce-consume-audio PoC...');
	const wrtc = getWrtcRuntime();

	// ── Step 1: Create a shared handler factory ────────────────────────────────
	//
	// WrtcHandler.createFactory() wraps @roamhq/wrtc so mediasoup-client can use
	// it as its WebRTC engine. Both devices share the same factory.

	const handlerFactory = createWrtcHandlerFactory({ loggerSink });

	// ── Step 2: Create and load the sender Device ──────────────────────────────
	//
	// Device.load() negotiates the local handler's native RTP capabilities
	// against the router's capabilities to compute what the device can send.

	const { device: senderDevice } = await createWrtcDevice({
		routerRtpCapabilities,
		handlerFactory,
	});
	console.log(
		`[sender]   device loaded — can produce audio:`,
		senderDevice.canProduce('audio')
	);

	// ── Step 3: Create and load the receiver Device ────────────────────────────
	//
	// A separate Device instance represents the consumer side. In a real app this
	// would run in a different process / machine.

	const { device: receiverDevice } = await createWrtcDevice({
		routerRtpCapabilities,
		handlerFactory,
	});
	console.log(
		`[receiver] device loaded — codecs:`,
		receiverDevice.recvRtpCapabilities.codecs?.length ?? 0
	);

	// ── Step 4: Create the send WebRTC transport ──────────────────────────────
	//
	// Inline mock signaling — in a real app these callbacks would send the
	// parameters to the server over WebSocket/HTTP.
	let capturedProducerId: string | undefined;
	let capturedRtpParameters: mediasoupTypes.RtpParameters | undefined;

	// In production: POST /routers/:id/webrtc-transports → server returns the
	// iceParameters, iceCandidates and dtlsParameters below.
	// The 'connect' event fires once the handler has negotiated local SDP and
	// needs to tell the server its DTLS fingerprint.
	// The 'produce' event fires when the client is ready to send; the server
	// creates a server-side Producer and returns its ID.

	const sendTransport = senderDevice
		.createSendTransport({
			id: 'send-transport-1',
			iceParameters: FAKE_ICE_PARAMETERS,
			iceCandidates: FAKE_ICE_CANDIDATES,
			dtlsParameters: { ...FAKE_DTLS_PARAMETERS },
		})
		.on('connect', ({ dtlsParameters }, callback, errback) => {
			console.log(
				'[send-transport] connect — DTLS algorithm:',
				dtlsParameters.fingerprints[0]?.algorithm,
			);

			// Normally: send dtlsParameters to server → server calls transport.connect()
			callback();
		})
		.on('connectionstatechange', (state) => {
			console.log(`[send-transport] connectionstatechange → ${state}`);
		})
		.on('produce', ({ kind, rtpParameters }, callback, errback) => {
			// Normally: send { kind, rtpParameters } to server →
			//   server calls transport.produce() → returns producer ID.
			capturedRtpParameters = rtpParameters;
			capturedProducerId = `producer-${kind}-${Date.now()}`;
			console.log(
				`[send-transport] produce — kind: ${kind}, ssrc:`,
				rtpParameters.encodings?.[0]?.ssrc,
			);
			callback({ id: capturedProducerId });
		});

	// ── Step 5: Create the recv WebRTC transport ───────────────────────────────
	//
	// In production: another POST /routers/:id/webrtc-transports call.
	// The recv transport does NOT emit 'produce'; only 'connect' is needed.

	const recvTransport = receiverDevice
		.createRecvTransport({
			id: 'recv-transport-1',
			iceParameters: FAKE_ICE_PARAMETERS,
			iceCandidates: FAKE_ICE_CANDIDATES,
			dtlsParameters: { ...FAKE_DTLS_PARAMETERS },
		})
		.on('connect', ({ dtlsParameters }, callback, errback) => {
			console.log(
				'[recv-transport] connect — DTLS algorithm:',
				dtlsParameters.fingerprints[0]?.algorithm,
			);
			// Normally: send dtlsParameters to server → server calls transport.connect()
			callback();
		})
		.on('connectionstatechange', (state) => {
			console.log(`[recv-transport] connectionstatechange → ${state}`);
		});

	// ── Step 6: Generate a synthetic audio track ───────────────────────────────
	//
	// RTCAudioSource lets us push PCM frames programmatically without a real
	// microphone — ideal for CI / headless environments.

	const syntheticAudio = createSyntheticAudioTrack(wrtc);

	// ── Step 7: Produce audio from the sender ──────────────────────────────────
	//
	// transport.produce() triggers the internal SDP offer/answer cycle:
	//   1. Creates a sendonly RTCPeerConnection transceiver.
	//   2. Negotiates local SDP → fires 'connect' event (step 4 above).
	//   3. Resolves the RTP parameters → fires 'produce' event (step 4 above).

	const producer = await sendTransport.produce({
		track: syntheticAudio.track,
		codecOptions: {
			opusStereo: false,
			opusDtx: true,
		},
	});

	console.log(
		`[sender]   producer created — id: ${producer.id}, kind: ${producer.kind},`,
		`paused: ${producer.paused}`,
	);

	// ── Step 8: Consume audio on the receiver ──────────────────────────────────
	//
	// In production the server calls router.consume({ producerId,
	// rtpCapabilities: receiverDevice.rtpCapabilities }) and returns
	// { id, producerId, kind, rtpParameters }.  Here we reuse the producer's
	// own rtpParameters as a stand-in — valid for the Opus audio path.

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

	// ── Step 9: Verify the consumer track ──────────────────────────────────────
	//
	// The track is live once the SDP negotiation completes on the client side.
	// Without a real server the track carries no frames, but readyState = 'live'
	// confirms the WebRTC machinery set it up correctly. Attach an RTCAudioSink:
	// if real connectivity were present it would fire the 'data' event with
	// decoded PCM frames.

	const audioSink = createAudioSink(wrtc, consumer.track);

	console.log(
		`[receiver] track.id: ${consumer.track.id}, readyState:`,
		consumer.track.readyState
	);
	console.log(`[receiver] RTCAudioSink attached — waiting 200 ms for frames…`);

	// Give the ICE machinery a moment; frames only arrive with real connectivity.
	await audioSink.wait(200);

	const framesReceived = audioSink.getFramesReceived();

	console.log(
		`[receiver] frames received: ${framesReceived}`,
		framesReceived === 0
			? '(expected — no real server; ICE/DTLS handshake did not complete)'
			: '✓',
	);

	// ── Clean up ───────────────────────────────────────────────────────────────

	audioSink.stop();

	consumer.track.stop();
	syntheticAudio.stop();

	consumer.close();
	producer.close();
	sendTransport.close();
	recvTransport.close();

	// Give wrtc a brief moment to flush native cleanup callbacks before exit.
	await new Promise<void>((resolve) => setTimeout(resolve, 50));

	console.log('[done] Example completed successfully.');
	console.log('[info] To see actual audio frames, connect to a real mediasoup server.');

	process.exit(0);
}

try {
	await main();
}
catch (error)
{
	console.error('Fatal error:', error);
	process.exitCode = 1;
}
