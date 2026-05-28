import assert from 'node:assert/strict';
import test from 'node:test';

import {
	loadWrtcRuntimeModule,
	runMainTask,
} from '../src/testing/runtimeModule.ts';


test('loadWrtcRuntimeModule forwards provided module id to the loader', () => {
	const calls: string[] = [];

	const runtime = loadWrtcRuntimeModule('mock-wrtc', (moduleId: string) => {
		calls.push(moduleId);

		return {
			RTCPeerConnection: class RTCPeerConnection {},
			MediaStream: class MediaStream {},
		};
	});

	assert.equal(calls[0], 'mock-wrtc');
	assert.equal(typeof runtime.RTCPeerConnection, 'function');
	assert.equal(typeof runtime.MediaStream, 'function');
});


test('loadWrtcRuntimeModule validates required runtime constructors', () => {
	assert.throws(
		() => {
			loadWrtcRuntimeModule('invalid-runtime', () => ({}));
		},
		/does not expose RTCPeerConnection/,
	);

	assert.throws(
		() => {
			loadWrtcRuntimeModule('invalid-runtime', () => ({
				RTCPeerConnection: class RTCPeerConnection {},
			}));
		},
		/does not expose MediaStream/,
	);
});


test('runMainTask sets process.exitCode when main fails without forced exit', async () => {
	const originalExitCode = process.exitCode;
	const errorCalls: unknown[][] = [];
	const originalConsoleError = console.error;

	console.error = (...args: unknown[]) => {
		errorCalls.push(args);
	};

	process.exitCode = undefined;

	try {
		await runMainTask(async () => {
			throw new Error('boom');
		}, { errorPrefix: 'Task error:' });

		assert.equal(process.exitCode, 1);
		assert.equal(errorCalls.length, 1);
		assert.equal(errorCalls[0]?.[0], 'Task error:');
	}
	finally {
		console.error = originalConsoleError;
		process.exitCode = originalExitCode;
	}
});


test('runMainTask calls process.exit on forced completion', async () => {
	const originalProcessExit = process.exit;
	const exitCalls: Array<number | undefined> = [];

	process.exit = ((code?: number) => {
		exitCalls.push(code);
		return undefined as never;
	}) as typeof process.exit;

	try {
		await runMainTask(async () => {}, { forceExitOnCompletion: true });

		assert.deepEqual(exitCalls, [0]);
	}
	finally {
		process.exit = originalProcessExit;
	}
});


test('runMainTask calls process.exit with code 1 when main fails and forced exit is enabled', async () => {
	const originalProcessExit = process.exit;
	const originalExitCode = process.exitCode;
	const exitCalls: Array<number | undefined> = [];

	process.exit = ((code?: number) => {
		exitCalls.push(code);
		throw new Error('forced exit');
	}) as typeof process.exit;

	process.exitCode = undefined;

	try {
		await assert.rejects(
			runMainTask(async () => {
				throw new Error('failure');
			}, { forceExitOnCompletion: true }),
			/forced exit/,
		);

		assert.deepEqual(exitCalls, [1]);
		assert.equal(process.exitCode, undefined);
	}
	finally {
		process.exit = originalProcessExit;
		process.exitCode = originalExitCode;
	}
});
