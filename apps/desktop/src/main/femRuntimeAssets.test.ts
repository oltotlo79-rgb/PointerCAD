import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertFemApplicationBuildInputs, assertFemDistributionPublishable, buildFemRuntimeAssets, collectFemRuntimeAssets, joinStoredParts,
  nativeRebuildEvidenceGaps, readFemDistributionGaps } from '../../../../scripts/vite/femRuntimeAssets.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const pin = (bytes: Buffer) => ({ bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
function fixture() {
  const files = new Map([['assets/runtime.js', Buffer.from('fixed')], ['notices/license.txt', Buffer.from('Original notice')]]);
  const manifest = { format: 'pointercad-fem-distribution/1', unresolved: ['rebuild unqualified'],
    components: ['first', 'second', 'third', 'fourth'].map(name => ({ name, version: '1', notices: ['notices/license.txt'] })),
    files: Object.fromEntries([...files].map(([name, bytes]) => [name, pin(bytes)])) };
  return { files, manifest };
}

function applicationFixture() {
  const { files, manifest } = fixture();
  const inputs = new Map(Object.entries({"package.json": "{\"name\":\"external-build-fixture\"}\n", "pnpm-lock.yaml": "vite: 8.2.4\n", "pnpm-workspace.yaml": "catalog:\n  vite: 8.2.4\n"}).map(([name, text]) => [name, Buffer.from(text)]));
  const archive = Buffer.from('UEsDBBQAAAAIAAAAIQB7yaAsJAAAACIAAAAMAAAAcGFja2FnZS5qc29uq1bKS8xNVbJSSq0oSS3KS8zRTSrNzEnRTcusKCktSlWq5QIAUEsDBBQAAAAIAAAAIQBqiAsMDgAAAAwAAAAOAAAAcG5wbS1sb2NrLnlhbWwryyxJtVKw0DPSM+ECAFBLAwQUAAAACAAAACEA51oihBkAAAAXAAAAEwAAAHBucG0td29ya3NwYWNlLnlhbWxLTixJzMlPt+JSUCjLLEm1UrDQM9Iz4QIAUEsBAhQAFAAAAAgAAAAhAHvJoCwkAAAAIgAAAAwAAAAAAAAAAAAAAIABAAAAAHBhY2thZ2UuanNvblBLAQIUABQAAAAIAAAAIQBqiAsMDgAAAAwAAAAOAAAAAAAAAAAAAACAAU4AAABwbnBtLWxvY2sueWFtbFBLAQIUABQAAAAIAAAAIQDnWiKEGQAAABcAAAATAAAAAAAAAAAAAACAAYgAAABwbnBtLXdvcmtzcGFjZS55YW1sUEsFBgAAAAADAAMAtwAAANIAAAAAAA==', 'base64');
  const applicationSource = { archive: 'sources/application.zip', index: 'evidence/application.json' };
  const index = Buffer.from(JSON.stringify({ archiveSha256: pin(archive).sha256,
    files: Object.fromEntries([...inputs].map(([name, bytes]) => [name, pin(bytes)])) }));
  files.set(applicationSource.archive, archive); files.set(applicationSource.index, index);
  manifest.files[applicationSource.archive] = pin(archive); manifest.files[applicationSource.index] = pin(index);
  return { distribution: buildFemRuntimeAssets({ ...manifest, applicationSource }, files), inputs };
}

describe('FEM application source versus explicit build inputs', () => {
  it('accepts an independent build with matching archived inputs, without consulting the live checkout', () => {
    const { distribution, inputs } = applicationFixture();
    expect(() => assertFemApplicationBuildInputs(distribution, inputs)).not.toThrow();
  });
  it('accepts equivalent LF, CRLF and mixed checkout line endings', () => {
    const { distribution, inputs } = applicationFixture();
    for (const [name, bytes] of inputs) inputs.set(name, Buffer.from(bytes.toString().replaceAll('\n', '\r\n')));
    inputs.set('pnpm-workspace.yaml', Buffer.from('catalog:\r\n  vite: 8.2.4\n'));
    expect(() => assertFemApplicationBuildInputs(distribution, inputs)).not.toThrow();
  });
  it.each(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])('rejects stale archived %s against the actual build', name => {
    const { distribution, inputs } = applicationFixture();
    inputs.set(name, Buffer.from('changed build input\n'));
    expect(() => assertFemApplicationBuildInputs(distribution, inputs)).toThrow('does not match build input: ' + name);
  });
  it.each(['missing', 'extra'])('rejects %s explicit build input coverage', reason => {
    const { distribution, inputs } = applicationFixture();
    if (reason === 'missing') inputs.delete('pnpm-lock.yaml');
    else inputs.set('unrelated.json', Buffer.from('{}'));
    expect(() => assertFemApplicationBuildInputs(distribution, inputs)).toThrow('Exactly three');
  });
  it('rejects changed archive bytes even when explicit build inputs still match the index', () => {
    const { distribution, inputs } = applicationFixture();
    distribution.assets.set('licenses/fem/sources/application.zip', Buffer.from('changed archive'));
    expect(() => assertFemApplicationBuildInputs(distribution, inputs)).toThrow('source part differs');
  });
});

