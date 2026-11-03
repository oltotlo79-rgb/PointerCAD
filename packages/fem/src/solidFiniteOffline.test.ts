import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeSolidFiniteInBrowser } from './offlineBrowser.js';
import { SOLID_FINITE_ASSETS } from './solidFiniteAssets.js';
import { finiteInput } from './solidFiniteTransport.testSupport.js';
// Only tiny runtime inventory is synthetic. Finite Python pins and bytes are the actual immutable sources.
vi.mock('./assets.js', () => ({ FEM_ASSETS: ['pyodide.mjs', 'pyodide.asm.js'].map(file => ({ file, bytes: 1,
  sha256: '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a' })) }));
afterEach(() => { vi.unstubAllGlobals(); });
describe('finite offline asset boundary (no interpreter starts)', () => {
  it('validates before any origin or asset access', async () => {
    const read = vi.fn(() => { throw new Error('must not read origin'); });
    vi.stubGlobal('self', { get location() { return read(); } });
    await expect(analyzeSolidFiniteInBrowser({}, () => undefined)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it.each(SOLID_FINITE_ASSETS.flatMap(pin => ['missing', 'corrupt'].map(failure => ({ pin, failure }))))(
    'rejects $failure $pin.file before loading a runtime', async ({ pin, failure }) => {
      const phases: string[] = [];
      vi.stubGlobal('self', { location: new URL('https://pointercad.invalid/fem/worker.js'),
        fetch: (url: string): Promise<Response> => {
          const file = new URL(url).pathname.split('/').at(-1);
          if (file === pin.file) {
            if (failure === 'missing') return Promise.resolve(new Response(null, { status: 404 }));
            const changed = new Uint8Array(readFileSync(new URL(`./${pin.file}`, import.meta.url)));
            changed[0] ^= 1; // Preserve exact size: the actual SHA check must reject this byte change.
            return Promise.resolve(new Response(changed));
          }
          const bytes = SOLID_FINITE_ASSETS.some(asset => asset.file === file)
            ? new Uint8Array(readFileSync(new URL(`./${String(file)}`, import.meta.url))) : Uint8Array.of(1);
          return Promise.resolve(new Response(bytes));
        }, importScripts: () => { throw new Error('must not start interpreter'); } });
      await expect(analyzeSolidFiniteInBrowser(finiteInput(), phase => { phases.push(phase); })).rejects.toThrow(
        `${failure === 'missing' ? 'asset-missing' : 'asset-corrupt'}: ${pin.file}`);
      expect(phases).toEqual(['loading-assets']);
    });
  it('verifies both real program hashes, then locks fetch to fixed bytes before runtime loading', async () => {
    const reads: string[] = [], stop = new Error('stop before native import');
    const worker = { location: new URL('https://pointercad.invalid/fem/worker.js'),
      fetch: (url: string): Promise<Response> => {
        const file = new URL(url).pathname.split('/').at(-1); reads.push(String(file));
        return Promise.resolve(new Response(SOLID_FINITE_ASSETS.some(pin => pin.file === file)
          ? new Uint8Array(readFileSync(new URL(`./${String(file)}`, import.meta.url))) : Uint8Array.of(1)));
      }, importScripts: () => undefined };
    vi.stubGlobal('self', worker);
    await expect(analyzeSolidFiniteInBrowser(finiteInput(), phase => { if (phase === 'loading-runtime') throw stop; })).rejects.toBe(stop);
    expect(reads.sort()).toEqual(['pyodide.asm.js', 'pyodide.mjs', ...SOLID_FINITE_ASSETS.map(pin => pin.file)].sort());
    await expect(worker.fetch('https://outside.invalid/arbitrary.py')).rejects.toThrow('offline-request-denied');
    for (const pin of SOLID_FINITE_ASSETS) {
      const response = await worker.fetch(`https://pointercad.invalid/fem/assets/${pin.file}`);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(readFileSync(new URL(`./${pin.file}`, import.meta.url))));
    }
  });
});
