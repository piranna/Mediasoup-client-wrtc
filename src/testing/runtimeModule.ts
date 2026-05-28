import { createRequire } from 'node:module';

import {
	type WrtcRuntimeWithNonstandard,
} from './webrtcRuntimeTypes.ts';


const require = createRequire(import.meta.url);

type RuntimeModuleLoader = (moduleId: string) => unknown;

export function loadWrtcRuntimeModule(
	moduleId: string,
	moduleLoader: RuntimeModuleLoader = require,
): WrtcRuntimeWithNonstandard {
	const runtime = moduleLoader(moduleId) as Partial<WrtcRuntimeWithNonstandard>;

	if (typeof runtime?.RTCPeerConnection !== 'function')
	{
		throw new TypeError(`Runtime module "${moduleId}" does not expose RTCPeerConnection`);
	}

	if (typeof runtime?.MediaStream !== 'function')
	{
		throw new TypeError(`Runtime module "${moduleId}" does not expose MediaStream`);
	}

	return runtime as WrtcRuntimeWithNonstandard;
}

export type RunTaskOptions = {
	errorPrefix?: string;
	forceExitOnCompletion?: boolean;
};

export async function runMainTask(
	main: () => Promise<void>,
	{
		errorPrefix = 'Fatal error:',
		forceExitOnCompletion = false,
	}: RunTaskOptions = {},
): Promise<void> {
	try {
		await main();

		if (forceExitOnCompletion)
		{
			process.exit(0);
		}
	}
	catch (error) {
		console.error(errorPrefix, error);

		if (forceExitOnCompletion)
		{
			process.exit(1);
		}

		process.exitCode = 1;
	}
}