describe('fixed local FEM distribution proposal', () => {
  it('ships the exact 24 pinned runtime asset files and preserves unresolved publication conditions', () => {
    const distribution = collectFemRuntimeAssets(join(root, 'packages/fem/runtime'));
    expect([...distribution.assets.keys()].filter(name => name.startsWith('fem/assets/')).sort()).toEqual([
      'fem/assets/beamAnalysis.py',
      'fem/assets/beamBoltContact.py',
      'fem/assets/beamContact.py',
      'fem/assets/beamImpact.py',
      'fem/assets/beamJointContact.py',
      'fem/assets/beamJointInitialStrain.py',
      'fem/assets/beamProof.py',
      'fem/assets/beamWeldContact.py',
      'fem/assets/netgenMesher.py',
      'fem/assets/netgen_mesher-6.2.2606.post5.dev0-cp313-cp313-pyodide_2025_0_wasm32.whl',
      'fem/assets/numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl',
      'fem/assets/oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl',
      'fem/assets/package.json',
      'fem/assets/plasticBarAnalysis.py',
      'fem/assets/pyodide-lock.json',
      'fem/assets/pyodide.asm.js',
      'fem/assets/pyodide.asm.wasm',
      'fem/assets/pyodide.mjs',
      'fem/assets/python_stdlib.zip',
      'fem/assets/solidAnalysis.py',
      'fem/assets/solidBuckling.py',
      'fem/assets/solidModal.py',
      'fem/assets/solidPlasticAnalysis.py',
      'fem/assets/test_2.py',
    ]);
    // Exactly the pinned notice set is emitted: no notice is dropped or added by the collector.
    const emitted = distribution.assets.get('licenses/fem/manifest.json');
    if (emitted === undefined) throw new Error('Missing distribution manifest');
    const pinned = Object.keys((JSON.parse(emitted.toString()) as { files: Record<string, unknown> }).files).filter(name => name.startsWith('notices/'));
    expect(pinned.length).toBeGreaterThan(0);
    expect([...distribution.assets.keys()].filter(name => name.startsWith('licenses/fem/notices/')).sort())
      .toEqual(pinned.map(name => 'licenses/fem/' + name).sort());
    expect(distribution.assets.has('licenses/fem/manifest.json')).toBe(true);
    expect(distribution.assets.get('licenses/fem/index.html')?.toString()).toContain('oofem 3.1.dev5+g214b161ed');
    expect([...distribution.assets.values()].every(bytes => bytes.byteLength <= 25 * 1024 * 1024)).toBe(true);
    expect(readFemDistributionGaps(join(root, 'packages/fem/runtime')))
      .not.toContain('FEM: native rebuild and replacement remain unqualified');
    expect(() => assertFemDistributionPublishable(distribution)).toThrow('Unresolved FEM distribution');
  });

  it.each(['missing', 'changed', 'extra', 'case', 'escape', 'notice'] as const)(
    'refuses %s before emitting executable assets', reason => {
      const { files, manifest } = fixture();
      if (reason === 'missing') files.delete('assets/runtime.js');
      if (reason === 'changed') files.set('assets/runtime.js', Buffer.from('Fixed'));
      if (reason === 'extra') files.set('assets/extra.js', Buffer.from('extra'));
      if (reason === 'case' || reason === 'escape') {
        const name = reason === 'case' ? 'assets/RUNTIME.js' : 'assets/../other.js';
        const data = Buffer.from('extra');
        files.set(name, data); manifest.files[name] = pin(data);
      }
      if (reason === 'notice') manifest.components[0].notices = ['notices/missing.txt'];
      expect(() => buildFemRuntimeAssets(manifest, files)).toThrow();
    },
  );

  it('accepts the three-component runtime (oofem, numpy, Pyodide) and refuses fewer components', () => {
    const { files, manifest } = fixture();
    manifest.components = manifest.components.slice(0, 3);
    expect(buildFemRuntimeAssets(manifest, files).assets.has('licenses/fem/manifest.json')).toBe(true);
    manifest.components = manifest.components.slice(0, 2);
    expect(() => buildFemRuntimeAssets(manifest, files)).toThrow('Invalid FEM distribution inventory');
  });

  it('ships an explicitly pinned empty upstream notice and refuses its absence or changed bytes', () => {
    const { files, manifest } = fixture();
    const name = 'notices/empty-upstream.txt', bytes = Buffer.alloc(0);
    files.set(name, bytes); manifest.files[name] = pin(bytes);
    manifest.components[0].notices.push(name);
    const distribution = buildFemRuntimeAssets(manifest, files);
    const output = 'licenses/fem/' + name;
    expect(distribution.assets.has(output)).toBe(true);
    expect(distribution.assets.get(output)).toEqual(bytes);
    const encoded = distribution.assets.get('licenses/fem/manifest.json');
    if (encoded === undefined) throw new Error('Missing distribution manifest');
    const emitted: unknown = JSON.parse(encoded.toString());
    expect(emitted).toMatchObject({ files: { [name]: { ...pin(bytes),
      parts: [{ file: output, bytes: 0, sha256: pin(bytes).sha256 }] } } });
    files.delete(name);
    expect(() => buildFemRuntimeAssets(manifest, files)).toThrow('FEM distribution inventory changed');
    files.set(name, Buffer.from('invented text'));
    expect(() => buildFemRuntimeAssets(manifest, files)).toThrow('FEM distribution input changed');
  });

  it('does not admit an empty executable asset as an empty notice', () => {
    const { files, manifest } = fixture();
    files.set('assets/runtime.js', Buffer.alloc(0));
    manifest.files['assets/runtime.js'] = pin(Buffer.alloc(0));
    expect(() => buildFemRuntimeAssets(manifest, files)).toThrow('FEM distribution input changed');
  });

  it('splits source material losslessly below offline file limits and records each part digest', () => {
    const { files, manifest } = fixture();
    const source = Buffer.alloc(17 * 1024 * 1024, 37);
    files.set('sources/source.zip', source); manifest.files['sources/source.zip'] = pin(source);
    const distribution = buildFemRuntimeAssets(manifest, files);
    const first = distribution.assets.get('licenses/fem/sources/source.zip.part-001');
    const second = distribution.assets.get('licenses/fem/sources/source.zip.part-002');
    expect(first?.byteLength).toBe(16 * 1024 * 1024);
    expect(second?.byteLength).toBe(1024 * 1024);
    if (first === undefined || second === undefined) throw new Error('Missing source part');
    const joined = Buffer.concat([first, second]);
    // Deep equality enumerates millions of Buffer keys; compare all bytes without materializing those arrays.
    expect(joined.byteLength).toBe(source.byteLength);
    expect(Buffer.compare(joined, source)).toBe(0);
    expect(pin(joined)).toEqual(pin(source));
    expect(first[0]).toBe(37); expect(first[first.byteLength - 1]).toBe(37);
    expect(second[0]).toBe(37); expect(second[second.byteLength - 1]).toBe(37);
    const changedBoundary = Buffer.from(joined);
    changedBoundary[first.byteLength] = 38;
    expect(Buffer.compare(changedBoundary, source)).not.toBe(0);
    expect(pin(changedBoundary).sha256).not.toBe(pin(source).sha256);
    const emitted = distribution.assets.get('licenses/fem/manifest.json')?.toString() ?? '';
    expect(emitted).toContain(pin(first).sha256);
    expect(emitted).toContain(pin(second).sha256);
  });
});

