import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assembleSbomDocument, assertSbomMatchesReleaseManifest, assertSbomPublishable, buildSbom,
  collectSbomComponents, deterministicUuid, findSbomGaps, matchSbomToReleaseManifest, verifyFontAssetParity,
} from '../../../../scripts/release/sbom.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const exactMathManifest = JSON.parse(readFileSync(join(root, 'vendor/exact-math/manifest.json'), 'utf8')) as {
  components: Record<string, string[]>; files: Record<string, unknown>;
};
type SbomComponent = ReturnType<typeof collectSbomComponents>['components'][number];
const byName = (components: readonly SbomComponent[], name: string) => components.find((item) => item.name === name);

describe('配布に含める依存・固定資産の一覧(SBOM)を作る', () => {
  it('直接・推移のnpm依存11件をCycloneDXのlibrary部品として集める', () => {
    const { components } = collectSbomComponents(root);
    for (const name of ['comlink', 'decimal.js', 'fflate', 'mathlive', 'opencascade.js', 'opentype.js', 'react', 'react-dom', 'scheduler', 'three', 'zustand']) {
      const component = byName(components, name);
      expect(component?.type, name).toBe('library');
      expect(component?.purl, name).toBe(`pkg:npm/${name}@${component?.version}`);
      expect(component?.properties?.some((entry) => entry.name === 'pointercad:distributedFile' && entry.value.startsWith(`licenses/runtime/`)), name).toBe(true);
    }
    expect(components.filter((item) => item.type === 'library' && item.purl?.startsWith('pkg:npm/'))).toHaveLength(11);
  });

  it('数式字体20個と数式の追加原文2件を固定資産として集め、既存のnpm部品と二重計上しない', () => {
    const { components } = collectSbomComponents(root);
    const fonts = components.filter((item) => item.type === 'file' && item.name.endsWith('.woff2'));
    expect(fonts).toHaveLength(20);
    for (const font of fonts) {
      expect(font.hashes?.[0]?.alg).toBe('SHA-256');
      expect(font.hashes?.[0]?.content).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(byName(components, 'mathlive-fonts.txt')?.licenses).toEqual([{ license: { id: 'OFL-1.1' } }]);
    expect(byName(components, 'ofl-1.1.txt')).toBeDefined();
    expect(components.filter((item) => item.name === 'decimal.js' || item.name === 'mathlive')).toHaveLength(2);
    const mathlive = byName(components, 'mathlive');
    expect(mathlive?.properties?.filter((entry) => entry.name === 'pointercad:distributedFile')).toHaveLength(2);
  });

  it('自動作図(QuickJS-ng)の原文12件と実行バイナリを集め、出典URLから発行元を機械的に判定する', () => {
    const { components } = collectSbomComponents(root);
    const scriptRuntimeNotices = components.filter((item) => item.externalReferences?.[0]?.url.startsWith('https://raw.githubusercontent.com/'));
    expect(scriptRuntimeNotices).toHaveLength(12);
    expect(scriptRuntimeNotices.some((item) => item.name.startsWith('quickjs-ng ('))).toBe(true);
    expect(scriptRuntimeNotices.some((item) => item.name.startsWith('wasi-libc ('))).toBe(true);
    expect(scriptRuntimeNotices.every((item) => item.licenses?.length === 1)).toBe(true);
    const wasm = byName(components, 'quickjs-pcad.wasm');
    expect(wasm?.hashes?.[0]?.content).toMatch(/^[a-f0-9]{64}$/u);
    // P13-6b: the wasm is compiled from the exact quickjs-ng commit pinned below, so it now
    // carries that notice's confirmed MIT license instead of being reported unclassified.
    expect(wasm?.properties?.some((entry) => entry.name === 'pointercad:licenseStatus')).toBe(false);
    expect(wasm?.licenses).toEqual([{ license: { id: 'MIT' } }]);
  });

  it('自動作図の原文12件は、同梱原文に書かれた組合せだけをSPDX識別子/式として記録する(P13-6b)', () => {
    const { components } = collectSbomComponents(root);
    const named = (file: string) => components.find((item) => item.name.endsWith(`(${file})`));
    // 単一のSPDX識別子(原文がその1つの標準条文とだけ一致するもの)。
    expect(named('quickjs-ng.txt')?.licenses).toEqual([{ license: { id: 'MIT' } }]);
    expect(named('script-wasi-libc-apache.txt')?.licenses).toEqual([{ license: { id: 'Apache-2.0' } }]);
    expect(named('script-wasi-libc-mit.txt')?.licenses).toEqual([{ license: { id: 'MIT' } }]);
    expect(named('script-cloudlibc.txt')?.licenses).toEqual([{ license: { id: 'BSD-2-Clause' } }]);
    expect(named('script-musl.txt')?.licenses).toEqual([{ license: { id: 'MIT' } }]);
    expect(named('script-musl-fts.txt')?.licenses).toEqual([{ license: { id: 'BSD-3-Clause' } }]);
    expect(named('script-dlmalloc.txt')?.licenses).toEqual([{ license: { id: 'CC0-1.0' } }]);
    // SPDX式(原文自身がその組合せを明記しているもの)。
    expect(named('script-wasi-libc-license.txt')?.licenses).toEqual([{ expression: 'Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT' }]);
    expect(named('script-wasi-libc-apache-llvm.txt')?.licenses).toEqual([{ expression: 'Apache-2.0 WITH LLVM-exception' }]);
    expect(named('script-emmalloc.txt')?.licenses).toEqual([{ expression: 'MIT OR NCSA' }]);
    expect(named('script-compiler-rt.txt')?.licenses).toEqual([{ expression: 'NCSA OR MIT' }]);
    expect(named('script-emscripten-license.txt')?.licenses).toEqual([{ expression: 'MIT OR NCSA' }]);
    for (const file of ['quickjs-ng.txt', 'script-wasi-libc-license.txt', 'script-wasi-libc-apache.txt', 'script-wasi-libc-apache-llvm.txt',
      'script-wasi-libc-mit.txt', 'script-cloudlibc.txt', 'script-musl.txt', 'script-musl-fts.txt', 'script-dlmalloc.txt',
      'script-emmalloc.txt', 'script-compiler-rt.txt', 'script-emscripten-license.txt']) {
      expect(named(file)?.properties?.some((entry) => entry.name === 'pointercad:licenseStatus'), file).toBe(false);
    }
  });

  it('追加計算部(Pyodide/SymPy/mpmath等)の21部品と、原文以外の実配布ファイルを集める', () => {
    const { components } = collectSbomComponents(root);
    const grouped = components.filter((item) => item.type === 'library' && Object.hasOwn(exactMathManifest.components, item.name));
    expect(grouped).toHaveLength(21);
    expect(byName(components, 'Pyodide 314.0.6')).toBeDefined();
    const notices = Object.keys(exactMathManifest.files).filter((name) => name.startsWith('notices/')).length;
    const others = Object.keys(exactMathManifest.files).length - notices;
    const ungrouped = components.filter((item) => item.properties?.some((entry) => entry.name === 'pointercad:vendorPath'));
    expect(ungrouped).toHaveLength(others);
    const bigSource = ungrouped.find((item) => item.properties?.some((entry) => entry.value.includes('Python-3.14.2.tgz')));
    expect(bigSource?.properties?.some((entry) => entry.name === 'pointercad:distributedFile')).toBe(false);
  });

  it('追加計算部21件のうち19件は同梱原文と一致するSPDX識別子/式を持ち、2件は未確認のまま残す(P13-6b)', () => {
    const { components } = collectSbomComponents(root);
    const expectedSingle: Record<string, string> = {
      'Pyodide 314.0.6': 'MPL-2.0', 'Hiwire 6a1e67280a15d929ebeceee54a6358c9c8d5f697': 'MPL-2.0', 'CPython 3.14.2': 'PSF-2.0',
      'libffi f08493d249d2067c8b3207ba46693dd858f95db3': 'MIT', 'zlib 1.3.1': 'Zlib', 'bzip2 1.0.6': 'bzip2-1.0.6',
      'zstd 1.5.7': 'BSD-3-Clause', 'musl in Emscripten 5.0.3': 'MIT', 'MiniLZ4 in Emscripten 5.0.3': 'MIT',
      'HACL in CPython 3.14.2': 'MIT', 'libmpdec in CPython 3.14.2': 'BSD-2-Clause', 'Expat in CPython 3.14.2': 'Expat',
      'StackFrame and ErrorStackParser in Pyodide 314.0.6': 'MIT', 'mpmath 1.3.0': 'BSD-3-Clause',
    };
    for (const [name, id] of Object.entries(expectedSingle)) {
      expect(byName(components, name)?.licenses, name).toEqual([{ license: { id } }]);
      expect(byName(components, name)?.properties?.some((entry) => entry.name === 'pointercad:licenseStatus'), name).toBe(false);
    }
    const expectedExpression: Record<string, string> = {
      'Emscripten 5.0.3': 'MIT OR NCSA', 'libc++ in Emscripten 5.0.3': 'NCSA OR MIT', 'libc++abi in Emscripten 5.0.3': 'NCSA OR MIT',
      'compiler-rt in Emscripten 5.0.3': 'NCSA OR MIT', 'sympy 1.14.0': 'BSD-3-Clause AND MIT',
    };
    for (const [name, expression] of Object.entries(expectedExpression)) {
      expect(byName(components, name)?.licenses, name).toEqual([{ expression }]);
    }
    expect(Object.keys(expectedSingle)).toHaveLength(14);
    expect(Object.keys(expectedExpression)).toHaveLength(5);
    for (const name of ['liblzma from XZ 5.2.2', 'SQLite 3.39.0']) {
      expect(byName(components, name)?.licenses, name).toBeUndefined();
      expect(byName(components, name)?.properties?.some((entry) => entry.name === 'pointercad:licenseStatus' && entry.value === 'unclassified'), name).toBe(true);
    }
  });

  it('画面・図面用フォント(Noto Sans JP)を集め、WebとDesktopの内容が一致することを確かめる', () => {
    const files = verifyFontAssetParity(root);
    expect(files.size).toBeGreaterThanOrEqual(2);
    const { components } = collectSbomComponents(root);
    const font = byName(components, 'NotoSansJP-Regular.otf');
    expect(font?.licenses).toEqual([{ license: { id: 'OFL-1.1' } }]);
    expect(font?.properties?.[0]?.value).toMatch(/^fonts\/LICENSES\.txt\|[a-f0-9]{64}$/u);
    // P13-6b: name/version/license/hash now come from the new font-notices.json record.
    expect(font?.version).toBe('Sans2.004');
  });

  it('CycloneDXの文書形状(bomFormat・specVersion・決定的なUUID)を組み立てる', () => {
    const sbom = buildSbom(root, { sourceCommit: '1'.repeat(40) });
    expect(sbom.bomFormat).toBe('CycloneDX');
    expect(sbom.specVersion).toBe('1.6');
    expect(sbom.serialNumber).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(sbom.metadata.component).toEqual({ type: 'application', name: 'PointerCAD', version: '0.0.0' });
    expect(deterministicUuid('same-seed')).toBe(deterministicUuid('same-seed'));
    expect(deterministicUuid('a')).not.toBe(deterministicUuid('b'));
  });

  it('壊れた入力を拒否する: 版・commit・重複部品・不正なハッシュ', () => {
    const good = collectSbomComponents(root);
    expect(() => assembleSbomDocument(good, { rootPackageVersion: 'not-a-version' })).toThrow('root package version');
    expect(() => assembleSbomDocument(good, { rootPackageVersion: '1.0.0', sourceCommit: 'short' })).toThrow('source commit');
    expect(() => assembleSbomDocument({ components: [], unresolvedNotices: [] }, { rootPackageVersion: '1.0.0' })).toThrow('no components');
    const duplicate = { components: [good.components[0], good.components[0]], unresolvedNotices: [] };
    expect(() => assembleSbomDocument(duplicate, { rootPackageVersion: '1.0.0' })).toThrow('Duplicate SBOM component');
    const badHash = { components: [{ ...good.components[0], hashes: [{ alg: 'SHA-256', content: 'zz' }] }], unresolvedNotices: [] };
    expect(() => assembleSbomDocument(badHash, { rootPackageVersion: '1.0.0' })).toThrow('Invalid SBOM component hash');
    const badType = { components: [{ ...good.components[0], type: 'application' }], unresolvedNotices: [] };
    expect(() => assembleSbomDocument(badType, { rootPackageVersion: '1.0.0' })).toThrow('Invalid SBOM component type');
  });

  it('原文が全く無い(unresolved)場合と、SPDX識別子が未分類の場合を区別して一覧にする', () => {
    const sbom = buildSbom(root);
    const gaps = findSbomGaps(sbom);
    expect(gaps.unresolvedNotices).toEqual([]);
    // P13-6bで34件(自動作図12件+quickjs-pcad.wasm+追加計算部21件)のうち32件にSPDX識別子/式を付けた。
    // 残る2件は同梱原文が標準条文と一致すると確認できないため、推測せず未分類のまま残す。
    expect(gaps.unclassifiedLicenses.slice().sort()).toEqual(['SQLite 3.39.0', 'liblzma from XZ 5.2.2']);
    expect(gaps.noLicenseInformation).toEqual([]);
    expect(() => assertSbomPublishable(sbom)).not.toThrow();
    const withGap = { ...sbom, metadata: { ...sbom.metadata, properties: [...sbom.metadata.properties, { name: 'pointercad:unresolvedNotice', value: 'missing@1.0.0' }] } };
    expect(() => assertSbomPublishable(withGap)).toThrow('Unresolved SBOM notices');
  });

  it('release-manifest.json(P13-1)の資産一覧と原文の経路・ハッシュを照合する', () => {
    const sbom = buildSbom(root);
    const files = [];
    for (const component of sbom.components) {
      for (const entry of component.properties ?? []) {
        if (entry.name !== 'pointercad:distributedFile') continue;
        const [path, sha256] = entry.value.split('|');
        files.push({ path, bytes: 1, sha256 });
      }
    }
    expect(files.length).toBeGreaterThan(50);
    const okManifest = { web: { files } };
    expect(matchSbomToReleaseManifest(sbom, okManifest)).toEqual({ checked: files.length, missing: [], mismatched: [] });
    expect(() => assertSbomMatchesReleaseManifest(sbom, okManifest)).not.toThrow();

    const missingManifest = { web: { files: files.slice(1) } };
    const missingResult = matchSbomToReleaseManifest(sbom, missingManifest);
    expect(missingResult.missing).toHaveLength(1);
    expect(() => assertSbomMatchesReleaseManifest(sbom, missingManifest)).toThrow('missing SBOM files');

    const tamperedManifest = { web: { files: [{ ...files[0], sha256: files[0].sha256.replace(/^./u, files[0].sha256[0] === 'a' ? 'b' : 'a') }, ...files.slice(1)] } };
    const tamperedResult = matchSbomToReleaseManifest(sbom, tamperedManifest);
    expect(tamperedResult.mismatched).toHaveLength(1);
    expect(() => assertSbomMatchesReleaseManifest(sbom, tamperedManifest)).toThrow('hash differs from SBOM');
  });

  it('壊れたrelease-manifest入力を拒否する', () => {
    const sbom = buildSbom(root);
    expect(() => matchSbomToReleaseManifest(sbom, {})).toThrow('Invalid release manifest');
    expect(() => matchSbomToReleaseManifest(sbom, { web: { files: [{ path: 'x', sha256: 'not-a-hash' }] } })).toThrow('Invalid release manifest file entry');
    expect(() => matchSbomToReleaseManifest({ components: null }, { web: { files: [] } })).toThrow('Invalid SBOM document');
  });
});
