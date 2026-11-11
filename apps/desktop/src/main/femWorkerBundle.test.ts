import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { expect, it } from 'vitest';
import { buildFemWorker } from '../../../../scripts/vite/femRuntimeAssets.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

it('builds the real FEM entry as one self-contained classic Worker', async () => {
  // A type-correct import through the model barrel can pull CAD Worker assets
  // into the numerical Worker. Exercise the shipped build, including its
  // one-chunk/no-import guard, before the application reaches screen tests.
  const code = await buildFemWorker(root);
  expect(code.length).toBeGreaterThan(0);
  expect(() => new Script(code, { filename: 'fem/worker.js' })).not.toThrow();
}, 120_000);
