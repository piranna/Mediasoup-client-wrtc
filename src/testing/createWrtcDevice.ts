import { createRequire } from 'node:module';

import { Device } from 'mediasoup-client';
import type {
  HandlerFactory,
  HandlerGetNativeRtpCapabilitiesOptions,
  RtpCapabilities,
} from 'mediasoup-client/types';

import WrtcHandler from '../index.ts';


const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const wrtc = require('@roamhq/wrtc') as typeof import('@roamhq/wrtc');


type LoggerSink = Pick<Console, 'info' | 'warn' | 'error'>;


type CreateWrtcHandlerFactoryOptions = {
  loggerSink?: LoggerSink;
};

type CreateWrtcDeviceOptions = {
  routerRtpCapabilities: RtpCapabilities;
  handlerFactory?: HandlerFactory;
  loggerSink?: LoggerSink;
  probeDirection?: HandlerGetNativeRtpCapabilitiesOptions['direction'];
};


export function getWrtcRuntime(): typeof import('@roamhq/wrtc')
{
  return wrtc;
}

export function createLoggerSink(prefix = '[wrtc-handler]'): LoggerSink
{
  return {
    info: (...args: unknown[]) => console.info(prefix, ...args),
    warn: (...args: unknown[]) => console.warn(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
  };
}

export function createWrtcHandlerFactory(
  { loggerSink = createLoggerSink() }: CreateWrtcHandlerFactoryOptions = {}
): HandlerFactory
{
  return WrtcHandler.createFactory(wrtc, loggerSink);
}

export async function createWrtcDevice(
  {
    routerRtpCapabilities,
    handlerFactory,
    loggerSink,
    probeDirection,
  }: CreateWrtcDeviceOptions,
)
{
  const resolvedHandlerFactory =
    handlerFactory ?? createWrtcHandlerFactory({ loggerSink });

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
    wrtc,
  };
}
