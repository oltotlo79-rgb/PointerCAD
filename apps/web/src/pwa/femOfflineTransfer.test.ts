import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { APP_CONTENT_SECURITY_POLICY, FEM_WORKER_CONTENT_SECURITY_POLICY } from '@pointercad/ui/security-policy';
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
