import type { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FemClient, bucklingInputSha256, bucklingResultMatches, decodeBeamBuckling,
  isBeamBucklingResult, translateBeamBuckling,
  type BeamBucklingInput, type BeamBucklingResult, type BucklingRestraints, type FemWorkerPort,
} from './index.js';
import { FEM_ASSETS } from './assets.js';
import { bucklingFixture } from './buckling.testSupport.js';

function bytes(name: string): Buffer {
  return readFileSync(new URL(name, import.meta.url));
}
function pin(data: Uint8Array): { readonly sha256: string; readonly bytes: number } {
  return { sha256: createHash('sha256').update(data).digest('hex'), bytes: data.byteLength };
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected metadata object');
  return value as Record<string, unknown>;
}
function json(name: string): Record<string, unknown> {
  const value: unknown = JSON.parse(bytes(name).toString('utf8'));
  return record(value);
}

describe('buckling public package and shipped source contract', () => {
  it('uses the declared public entry for strict translation and result association', async () => {
    const packageJson = json('../package.json');
    expect(record(record(packageJson.exports)['.']).default).toBe('./src/index.ts');
    const input: BeamBucklingInput = bucklingFixture();
    const fixed: BucklingRestraints = [true, true, true, true, true, true];
    expect(input.supports[0].restrained).toEqual(fixed);
    const { plan } = translateBeamBuckling(input);
    const hash = await bucklingInputSha256(input);
    // Protocol fixture only; actual OOFEM numerical oracles are independently qualified.
    const raw = {
      schema: 'pointercad-oofem-buckling-result/1', normalizationLengthM: plan.normalizationLengthM,
      meshNodes: plan.nodes.length, meshElements: plan.members.length,
      freeDofs: plan.nodes.reduce((count, node) => count + node.restrained.filter(value => !value).length, 0),
      referenceEquilibriumResidual: 0, maximumStiffnessOrthogonalityError: 0,
      modes: [1, 2].map(number => ({ number, loadFactor: number, normalizedResidual: 0,
        nodes: plan.nodes.map(node => ({ number: node.number,
          translation: [0, node.number === 2 ? 1 : 0, 0], rotation: [0, 0, 0] })) })),
    };
    const result: BeamBucklingResult = decodeBeamBuckling(raw, input, hash);
    expect(isBeamBucklingResult(result)).toBe(true);
    expect(bucklingResultMatches(result, input, hash)).toBe(true);
    expect(bucklingResultMatches(result, input, 'f'.repeat(64))).toBe(false);
    expect(() => translateBeamBuckling({ ...input, script: 'arbitrary' })).toThrow();
  });

  it('dispatches and cancels buckling through the public owned client', async () => {
    let terminated = 0;
    const requests: unknown[] = [];
    const worker: FemWorkerPort = {
      postMessage: value => { requests.push(value); }, terminate: () => { terminated += 1; },
      onmessage: null, onerror: null, onmessageerror: null,
    };
    const client = new FemClient(() => worker);
    const abort = new AbortController();
    try {
      const pending = client.analyzeBuckling(bucklingFixture(), { signal: abort.signal });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ kind: 'analyze-beam-buckling-3d' });
      abort.abort();
      await expect(pending).resolves.toMatchObject({ kind: 'cancelled', reason: 'abort' });
      expect(terminated).toBe(1);
      expect(worker.onmessage).toBeNull();
    } finally {
      client.dispose();
    }
    expect(terminated).toBe(1);
  });

  it('ships the same wrapper and current public source bytes through every inventory', () => {
    const source = bytes('./beamAnalysis.py');
    const asset = bytes('../runtime/assets/beamAnalysis.py');
    expect(asset).toEqual(source);
    const wrapper = pin(source);
    const assetRow = FEM_ASSETS.filter(row => row.file === 'beamAnalysis.py');
    expect(assetRow).toEqual([{ file: 'beamAnalysis.py', ...wrapper }]);
    const runtime = json('../runtime/manifest.json');
    const files = record(runtime.files);
    expect(files['assets/beamAnalysis.py']).toEqual(wrapper);
    const indexBytes = bytes('../runtime/evidence/application-source-index.json');
    expect(files['evidence/application-source-index.json']).toEqual(pin(indexBytes));
    const index = json('../runtime/evidence/application-source-index.json');
    const archive = pin(bytes('../runtime/sources/pointercad-beam-application-source.zip'));
    expect(files['sources/pointercad-beam-application-source.zip']).toEqual(archive);
    expect(index.archiveSha256).toBe(archive.sha256);
    const sources = record(index.files);
    for (const name of [
      'beamAnalysis.py', 'protocol.ts', 'client.ts', 'runtime.ts', 'offlineBrowser.ts', 'worker.ts',
      'bucklingModel.ts', 'bucklingTranslation.ts', 'bucklingResults.ts', 'buckling.test.ts',
      'buckling.testSupport.ts', 'bucklingNative.testSupport.ts', 'index.ts', 'assets.ts', 'buckling.package.test.ts',
    ]) {
      const row = record(sources['packages/fem/src/' + name]);
      expect({ sha256: row.sha256, bytes: row.bytes }).toEqual(pin(bytes('./' + name)));
    }
    const config = record(sources['packages/fem/vitest.config.ts']);
    expect({ sha256: config.sha256, bytes: config.bytes }).toEqual(pin(bytes('../vitest.config.ts')));
    expect(runtime.nativeRebuildExecuted).toBe(true);
    expect(runtime.correspondingSourceComplete).toBe(false);
    expect(index.nativeRebuildExecuted).toBe(false);
    expect(index.correspondingSourceComplete).toBe(false);
  });
});