describe('nativeRebuildExecuted counts only with pinned rebuild and replacement evidence', () => {
  const digestOf = (text: string) => createHash('sha256').update(text).digest('hex');
  const commit = 'a'.repeat(40), oofemName = `sources/051-oofem-${commit}.tar.gz`, pybindName = `sources/026-pybind11-${'b'.repeat(40)}.tar.gz`;
  function chain() {
    const shipped = new Map([[oofemName, Buffer.from('oofem source')], [pybindName, Buffer.from('pybind11 source')],
      ['sources/native-rebuild/one.patch', Buffer.from('patch')], ['assets/oofem-3.0-test.whl', Buffer.from('shipped wheel')]]);
    const shaOf = (name: string) => {
      const bytes = shipped.get(name);
      if (bytes === undefined) throw new Error('Missing fixture ' + name);
      return pin(bytes).sha256;
    };
    const modifiedWheel = digestOf('modified wheel'), modifiedModule = digestOf('modified module'), shippedModule = digestOf('shipped module');
    const provenance = { originalSource: { commit, oofemTarballSha256: shaOf(oofemName), pybind11TarballSha256: shaOf(pybindName) },
      patches: [{ file: 'one.patch', sha256: shaOf('sources/native-rebuild/one.patch') }],
      output: { wheelSha256: shaOf('assets/oofem-3.0-test.whl'), moduleSha256: shippedModule } };
    const evidence = { format: 'pointercad-oofem-native-replacement-evidence/1',
      shippedWheelSha256: shaOf('assets/oofem-3.0-test.whl'), shippedModuleSha256: shippedModule,
      inputs: { oofemCommit: commit, oofemSourceSha256: shaOf(oofemName), pybind11SourceSha256: shaOf(pybindName),
        patches: [{ file: 'one.patch', sha256: shaOf('sources/native-rebuild/one.patch') }] },
      rebuild: { passed: true, wheelSha256: modifiedWheel, moduleSha256: modifiedModule, receiptSha256: digestOf('build'), memberNamesIdentical: true },
      replacement: { wheelSha256: modifiedWheel, moduleSha256: modifiedModule, receiptSha256: digestOf('qualification'),
        cases: ['modified-accepted', 'original-refused', 'same-size-refused'].map(id => ({ id, passed: true })) } };
    return { shipped, provenance, evidence, shippedModule };
  }
  type Chain = ReturnType<typeof chain>;
  function gaps(change: (value: Chain) => void = () => undefined, tamper = false): string[] {
    const value = chain();
    change(value);
    const files = new Map(value.shipped);
    files.set('sources/native-rebuild/build-provenance.json', Buffer.from(JSON.stringify(value.provenance)));
    files.set('sources/native-rebuild/replacement-evidence.json', Buffer.from(JSON.stringify(value.evidence)));
    const manifest = { oofemSourceCommit: commit, files: Object.fromEntries([...files].map(([name, bytes]) => [name, pin(bytes)])) };
    if (tamper) files.set('sources/native-rebuild/replacement-evidence.json', Buffer.from(JSON.stringify({ ...value.evidence, scope: 'changed after pinning' })));
    return nativeRebuildEvidenceGaps(manifest, files);
  }

  it('accepts the complete chain and refuses evidence changed after it was pinned', () => {
    expect(gaps()).toEqual([]);
    expect(gaps(undefined, true)).toEqual(['FEM: native rebuild evidence is absent or not pinned']);
  });

  const negative: [string, (value: Chain) => void, string][] = [
    ['another OOFEM source', value => { value.evidence.inputs.oofemSourceSha256 = digestOf('other source'); }, 'does not use the shipped OOFEM source'],
    ['another pybind11 source', value => { value.evidence.inputs.pybind11SourceSha256 = digestOf('other'); }, 'does not use the shipped pybind11 source'],
    ['an unshipped extra patch', value => { value.evidence.inputs.patches.push({ file: 'two.patch', sha256: digestOf('two') }); },
      'does not apply exactly the shipped patches'],
    ['another shipped wheel', value => { value.evidence.shippedWheelSha256 = digestOf('other wheel'); }, 'is not bound to the shipped oofem wheel'],
    ['the unmodified shipped module', value => {
      value.evidence.rebuild.moduleSha256 = value.shippedModule; value.evidence.replacement.moduleSha256 = value.shippedModule;
    }, 'does not record a passed modified rebuild'],
    ['a missing size refusal', value => {
      value.evidence.replacement.cases = value.evidence.replacement.cases.filter(item => item.id !== 'original-refused');
    }, 'does not record the product-loader replacement'],
    ['a failed acceptance', value => {
      const [first] = value.evidence.replacement.cases;
      if (first !== undefined) first.passed = false;
    }, 'does not record the product-loader replacement'],
    ['a legal clearance claim', value => { Object.assign(value.evidence, { legalClearance: true }); }, 'must not carry a legal clearance'],
  ];
  it.each(negative)('keeps the gap for %s', (_name, change, reason) => {
    expect(gaps(change)).toEqual(['FEM: native rebuild evidence ' + reason]);
  });

  it('no longer lets a bare true flag silence the release gap', () => {
    const folder = mkdtempSync(join(tmpdir(), 'pcad-fem-native-'));
    try {
      writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ format: 'pointercad-fem-distribution/1', unresolved: [],
        correspondingSourceComplete: true, nativeRebuildExecuted: true, files: {} }));
      expect(readFemDistributionGaps(folder)).toEqual(['FEM: native rebuild evidence is absent or not pinned']);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  it('accepts the retained oofem proof while preserving legal and source blockers', () => {
    const folder = join(root, 'packages/fem/runtime');
    const manifest: unknown = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
    const files = new Map(['sources/native-rebuild/replacement-evidence.json', 'sources/native-rebuild/build-provenance.json']
      .map(name => [name, readFileSync(join(folder, name))] as const));
    expect(nativeRebuildEvidenceGaps(manifest, files)).toEqual([]);
    expect(manifest).toMatchObject({ nativeRebuildExecuted: true, legalClearance: false, correspondingSourceComplete: false });
    expect(readFemDistributionGaps(folder)).not.toContain('FEM: native rebuild and replacement remain unqualified');
    expect(readFemDistributionGaps(folder)).toContain('FEM: corresponding source closure is incomplete');
  });
});

