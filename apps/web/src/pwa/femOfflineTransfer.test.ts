import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APP_CONTENT_SECURITY_POLICY, FEM_WORKER_CONTENT_SECURITY_POLICY } from '@pointercad/ui/security-policy';
import { collectFemRuntimeAssets } from '../../../../scripts/vite/femRuntimeAssets.mjs';
import { createOfflineAssetManifest } from '../../../../scripts/vite/offlineAssets.mjs';
import { verifyOfflineAssetResponse } from './offlineTransfer.js';

describe('offline admission of the fixed FEM Worker', () => {
  const base = new URL('https://pointercad.test/');
  const body = 'fixed local FEM Worker';
  const asset = { url: 'fem/worker.js', byteLength: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') };
  function response(policy: string, text = body): Response {
    const value = new Response(text, { headers: { 'Content-Type': 'text/javascript', 'Content-Security-Policy': policy } });
    // Unit response identity only; product E2E checks actual headers. Cache qualification is separate.
    Object.defineProperties(value, { type: { value: 'basic' }, url: { value: new URL(asset.url, base).href } });
    return value;
  }
  it('admits exact bytes with the separately scoped response policy', async () => {
    const value = response(FEM_WORKER_CONTENT_SECURITY_POLICY);
    expect(await verifyOfflineAssetResponse(base, asset, value, new AbortController().signal, () => undefined)).toBe(value);
  });
  it.each(['', APP_CONTENT_SECURITY_POLICY, "default-src *; script-src * 'unsafe-eval'"])(
    'rejects an absent, page or broadened policy', async policy => {
      await expect(verifyOfflineAssetResponse(base, asset, response(policy), new AbortController().signal, () => undefined))
        .rejects.toMatchObject({ reason: 'response' });
    },
  );
  it('still rejects same-length changed Worker bytes with correct headers', async () => {
    await expect(verifyOfflineAssetResponse(base, asset, response(FEM_WORKER_CONTENT_SECURITY_POLICY, body.toUpperCase()),
      new AbortController().signal, () => undefined)).rejects.toMatchObject({ reason: 'hash' });
  });
});

describe('offline inventory of the shipped FEM runtime (EX-09 delivery)', () => {
  it('lists every manifest asset and notice at its emitted path with the identical size and SHA-256', () => {
    const folder = join(fileURLToPath(new URL('../../../../', import.meta.url)), 'packages/fem/runtime');
    const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as {
      readonly files: Readonly<Record<string, { readonly bytes: number; readonly sha256: string }>> };
    // The same plugin output the Web build emits; the offline inventory is generated from those exact bytes.
    const { assets } = collectFemRuntimeAssets(folder);
    const files = [{ path: 'index.html', bytes: new TextEncoder().encode('<!doctype html>') },
      ...[...assets].map(([path, bytes]) => ({ path, bytes }))];
    const inventory = createOfflineAssetManifest(files, files.map(file => file.path));
    const records = new Map(inventory.assets.map(record => [record.url, record]));
    const shipped = Object.entries(manifest.files).filter(([name]) => name.startsWith('assets/') || name.startsWith('notices/'));
    const missing: string[] = [], mismatched: string[] = [];
    for (const [name, pin] of shipped) {
      const url = name.startsWith('assets/') ? 'fem/' + name : 'licenses/fem/' + name, row = records.get(url);
      if (row === undefined) missing.push(url);
      else if (row.byteLength !== pin.bytes || row.sha256 !== pin.sha256) mismatched.push(url);
    }
    expect({ assets: shipped.filter(([name]) => name.startsWith('assets/')).length, notices: shipped.length - 36, missing, mismatched })
      .toEqual({ assets: 36, notices: 82, missing: [], mismatched: [] });
    expect([...inventory.required].sort()).toEqual(inventory.assets.map(record => record.url).sort());
  });
});
