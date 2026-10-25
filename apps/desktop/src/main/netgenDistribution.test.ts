import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectFemRuntimeAssets, readFemDistributionGaps } from '../../../../scripts/vite/femRuntimeAssets.mjs';
import { femComponentsFromDistribution } from '../../../../scripts/release/sbom.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
type Component = ReturnType<typeof femComponentsFromDistribution>[number];
const byName = (components: readonly Component[], name: string) => components.find(item => item.name === name);

describe('Netgen exact retained distribution source', () => {
  it('Netgen retained source maps all four actual modules and exact headers without granting unresolved permission', () => {
    const distribution = collectFemRuntimeAssets(join(root, 'packages/fem/runtime'));
    const components = femComponentsFromDistribution(distribution);
    const mapName = 'licenses/fem/evidence/netgen-build-source-map.json';
    const original = distribution.assets.get(mapName);
    const manifestBytes = distribution.assets.get('licenses/fem/manifest.json');
    if (!original || !manifestBytes) throw new Error('Expected Netgen retained evidence');
    interface Module { member: string; sha256: string; bytes: number; needed: string[] }
    interface Permission { referenceTag: string; normalizedSha256: string; referenceIsUniqueOriginVersion: boolean }
    interface Member { sha256: string; byteIdentical: boolean; permissionStatus?: string; permissionEvidence?: Permission }
    interface Dependency { name: string; type: string; source: { path: string; sha256: string }; sourceMember?: Member }
    interface Evidence { modules: Module[]; embeddedDependencies: Dependency[]; headerSourceCorrespondence: Member[] }
    const evidence = JSON.parse(original.toString('utf8')) as Evidence;
    expect(evidence.modules.map(row => row.member)).toEqual(['libngcore.so', 'libnglib.so', 'netgen/libngpy.so', 'pyngcore/pyngcore.so']);
    expect(evidence.modules[3]).toEqual({ member: 'pyngcore/pyngcore.so', sha256: 'f6f942536567085cc1bc6b19c974c5898d38a8b0f9ef5235ee9f3b72958abb29', bytes: 1014952, needed: ['libngcore.so'] });
    expect(evidence.headerSourceCorrespondence.map(row => row.sha256)).toEqual([
      'cc8dc5c0d9c3ca1b37d4051bff9de96ceeccb53b77472b78c453da324ba0909e',
      'f9555dfd54b4311a6209c35d669cad3600ac663fdc48b80e31b6dcb54e0326b9',
      '022ec87d2a2dc2bcf0bc1961560477f3d532eff33df6ba2f8edd48f4abf39cb8',
    ]);
    expect(evidence.headerSourceCorrespondence.every(row => row.byteIdentical)).toBe(true);
    expect(byName(components, 'FEM: Netgen pybind11')?.version).toBe('98e50b702d9ab784ec918399aaa20adcfd1af9a9');
    expect(byName(components, 'FEM: Netgen zlib')?.version).toBe('1.3.1');
    for (const name of ['FEM: Netgen pybind11', 'FEM: Netgen zlib', 'FEM: Netgen concurrentqueue', 'FEM: Netgen gzstream']) {
      expect(byName(components, name)?.properties).toContainEqual({ name: 'pointercad:licenseStatus', value: 'unclassified' });
      expect(byName(components, name)?.licenses).toBeUndefined();
    }
    const mpi4py = byName(components, 'FEM: Netgen mpi4py header');
    expect(mpi4py?.licenses).toEqual([{ license: { id: 'BSD-3-Clause' } }]);
    expect(mpi4py?.version).toBeUndefined();
    expect(mpi4py?.properties).toContainEqual({ name: 'pointercad:licenseStatus', value: 'classified' });
    const changed = (edit: (copy: Evidence) => void) => {
      const copy = structuredClone(evidence);
      edit(copy);
      const raw = Buffer.from(JSON.stringify(copy));
      const manifest = JSON.parse(manifestBytes.toString('utf8')) as { files: Record<string, { sha256: string; bytes: number; parts: { file: string; sha256: string; bytes: number }[] }> };
      const hash = createHash('sha256').update(raw).digest('hex');
      manifest.files['evidence/netgen-build-source-map.json'] = { sha256: hash, bytes: raw.length, parts: [{ file: mapName, sha256: hash, bytes: raw.length }] };
      const assets = new Map(distribution.assets);
      assets.set(mapName, raw);
      assets.set('licenses/fem/manifest.json', Buffer.from(JSON.stringify(manifest)));
      return () => femComponentsFromDistribution({ ...distribution, assets });
    };
    expect(changed(copy => { copy.modules.pop(); })).toThrow('FEM Netgen retained module/dependency evidence differs');
    expect(changed(copy => { copy.modules[3] = { ...copy.modules[0] }; })).toThrow('FEM Netgen retained module/dependency evidence differs');
    expect(changed(copy => { copy.embeddedDependencies[0].source.sha256 = '0'.repeat(64); })).toThrow('FEM Netgen dependency source/notice evidence differs');
    expect(changed(copy => {
      const header = copy.embeddedDependencies.find(row => row.type === 'file');
      if (!header?.sourceMember) throw new Error('Expected mpi4py source header');
      header.sourceMember.permissionStatus = 'cleared';
    })).toThrow('FEM Netgen shipped header/source evidence differs');
    // Alter both copies of the record, so mirror equality alone cannot pass these controls.
    const forgedPermission = (edit: (proof: Permission) => void) => changed(copy => {
      const header = copy.embeddedDependencies.find(row => row.type === 'file')?.sourceMember;
      const mirror = copy.headerSourceCorrespondence.find(row => row.sha256 === header?.sha256);
      if (!header?.permissionEvidence || !mirror) throw new Error('Expected complete mpi4py correspondence');
      edit(header.permissionEvidence);
      mirror.permissionEvidence = structuredClone(header.permissionEvidence);
    });
    expect(forgedPermission(proof => { proof.referenceTag = '3.1.6'; })).toThrow('FEM Netgen mpi4py permission correspondence differs');
    expect(forgedPermission(proof => { proof.normalizedSha256 = '0'.repeat(64); })).toThrow('FEM Netgen mpi4py permission correspondence differs');
    expect(forgedPermission(proof => { proof.referenceIsUniqueOriginVersion = true; })).toThrow('FEM Netgen mpi4py permission correspondence differs');
    const noNotice = new Map(distribution.assets);
    noNotice.delete('licenses/fem/notices/915b533dea3bff17c3fca634928176a4d831c69ce99257809637beebc88596b6.txt');
    expect(() => femComponentsFromDistribution({ ...distribution, assets: noNotice })).toThrow('distributed bytes differ');
    const missing = new Map(distribution.assets);
    missing.delete(mapName);
    expect(() => femComponentsFromDistribution({ ...distribution, assets: missing })).toThrow('distributed bytes differ');
  });

  it('FEM の pybind11 部品は source-index の記録が欠けると黙って消えずに止まる', () => {
    const distribution = collectFemRuntimeAssets(join(root, 'packages/fem/runtime'));
    const bytes = distribution.assets.get('licenses/fem/evidence/source-index.json');
    if (!bytes) throw new Error('FEM source-index absent');
    interface Index { buildEvidence: { pybind11Gitlink?: string }; noticeEntries: { source: string; bundlePath: string }[]; materials: { components: string[]; url: string | null }[] }
    const original = JSON.parse(bytes.toString('utf8')) as Index;
    const run = (change: (copy: Index) => void) => {
      const copy = structuredClone(original);
      change(copy);
      const assets = new Map(distribution.assets);
      assets.set('licenses/fem/evidence/source-index.json', Buffer.from(JSON.stringify(copy)));
      return () => femComponentsFromDistribution({ ...distribution, assets });
    };
    // A second pybind version or build recipe must not replace the exact OOFEM gitlink.
    expect(original.materials.filter(item => item.components.includes('pybind11')).length).toBeGreaterThan(1);
    expect(run(copy => {
      copy.materials = copy.materials.filter(item => !String(item.url).endsWith('/' + copy.buildEvidence.pybind11Gitlink));
    })).toThrow('FEM embedded component source missing: pybind11');
    expect(run(copy => {
      const matched = copy.materials.find(item => String(item.url).endsWith('/' + copy.buildEvidence.pybind11Gitlink));
      if (!matched) throw new Error('Expected exact OOFEM source material');
      copy.materials.push(structuredClone(matched));
    })).toThrow('FEM embedded component source missing: pybind11');
    expect(run(copy => { delete copy.buildEvidence.pybind11Gitlink; })).toThrow('FEM embedded component source missing: pybind11');
    expect(run(copy => { copy.buildEvidence.pybind11Gitlink = '0'.repeat(40); })).toThrow('FEM embedded component source missing: pybind11');
    expect(run(copy => { copy.noticeEntries = copy.noticeEntries.filter(entry => !entry.source.endsWith('/pybind11-d6ae0e163a6fb414c81c7f4a98291460e5a18bfe.tar.gz')); }))
      .toThrow('FEM embedded component notice missing: pybind11');
  });

  it('retains all five original distribution barriers and never grants clearance', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'packages/fem/runtime/manifest.json'), 'utf8')) as {
      unresolved: string[]; correspondingSourceComplete: boolean; nativeRebuildExecuted: boolean; legalClearance: boolean;
    };
    expect(manifest.unresolved).toEqual([
      '歴史的なビルド環境と静的に含まれる部品の対応付けは未完了です。',
      'IML の指定ソースの出典・許諾根拠と NIST notice は保持済みです。製品全体の法的確認の完了は主張しません。',
      'ソース提供・差替えの配布条件と製品の条項について法的確認が残っています。',
      '列挙済みの OOFEM・Pyodide・Netgen の部品と保持資料は一覧へ対応付け済みですが、静的・コンパイラー実行時依存と NumPy 内包部品の完全な対応は未完了です。',
    ]);
    expect(manifest.correspondingSourceComplete).toBe(false);
    expect(manifest.nativeRebuildExecuted).toBe(true);
    expect(manifest.legalClearance).toBe(false);
    expect(readFemDistributionGaps(join(root, 'packages/fem/runtime'))).toEqual([
      ...manifest.unresolved.map(item => 'FEM: ' + item), 'FEM: corresponding source closure is incomplete',
    ]);
  });
});
