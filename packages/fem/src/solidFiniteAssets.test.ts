import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { SOLID_FINITE_ASSETS } from './solidFiniteAssets.js';
it('pins both unchanged W33/W34 Python sources by exact byte length and SHA-256', () => {
  expect(SOLID_FINITE_ASSETS.map(pin => pin.file)).toEqual(['solidFiniteMaterial.py', 'solidFiniteEquilibrium.py']);
  for (const pin of SOLID_FINITE_ASSETS) {
    const bytes = readFileSync(new URL(`./${pin.file}`, import.meta.url));
    expect(bytes.byteLength).toBe(pin.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin.sha256);
  }
});
