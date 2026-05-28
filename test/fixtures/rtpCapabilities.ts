import type { types as mediasoupTypes } from 'mediasoup-client';


const AUDIO_CODEC = {
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
};

const AUDIO_HEADER_EXTENSION = {
	kind: 'audio' as const,
	uri: 'urn:ietf:params:rtp-hdrext:sdes:mid',
	preferredId: 1,
	preferredEncrypt: false,
	direction: 'sendrecv' as const,
};

const VIDEO_CODEC = {
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
};

const VIDEO_HEADER_EXTENSION = {
	kind: 'video' as const,
	uri: 'urn:ietf:params:rtp-hdrext:sdes:mid',
	preferredId: 1,
	preferredEncrypt: false,
	direction: 'sendrecv' as const,
};


export const AUDIO_ONLY_ROUTER_RTP_CAPABILITIES: mediasoupTypes.RtpCapabilities = {
	codecs: [
		AUDIO_CODEC,
	],
	headerExtensions: [
		AUDIO_HEADER_EXTENSION,
	],
};

export const AUDIO_VIDEO_ROUTER_RTP_CAPABILITIES: mediasoupTypes.RtpCapabilities = {
	codecs: [
		AUDIO_CODEC,
		VIDEO_CODEC,
	],
	headerExtensions: [
		AUDIO_HEADER_EXTENSION,
		VIDEO_HEADER_EXTENSION,
	],
};
