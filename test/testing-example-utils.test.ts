import assert from 'node:assert/strict';
import test from 'node:test';

import {
	attachTransportConnectHandler,
	cleanupMediaActions,
	createWrtcDevicePair,
	delay,
} from '../src/testing/runtimeWorkflow.ts';
import {
	AUDIO_ONLY_ROUTER_RTP_CAPABILITIES,
} from './fixtures/rtpCapabilities.ts';


test('attachTransportConnectHandler invokes callback on success and errback on failure', async () => {
	type ConnectHandler = (
		event: { dtlsParameters: { fingerprints: Array<{ algorithm: string }> } },
		callback: () => void,
		errback: (error: Error) => void,
	) => Promise<void>;

	let connectHandler: ConnectHandler | undefined;

	const transport = {
		on(event: string, handler: ConnectHandler) {
			if (event === 'connect') {
				connectHandler = handler;
			}

			return this;
		},
	};

	let callbackCalls = 0;
	let errbackCalls = 0;
	let onConnectCalls = 0;

	attachTransportConnectHandler(
		transport as never,
		async () => {
			onConnectCalls++;
		},
	);

	assert.ok(connectHandler);

	await connectHandler!(
		{ dtlsParameters: { fingerprints: [{ algorithm: 'sha-256' }] } },
		() => {
			callbackCalls++;
		},
		(error) => {
			errbackCalls++;
		},
	);

	assert.equal(onConnectCalls, 1);
	assert.equal(callbackCalls, 1);
	assert.equal(errbackCalls, 0);

	attachTransportConnectHandler(
		transport as never,
		async () => {
			throw new Error('boom');
		},
	);

	await connectHandler!(
		{ dtlsParameters: { fingerprints: [{ algorithm: 'sha-256' }] } },
		() => {
			callbackCalls++;
		},
		(error) => {
			errbackCalls++;
		},
	);

	assert.equal(callbackCalls, 1);
	assert.equal(errbackCalls, 1);
});


test('attachTransportConnectHandler defaults to a no-op connect callback', async () => {
	type ConnectHandler = (
		event: { dtlsParameters: { fingerprints: Array<{ algorithm: string }> } },
		callback: () => void,
		errback: (error: Error) => void,
	) => Promise<void>;

	let connectHandler: ConnectHandler | undefined;

	const transport = {
		on(event: string, handler: ConnectHandler) {
			if (event === 'connect') {
				connectHandler = handler;
			}

			return this;
		},
	};

	let callbackCalls = 0;
	let errbackCalls = 0;

	attachTransportConnectHandler(transport as never);

	assert.ok(connectHandler);

	await connectHandler!(
		{ dtlsParameters: { fingerprints: [{ algorithm: 'sha-256' }] } },
		() => {
			callbackCalls++;
		},
		() => {
			errbackCalls++;
		},
	);

	assert.equal(callbackCalls, 1);
	assert.equal(errbackCalls, 0);
});


test('cleanupMediaActions executes stop actions before close actions in order', async () => {
	const sequence: string[] = [];

	await cleanupMediaActions({
		stopFirst: [
			{ stop: () => sequence.push('stop-1') },
			{ stop: async () => sequence.push('stop-2') },
		],
		closeNext: [
			{ close: () => sequence.push('close-1') },
			{ close: async () => sequence.push('close-2') },
		],
	});

	assert.deepEqual(sequence, ['stop-1', 'stop-2', 'close-1', 'close-2']);
});


test('delay resolves after requested timeout window', async () => {
	const start = Date.now();
	await delay(10);
	assert.ok(Date.now() - start >= 8);
});


test('createWrtcDevicePair creates sender and receiver devices with shared handler factory', async () => {
	const mockRuntime = {
		RTCPeerConnection: class RTCPeerConnection {},
		MediaStream: class MediaStream {},
	};

	const mockHandlerFactory = {
		name: 'mock',
		factory: () => ({}),
		getNativeRtpCapabilities: async () => AUDIO_ONLY_ROUTER_RTP_CAPABILITIES,
		getNativeSctpCapabilities: async () => ({ numStreams: { OS: 1, MIS: 1 } }),
	};

	const createDeviceCalls: Array<Record<string, unknown>> = [];

	const createDevice = async (options: Record<string, unknown>) => {
		createDeviceCalls.push(options);

		return {
			device: {
				canProduce: (_kind: string) => true,
			},
			handlerFactory: mockHandlerFactory,
			nativeRtpCapabilities: undefined,
		};
	};

	const { senderDevice, receiverDevice, handlerFactory } = await createWrtcDevicePair({
		routerRtpCapabilities: AUDIO_ONLY_ROUTER_RTP_CAPABILITIES,
		wrtcRuntime: mockRuntime,
		createHandlerFactory: () => mockHandlerFactory as never,
		createDevice: createDevice as never,
	});

	assert.equal(createDeviceCalls.length, 2);
	assert.equal(createDeviceCalls[0]?.handlerFactory, mockHandlerFactory);
	assert.equal(createDeviceCalls[1]?.handlerFactory, mockHandlerFactory);
	assert.ok(senderDevice);
	assert.ok(receiverDevice);
	assert.ok(handlerFactory);
	assert.equal(typeof handlerFactory.factory, 'function');
	assert.equal((senderDevice as { canProduce: (kind: string) => boolean }).canProduce('audio'), true);
});
