import { expect, type ElectronApplication } from '@playwright/test';
import { KERNEL_TIMEOUT_MS } from './recompute.js';
import type { AssetHold } from './analysisResultBindingFlow.js';

/** Temporarily hold the actual appProtocol file: response, preserving its original Response and bytes. */
export async function holdElectronFemAsset(app: ElectronApplication): Promise<AssetHold> {
  await app.evaluate(({ net }) => {
    const key = '__pcadTestFemAssetHold';
    if (Reflect.has(net, key)) throw new Error('FEM asset hold already installed');
    const original = net.fetch;
    let open = (): void => undefined;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const state: { held: string | null; ready: boolean; released: boolean; returned: boolean;
      status: number | null; error: string | null; release: () => void; dispose: () => void } = {
      held: null, ready: false, released: false, returned: false, status: null, error: null,
      release: () => { state.released = true; open(); },
      dispose: () => { state.release(); Reflect.set(net, 'fetch', original); Reflect.deleteProperty(net, key); },
    };
    const wrapper: typeof net.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (state.held !== null || !/^file:.*\/fem\/assets\/[^/]+$/u.test(url)) return original.call(net, input, init);
      state.held = url;
      try {
        const response = await original.call(net, input, init);
        state.status = response.status;
        state.ready = response.ok;
        await gate;
        state.returned = true;
        return response;
      } catch (error: unknown) {
        state.error = String(error);
        throw error;
      }
    };
    if (!Reflect.set(net, 'fetch', wrapper) || net.fetch !== wrapper) throw new Error('Electron net.fetch cannot be wrapped');
    Reflect.set(net, key, state);
  });
  const read = () => app.evaluate(({ net }) => {
    const state = Reflect.get(net, '__pcadTestFemAssetHold') as {
      held: string | null; ready: boolean; released: boolean; returned: boolean; status: number | null; error: string | null;
    } | undefined;
    if (state === undefined) throw new Error('FEM asset hold missing');
    return { held: state.held, ready: state.ready, released: state.released, returned: state.returned,
      status: state.status, error: state.error };
  });
  return {
    held: async () => { const state = await read(); return state.ready ? state.held : null; },
    holding: async () => { const state = await read(); return state.ready && !state.released; },
    release: async () => {
      await app.evaluate(({ net }) => {
        const state = Reflect.get(net, '__pcadTestFemAssetHold') as { release: () => void } | undefined;
        if (state === undefined) throw new Error('FEM asset hold missing');
        state.release();
      });
      await expect.poll(async () => (await read()).returned, { timeout: KERNEL_TIMEOUT_MS,
        message: 'the original Electron FEM asset response must be returned' }).toBe(true);
      return JSON.stringify(await read());
    },
    dispose: async () => {
      await app.evaluate(({ net }) => {
        const state = Reflect.get(net, '__pcadTestFemAssetHold') as { dispose: () => void } | undefined;
        if (state !== undefined) state.dispose();
      });
    },
  };
}
