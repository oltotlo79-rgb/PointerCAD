import { expect, test } from '@playwright/test';
import { assetEvidenceErrors, isLocalFiniteRequest, type AssetResponseEvidence } from './solidFiniteWorkerEvidence.js';
import { registerSolidFiniteWorkerTests } from './solidFiniteWorkerFlow.js';

registerSolidFiniteWorkerTests(test, async (page) => { await page.goto('/'); });

// These three cases inspect URL/response records only; they request no page or browser fixture.

test('finite request origin checks include local blobs and reject foreign or opaque URLs', () => {
  const page = 'http://127.0.0.1:4173/';
  expect(isLocalFiniteRequest('blob:http://127.0.0.1:4173/actual-id', page)).toBe(true);
  expect(isLocalFiniteRequest('http://127.0.0.1:4173/fem/worker.js', page)).toBe(true);
  for (const value of ['blob:http://other.test/id', 'blob:http://127.0.0.1:4174/id', 'blob:null/id',
    'https://127.0.0.1:4173/fem/worker.js', 'data:text/plain,x', 'file:///fem/worker.js'])
    expect(isLocalFiniteRequest(value, page), value).toBe(false);
  expect(isLocalFiniteRequest('app://pointercad/fem/worker.js', 'app://pointercad/')).toBe(true);
  expect(isLocalFiniteRequest('app://other/fem/worker.js', 'app://pointercad/')).toBe(false);
  expect(isLocalFiniteRequest('blob:null/id', 'app://pointercad/')).toBe(false);
  expect(isLocalFiniteRequest('blob:app://pointercad/0c87d50c-ee7e-4f15-b6be-97f702f78be9', 'app://pointercad/index.html')).toBe(true);
  expect(isLocalFiniteRequest('blob:app://pointercad/767d4345-a73b-4a67-81d5-79c80eb14f8e', 'app://pointercad/index.html')).toBe(true);
  for (const value of ['blob:app://other/id', 'blob:app://pointercad:4173/id',
    'blob:app://user@pointercad/id', 'blob:http://pointercad/id', 'blob:https://pointercad/id',
    'blob:unknown://pointercad/id', 'blob:null/id', 'blob:app://'])
    expect(isLocalFiniteRequest(value, 'app://pointercad/index.html'), value).toBe(false);
  expect(isLocalFiniteRequest('blob:app://pointercad/id', page)).toBe(false);
  expect(isLocalFiniteRequest('blob:app://other/id', 'app://other/index.html')).toBe(false);
  expect(isLocalFiniteRequest('blob:unknown://pointercad/id', 'unknown://pointercad/index.html')).toBe(false);
});

const first: AssetResponseEvidence = { id: 1, url: 'http://local.test/fem/worker.js', status: 200,
  location: null, redirectedFromId: null, cachedFromId: null, bytes: 123, sha256: 'a'.repeat(64) };
const cached: AssetResponseEvidence = { id: 2, url: first.url, status: 304,
  location: null, redirectedFromId: null, cachedFromId: 1 };

test('304 requires the actual prior same-run same-URL complete 200 record', () => {
  expect(assetEvidenceErrors([first, cached])).toEqual([]);
  expect(assetEvidenceErrors([cached])).toHaveLength(1);
  expect(assetEvidenceErrors([{ ...first, url: 'http://other.test/fem/worker.js' }, cached])).toHaveLength(1);
  expect(assetEvidenceErrors([{ ...cached, id: 1, status: 200, cachedFromId: null }, cached])).toHaveLength(2);
  expect(assetEvidenceErrors([{ ...first, sha256: '' }, cached])).toHaveLength(2);
  expect(assetEvidenceErrors([{ ...first, id: 3 }, { ...cached, cachedFromId: 3 }])).toHaveLength(1);
});

test('redirects record Location and require an observed matching final 200 body', () => {
  const redirect: AssetResponseEvidence = { ...cached, id: 1, status: 302, cachedFromId: null, location: '/actual-worker.js' };
  const final: AssetResponseEvidence = { ...first, id: 2, url: 'http://local.test/actual-worker.js', redirectedFromId: 1 };
  expect(assetEvidenceErrors([redirect, final])).toEqual([]);
  expect(assetEvidenceErrors([redirect])).toHaveLength(1);
  expect(assetEvidenceErrors([{ ...redirect, location: null }, final])).toHaveLength(1);
  expect(assetEvidenceErrors([redirect, { ...final, sha256: '' }])).toHaveLength(2);
  expect(assetEvidenceErrors([redirect, { ...final, url: 'http://local.test/wrong.js' }])).toHaveLength(1);
  expect(assetEvidenceErrors([{ ...first, status: 500 }])).toHaveLength(1);
});
