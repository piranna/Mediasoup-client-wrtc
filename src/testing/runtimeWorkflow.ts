import type { types as mediasoupTypes } from 'mediasoup-client';

import type { WrtcLike } from '../index.ts';

import {
	createLoggerSink,
	createWrtcDevice,
	createWrtcHandlerFactory,
} from './createWrtcDevice.ts';


type LoggerSink = Pick<Console, 'info' | 'warn' | 'error'>;

export type CreateWrtcDevicePairOptions = {
	routerRtpCapabilities: mediasoupTypes.RtpCapabilities;
	wrtcRuntime: WrtcLike;
	loggerSink?: LoggerSink;
	createDevice?: typeof createWrtcDevice;
	createHandlerFactory?: typeof createWrtcHandlerFactory;
};

export async function createWrtcDevicePair(
	{
		routerRtpCapabilities,
		wrtcRuntime,
		loggerSink = createLoggerSink(),
		createDevice = createWrtcDevice,
		createHandlerFactory = createWrtcHandlerFactory,
	}: CreateWrtcDevicePairOptions,
) {
	const handlerFactory = createHandlerFactory(wrtcRuntime, { loggerSink });

	const [{ device: senderDevice }, { device: receiverDevice }] = await Promise.all([
		createDevice({
			routerRtpCapabilities,
			wrtcRuntime,
			handlerFactory,
		}),
		createDevice({
			routerRtpCapabilities,
			wrtcRuntime,
			handlerFactory,
		}),
	]);

	return {
		senderDevice,
		receiverDevice,
		handlerFactory,
	};
}

export type TransportConnectListener = (
	dtlsParameters: mediasoupTypes.DtlsParameters,
) => void | Promise<void>;

export function attachTransportConnectHandler(
	transport: mediasoupTypes.Transport,
	onConnect: TransportConnectListener | undefined,
) {
	transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
    if(onConnect)
      try {
        await onConnect(dtlsParameters);
      }
      catch (error) {
        return errback(error as Error);
      }

		callback();
  });

	return transport;
}

export type MaybeAsyncAction = {
	close?: () => void | Promise<void>;
	stop?: () => void | Promise<void>;
};

export type CleanupMediaActionsOptions = {
	stopFirst?: MaybeAsyncAction[];
	closeNext?: MaybeAsyncAction[];
};

export async function cleanupMediaActions(
	{
		stopFirst = [],
		closeNext = [],
	}: CleanupMediaActionsOptions,
): Promise<void> {
	for (const action of stopFirst)
	{
		await action.stop?.();
	}

	for (const action of closeNext)
	{
		await action.close?.();
	}
}

export async function delay(timeoutMs: number): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
}
