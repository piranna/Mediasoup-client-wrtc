import type { DtlsRole } from 'mediasoup-client/types';

import { WrtcHandler } from '../src/index.ts';

const WRTC_HANDLER_TEST_HOOKS = Symbol.for('mediasoup-client-wrtc/test-hooks');

type WrtcHandlerInternalTestHooks = {
  setupTransportWithoutLocalSdp: (localDtlsRole: DtlsRole) => Promise<void>;
};

type WrtcHandlerWithHooks = WrtcHandler & {
  [WRTC_HANDLER_TEST_HOOKS]?: WrtcHandlerInternalTestHooks;
};

export async function setupTransportWithoutLocalSdpForTest(
  handler: WrtcHandler,
  localDtlsRole: DtlsRole,
): Promise<void>
{
  const hooks = (handler as WrtcHandlerWithHooks)[WRTC_HANDLER_TEST_HOOKS];

  if (!hooks)
    throw new Error('WrtcHandler test hooks are not available');

  await hooks.setupTransportWithoutLocalSdp(localDtlsRole);
}
