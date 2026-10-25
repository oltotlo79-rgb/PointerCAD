import type { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
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

// The index compares these source bytes verbatim; share the list with the Git round-trip regression.
const indexedSources = [
  'beamAnalysis.py', 'protocol.ts', 'client.ts', 'runtime.ts', 'offlineBrowser.ts', 'worker.ts',
  'bucklingModel.ts', 'bucklingTranslation.ts', 'bucklingResults.ts', 'buckling.test.ts',
  'buckling.testSupport.ts', 'bucklingNative.testSupport.ts', 'index.ts', 'assets.ts', 'buckling.package.test.ts',
].map(name => 'packages/fem/src/' + name).concat('packages/fem/vitest.config.ts');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const runtimePrefix = 'packages/fem/runtime/';

function runtimePaths(): string[] {
  const manifest = json('../runtime/manifest.json');
  const stored = record(manifest.storedParts);
  const parts = Object.values(stored).flatMap(value => {
    if (!Array.isArray(value)) throw new Error('Expected stored parts');
    return value.map(part => {
      const name = record(part).file;
      if (typeof name !== 'string') throw new Error('Expected stored part path');
      return name;
    });
  });
  return ['manifest.json', ...Object.keys(record(manifest.files)), ...parts].map(name => runtimePrefix + name);
}

function gitByteRoundTrip(autocrlf: 'false' | 'true' | 'input', omit?: 'lf' | 'raw') {
  const started = performance.now();
  // No inherited index/worktree/config, global attributes, hooks or templates may reach the real repository.
  const tempRoot = join(root, 'scratchpad/temp');
  mkdirSync(tempRoot, { recursive: true });
  const fixture = mkdtempSync(join(tempRoot, 'fem-source-bytes-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(fixture, 'empty-config') });
  const git = (args: string[], input?: string) => execFileSync('git', ['--no-optional-locks',
    '-c', 'core.autocrlf=' + autocrlf, '-c', 'core.safecrlf=false', '-c', 'core.eol=crlf',
    '-c', 'core.attributesFile=' + join(fixture, 'empty-config'), ...args],
  { cwd: fixture, env, input, maxBuffer: 4 * 1024 * 1024, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    writeFileSync(join(fixture, 'empty-config'), '');
    git(['init', '--quiet', '--template=']);
    const manifestFiles = record(json('../runtime/manifest.json').files);
    const notices = Object.keys(manifestFiles).filter(name => name.startsWith('notices/'))
      .map(name => ({ name, data: bytes('../runtime/' + name) })).sort((a, b) => a.data.length - b.data.length);
    const lfNotice = notices.find(row => row.data.includes(10) && !row.data.includes(13));
    const crlfNotice = notices.find(row => row.data.includes(13));
    if (!lfNotice || !crlfNotice) throw new Error('Need real LF and CRLF upstream notices');
    // Exercise real small originals and generated text; all large runtime pins are checked separately below.
    const rawPaths = [runtimePrefix + lfNotice.name, runtimePrefix + crlfNotice.name,
      runtimePrefix + 'assets/beamAnalysis.py', runtimePrefix + 'manifest.json',
      runtimePrefix + 'evidence/application-source-index.json', 'LICENSE',
      'vendor/opencascade/opencascade.js-b5ff984-closed-0839d9bcc8ac4677/LICENSE'];
    const originals = new Map([...indexedSources, ...rawPaths].map(name => [name, readFileSync(join(root, name))]));
    for (const name of ['.gitattributes', runtimePrefix + '.gitattributes']) {
      const lines = readFileSync(join(root, name), 'utf8').split(/(?<=\n)/u);
      const attributes = lines.filter(line => !(omit === 'lf' && line.includes(' text eol=lf'))
        && !(omit === 'raw' && line.includes('-text'))).join('');
      mkdirSync(dirname(join(fixture, name)), { recursive: true });
      writeFileSync(join(fixture, name), attributes);
    }
    for (const [name, data] of originals) {
      mkdirSync(dirname(join(fixture, name)), { recursive: true });
      writeFileSync(join(fixture, name), data);
    }
    git(['add', '--', '.gitattributes', runtimePrefix + '.gitattributes', ...originals.keys()]);
    const savedDifferences: string[] = [], checkoutDifferences: string[] = [];
    for (const [name, data] of originals) {
      const saved = git(['show', ':' + name]);
      if (!saved.equals(data) || pin(saved).sha256 !== pin(data).sha256) savedDifferences.push(name);
      unlinkSync(join(fixture, name));
    }
    git(['checkout-index', '--all']);
    const sourcePins = record(json('../runtime/evidence/application-source-index.json').files);
    for (const [name, data] of originals) {
      const restored = readFileSync(join(fixture, name));
      if (!restored.equals(data) || pin(restored).sha256 !== pin(data).sha256) checkoutDifferences.push(name);
      if (!omit) {
        if (indexedSources.includes(name)) {
          expect(restored.includes(13), name + ' must remain LF').toBe(false);
          const row = record(sourcePins[name]);
          expect(pin(restored), name).toEqual({ sha256: row.sha256, bytes: row.bytes });
        } else if (name.startsWith(runtimePrefix) && name !== runtimePrefix + 'manifest.json') {
          expect(pin(restored), name).toEqual(manifestFiles[name.slice(runtimePrefix.length)]);
        }
      }
    }
    const paths = [...new Set([...indexedSources, ...rawPaths, ...runtimePaths()])];
    const attributes = git(['check-attr', '-z', '--stdin', 'text', 'eol'], paths.join('\0') + '\0')
      .toString('utf8').split('\0');
    const attrs = new Map<string, Record<string, string>>();
    for (let i = 0; i + 2 < attributes.length; i += 3) {
      const name = attributes[i], attribute = attributes[i + 1], value = attributes[i + 2];
      attrs.set(name, { ...attrs.get(name), [attribute]: value });
    }
    return { savedDifferences, checkoutDifferences, attrs, rawPaths,
      measured: { autocrlf, sourceFiles: indexedSources.length, rawFiles: rawPaths.length,
        inputBytes: [...originals.values()].reduce((sum, data) => sum + data.length, 0),
        runtimeAttributePaths: runtimePaths().length, durationMs: Math.round(performance.now() - started) } };
  } finally {
    // fixture is created under PointerCAD and contains no symlinks or worktrees.
    rmSync(fixture, { recursive: true, force: true });
  }
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
    for (const name of indexedSources) {
      const row = record(sources[name]);
      expect({ sha256: row.sha256, bytes: row.bytes }).toEqual(pin(readFileSync(join(root, name))));
    }
    const config = record(sources['packages/fem/vitest.config.ts']);
    expect({ sha256: config.sha256, bytes: config.bytes }).toEqual(pin(bytes('../vitest.config.ts')));
    expect(runtime.nativeRebuildExecuted).toBe(true);
    expect(runtime.correspondingSourceComplete).toBe(false);
    expect(index.nativeRebuildExecuted).toBe(false);
    expect(index.correspondingSourceComplete).toBe(false);
  });

  it.each(['false', 'true', 'input'] as const)('preserves source and original bytes through real Git with autocrlf=%s', mode => {
    const result = gitByteRoundTrip(mode);
    expect(result.savedDifferences).toEqual([]);
    expect(result.checkoutDifferences).toEqual([]);
    for (const name of indexedSources) expect(result.attrs.get(name), name).toEqual({ text: 'set', eol: 'lf' });
    for (const name of new Set([...runtimePaths(), ...result.rawPaths])) {
      expect(result.attrs.get(name)?.text, name).toBe('unset');
    }
    console.info('FEM Git byte contract ' + JSON.stringify(result.measured));
  });

  it.each(['lf', 'raw'] as const)('detects real byte corruption when %s attributes are removed in the isolated fixture', omit => {
    const result = gitByteRoundTrip('true', omit);
    const differences = [...result.savedDifferences, ...result.checkoutDifferences];
    if (omit === 'lf') expect(differences).toEqual(expect.arrayContaining(indexedSources));
    else {
      expect(differences).toContain(runtimePrefix + 'assets/beamAnalysis.py');
      expect(differences).toContain(runtimePrefix + 'evidence/application-source-index.json');
      expect(differences.some(name => name.startsWith(runtimePrefix + 'notices/'))).toBe(true);
    }
  });

  it('matches every runtime file and stored part against its unmodified byte pin', () => {
    const manifest = json('../runtime/manifest.json'), stored = record(manifest.storedParts);
    let totalBytes = 0;
    for (const [name, expected] of Object.entries(record(manifest.files))) {
      const parts = stored[name], hash = createHash('sha256');
      let size = 0;
      if (parts === undefined) {
        const data = bytes('../runtime/' + name);
        hash.update(data); size = data.length;
      } else {
        if (!Array.isArray(parts)) throw new Error('Expected stored parts');
        for (const value of parts) {
          const part = record(value);
          if (typeof part.file !== 'string') throw new Error('Expected stored part path');
          const data = bytes('../runtime/' + part.file);
          expect(pin(data), part.file).toEqual({ sha256: part.sha256, bytes: part.bytes });
          hash.update(data); size += data.length;
        }
      }
      expect({ sha256: hash.digest('hex'), bytes: size }, name).toEqual(expected);
      totalBytes += size;
    }
    console.info('FEM runtime byte pins ' + JSON.stringify({ files: Object.keys(record(manifest.files)).length, totalBytes }));
  });
});