describe('oversized source material stored in the repository as pinned parts', () => {
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  type StoredPart = { file: string; bytes: number; sha256: string };
  function stored(sizes: number[]) {
    const { files, manifest } = fixture();
    const total = sizes.reduce((sum, size) => sum + size, 0);
    const whole = Buffer.from(Array.from({ length: total }, (_, index) => (index * 7 + 3) % 251));
    const name = 'sources/big.zip';
    let offset = 0;
    const parts: StoredPart[] = sizes.map((size, index) => {
      const bytes = Buffer.from(whole.subarray(offset, offset + size));
      offset += size;
      const file = `${name}.stored-${String(index + 1).padStart(3, '0')}`;
      files.set(file, bytes);
      return { file, bytes: size, sha256: sha(bytes) };
    });
    const pins: Record<string, { bytes: number; sha256: string }> = { ...manifest.files, [name]: pin(whole) };
    const storedParts: Record<string, StoredPart[]> = { [name]: parts };
    return { files, whole, name, parts, plain: { ...manifest, files: pins }, manifest: { ...manifest, files: pins, storedParts } };
  }

  it('rebuilds the exact original and emits the same distribution bytes as the whole file', () => {
    const value = stored([5, 7, 3]);
    const joined = joinStoredParts(value.manifest, value.files);
    const rebuilt = joined.files.get(value.name);
    if (rebuilt === undefined) throw new Error('Missing rebuilt source');
    expect(Buffer.compare(rebuilt, value.whole)).toBe(0);
    expect([...joined.files.keys()].filter(name => name.includes('.stored-'))).toEqual([]);
    expect(joined.manifest).toEqual(value.plain);
    const wholeFiles = new Map([...value.files].filter(([name]) => !name.includes('.stored-')));
    wholeFiles.set(value.name, value.whole);
    const fromParts = buildFemRuntimeAssets(joined.manifest, joined.files);
    const fromWhole = buildFemRuntimeAssets(value.plain, wholeFiles);
    expect([...fromParts.assets.keys()].sort()).toEqual([...fromWhole.assets.keys()].sort());
    for (const [file, bytes] of fromWhole.assets) {
      const other = fromParts.assets.get(file);
      if (other === undefined) throw new Error('Missing emitted asset ' + file);
      expect(Buffer.compare(other, bytes), file).toBe(0);
    }
    expect(fromParts.assets.get('licenses/fem/manifest.json')?.toString()).not.toContain('storedParts');
  });

  it('returns single-file inputs unchanged when no stored parts are declared', () => {
    const { files, manifest } = fixture();
    const joined = joinStoredParts(manifest, files);
    expect(joined.manifest).toBe(manifest);
    expect(joined.files).toBe(files);
  });

  const rejected: [string, (value: ReturnType<typeof stored>) => void, string][] = [
    ['a missing part', value => { value.files.delete(`${value.name}.stored-002`); }, 'Stored FEM part changed'],
    ['a changed part', value => {
      const bytes = value.files.get(`${value.name}.stored-002`);
      if (bytes === undefined) throw new Error('Missing fixture part');
      const changed = Buffer.from(bytes); changed.writeUInt8(changed.readUInt8(0) ^ 1, 0);
      value.files.set(`${value.name}.stored-002`, changed);
    }, 'Stored FEM part changed'],
    ['reordered parts', value => { value.parts.reverse(); }, 'Stored FEM part changed'],
    ['a duplicated part', value => { const [first] = value.parts; if (first !== undefined) value.parts[1] = { ...first }; }, 'Stored FEM part changed'],
    ['an unlisted extra part', value => { value.files.set(`${value.name}.stored-004`, Buffer.from('extra')); }, 'Unlisted stored FEM part'],
    ['a traversal part path', value => {
      const [first] = value.parts;
      if (first !== undefined) value.parts[0] = { ...first, file: 'sources/../big.zip.stored-001' };
    }, 'Stored FEM part changed'],
    ['the whole file next to its parts', value => { value.files.set(value.name, value.whole); }, 'mixed with the whole file'],
    ['a single listed part', value => { value.parts.splice(1); }, 'Invalid stored FEM parts'],
    ['an extra field on a part', value => {
      const [first] = value.parts;
      if (first !== undefined) value.parts[0] = Object.assign({ ...first }, { note: 'x' });
    }, 'Stored FEM part changed'],
    ['a different original pin', value => {
      value.manifest.files[value.name] = { bytes: value.whole.byteLength, sha256: sha(Buffer.from('other')) };
    }, 'do not rebuild the original'],
  ];
  it.each(rejected)('refuses %s before any distribution is built', (_label, change, message) => {
    const value = stored([5, 7, 3]);
    change(value);
    expect(() => joinStoredParts(value.manifest, value.files)).toThrow(message);
  });

  it('refuses a stored part when no stored parts are declared', () => {
    const { files, manifest } = fixture();
    files.set('sources/big.zip.stored-001', Buffer.from('orphan'));
    expect(() => joinStoredParts(manifest, files)).toThrow('Unlisted stored FEM part');
  });

  it('rebuilds the real upstream source archive from its two stored parts below the Git file limit', () => {
    const folder = join(root, 'packages/fem/runtime');
    const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as {
      files: Record<string, { bytes: number; sha256: string }>; storedParts?: Record<string, StoredPart[]> };
    const name = 'sources/upstream-source-materials.zip';
    const parts = manifest.storedParts?.[name] ?? [];
    expect(Object.keys(manifest.storedParts ?? {})).toEqual([name]);
    expect(parts.map(part => part.file)).toEqual([`${name}.stored-001`, `${name}.stored-002`]);
    expect(parts.every(part => part.bytes <= 64 * 1024 * 1024)).toBe(true);
    const original = manifest.files[name];
    if (original === undefined) throw new Error('Missing original pin');
    expect(parts.reduce((sum, part) => sum + part.bytes, 0)).toBe(original.bytes);
    const distribution = collectFemRuntimeAssets(folder);
    const encoded = distribution.assets.get('licenses/fem/manifest.json');
    if (encoded === undefined) throw new Error('Missing distribution manifest');
    const shipped = JSON.parse(encoded.toString()) as { storedParts?: unknown; files: Record<string, { parts: { file: string }[] }> };
    expect(shipped.storedParts).toBeUndefined();
    const emitted = shipped.files[name]?.parts ?? [];
    expect(emitted.length).toBeGreaterThan(1);
    const joined = Buffer.concat(emitted.map(part => {
      const bytes = distribution.assets.get(part.file);
      if (bytes === undefined) throw new Error('Missing emitted part ' + part.file);
      return bytes;
    }));
    expect(joined.byteLength).toBe(original.bytes);
    expect(sha(joined)).toBe(original.sha256);
  });
});
