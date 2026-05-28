import { Device } from 'mediasoup-client';
import type {
  HandlerFactory,
  HandlerGetNativeRtpCapabilitiesOptions,
  RtpCapabilities,
} from 'mediasoup-client/types';

import WrtcHandler, { type WrtcLike } from '../index.ts';


type LoggerSink = Pick<Console, 'info' | 'warn' | 'error'>;


type CreateWrtcHandlerFactoryOptions = {
  loggerSink?: LoggerSink;
};

type CreateWrtcDeviceOptions = {
  routerRtpCapabilities: RtpCapabilities;
  wrtcRuntime?: WrtcLike;
  handlerFactory?: HandlerFactory;
  loggerSink?: LoggerSink;
  probeDirection?: HandlerGetNativeRtpCapabilitiesOptions['direction'];
};

export function createLoggerSink(prefix = '[wrtc-handler]'): LoggerSink
{
  return {
    info: (...args: unknown[]) => console.info(prefix, ...args),
    warn: (...args: unknown[]) => console.warn(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
  };
}

export function createWrtcHandlerFactory(
  wrtcRuntime: WrtcLike,
  { loggerSink = createLoggerSink() }: CreateWrtcHandlerFactoryOptions = {}
): HandlerFactory
{
  return WrtcHandler.createFactory(wrtcRuntime, loggerSink);
}

export async function createWrtcDevice(
  {
    routerRtpCapabilities,
    wrtcRuntime,
    handlerFactory,
    loggerSink,
    probeDirection,
  }: CreateWrtcDeviceOptions,
)
{
  const resolvedHandlerFactory = handlerFactory
    ?? (wrtcRuntime ? createWrtcHandlerFactory(wrtcRuntime, { loggerSink }) : undefined);

  if (!resolvedHandlerFactory)
  {
    throw new TypeError('Either handlerFactory or wrtcRuntime must be provided');
  }

  const nativeRtpCapabilities = probeDirection
    ? await resolvedHandlerFactory.getNativeRtpCapabilities({
      direction: probeDirection,
    })
    : undefined;

  const device = new Device({ handlerFactory: resolvedHandlerFactory });
  await device.load({ routerRtpCapabilities });

  return {
    device,
    handlerFactory: resolvedHandlerFactory,
    nativeRtpCapabilities,
  };
}
