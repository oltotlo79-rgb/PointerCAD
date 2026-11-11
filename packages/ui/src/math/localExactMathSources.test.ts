import { publicAssetUrl } from '../testing/publicAssetUrl.testSupport.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isRecord } from '../valueGuards.js';
import { describe, expect, it, vi } from 'vitest';

const hostFile = new URL('./localExactMathEngine.ts', import.meta.url);
const packageFile = publicAssetUrl('@pointercad/expression/package.json');
const requireFromHost = createRequire(hostFile);
const PUBLIC_PREFIX = '@pointercad/expression/math/exact-runtime/';

function assetExports(): Readonly<Record<string, unknown>> {
  const manifest: unknown = JSON.parse(readFileSync(packageFile, 'utf8'));
  if (!isRecord(manifest) || !isRecord(manifest.exports)) throw new Error('Expression package exports are missing');
  return manifest.exports;
}

/** Resolve the actual package export, not a relative fallback or a type-only alias. */
function publicAssetPath(specifier: string, exports: Readonly<Record<string, unknown>>): string {
  if (!/^@pointercad\/expression\/math\/exact-runtime\/cas_\w+\.py$/u.test(specifier)) {
    throw new Error('Use the explicit public mathematics asset entry');
  }
  const name = specifier.slice(PUBLIC_PREFIX.length), key = './math/exact-runtime/' + name;
  const target = exports[key];
  if (target !== './src/math/exactRuntime/' + name) throw new Error('Public mathematics asset mapping differs');
  const resolved = requireFromHost.resolve(specifier);
  expect(resolved).toBe(fileURLToPath(new URL(target, packageFile)));
  return resolved;
}

function assertCompleteExports(specifiers: readonly string[], exports: Readonly<Record<string, unknown>>): void {
  const actual = Object.keys(exports).filter(key => key.startsWith('./math/exact-runtime/')).sort();
  const expected = specifiers.map(value => './math/exact-runtime/' + value.slice(PUBLIC_PREFIX.length)).sort();
  expect(actual).toEqual(expected); // No wildcard or unused Python module becomes public by accident.
}

/** Check the real runtime inventory against the imported Python dependencies. */
function sources(): ReadonlyMap<string, string> {
  const text = readFileSync(hostFile, 'utf8'), exports = assetExports();
  const imports = [...text.matchAll(/^import (\w+) from '([^']+\.py)\?raw';$/gmu)];
  const imported = new Map(imports.map(match => [match[1],
    { path: match[2], source: readFileSync(publicAssetPath(match[2], exports), 'utf8') }]));
  expect(imported.size).toBe(45);
  expect(imported.size).toBe(imports.length);
  assertCompleteExports(imports.map(match => match[2]), exports);
  const shipped = new Map<string, string>();
  for (const match of text.matchAll(/\['(cas_\w+\.py)', (\w+)\]/gu)) {
    const entry = imported.get(match[2]);
    if (entry === undefined) throw new Error(`未読込の計算用ファイル: ${match[1]}`);
    expect(entry.path.endsWith('/' + match[1])).toBe(true);
    expect(shipped.has(match[1])).toBe(false); shipped.set(match[1], entry.source);
  }
  expect(shipped.size).toBe(imported.size);
  return shipped;
}
function missingDependencies(files: ReadonlyMap<string, string>): string[] {
  // An import inside a function is indented; it still has to be shipped with its importer.
  return [...files].flatMap(([name, source]) => [...source.matchAll(/^\s*(?:from|import) (cas_\w+)(?:\s|$)/gmu)]
    .filter(match => !files.has(match[1]+'.py')).map(match => `${name} → ${match[1]}.py`));
}
describe('配布する固定計算部に、読み込む自作ファイルを全て含める', () => {
  it('Vite resolves every public raw import of the actual engine without starting Python or a network loader', async () => {
    const engine = await import('./localExactMathEngine.js');
    expect(typeof engine.createLocalExactMathEngine).toBe('function');
    expect(sources().size).toBe(45);
  });

  it('rejects relative internals, unexported names, redirected targets and a wildcard export', () => {
    const exports = assetExports(), name = 'cas_input.py', key = './math/exact-runtime/' + name;
    expect(() => publicAssetPath('../../../expression/src/math/exactRuntime/' + name, exports)).toThrow('explicit public');
    expect(() => publicAssetPath(PUBLIC_PREFIX + 'cas_not_published.py', exports)).toThrow('mapping differs');
    expect(() => publicAssetPath(PUBLIC_PREFIX + name, { ...exports, [key]: undefined })).toThrow('mapping differs');
    expect(() => publicAssetPath(PUBLIC_PREFIX + name, { ...exports, [key]: './src/math/exactRuntime/cas_result.py' }))
      .toThrow('mapping differs');
    expect(() => assertCompleteExports([PUBLIC_PREFIX + name], { [key]: './src/math/exactRuntime/' + name,
      './math/exact-runtime/*': './src/math/exactRuntime/*' })).toThrow();
  });

  it('全ての配布用ファイルが実際の読み込み上限内にあり、機能追加で起動不能にしない', () => {
    const host = readFileSync(new URL('./localExactMathEngine.ts', import.meta.url), 'utf8');
    const guard = /if \(source\.length > ([\d_]+)\)/u.exec(host);
    if (guard === null) throw new Error('配布用ファイルの読み込み上限を確認できません。');
    const limit = Number(guard[1].replaceAll('_', ''));
    expect(limit).toBe(32_768);
    for (const [name, source] of sources()) expect(source.length, name).toBeLessThanOrEqual(limit);
  });
  it('実際の読込一覧とPython側の依存を照合し、追加ファイルの登録漏れを拒否する', () => {
    const shipped = sources();
    expect(missingDependencies(shipped)).toEqual([]);
    const withoutErrorFunctions = new Map(shipped); withoutErrorFunctions.delete('cas_error_functions.py');
    expect(missingDependencies(withoutErrorFunctions)).toContain('cas_input.py → cas_error_functions.py');
    expect(missingDependencies(withoutErrorFunctions)).toContain('cas_derivatives.py → cas_error_functions.py');
    const missing = new Map(shipped); missing.delete('cas_gamma_functions.py');
    expect(missingDependencies(missing)).toContain('cas_input.py → cas_gamma_functions.py');
    expect(missingDependencies(missing)).toContain('cas_derivatives.py → cas_gamma_functions.py');
    const withoutBessel = new Map(shipped); withoutBessel.delete('cas_bessel_functions.py');
    expect(missingDependencies(withoutBessel)).toContain('cas_input.py → cas_bessel_functions.py');
    expect(missingDependencies(withoutBessel)).toContain('cas_result.py → cas_bessel_functions.py');
    const withoutAiry = new Map(shipped); withoutAiry.delete('cas_airy_functions.py');
    expect(missingDependencies(withoutAiry)).toContain('cas_input.py → cas_airy_functions.py');
    expect(missingDependencies(withoutAiry)).toContain('cas_elliptic_functions.py → cas_airy_functions.py');
    expect(missingDependencies(withoutAiry)).toContain('cas_derivatives.py → cas_airy_functions.py');
    const withoutElliptic = new Map(shipped); withoutElliptic.delete('cas_elliptic_functions.py');
    const withoutZeta = new Map(shipped); withoutZeta.delete('cas_zeta_functions.py');
    expect(missingDependencies(withoutZeta)).toContain('cas_input.py → cas_zeta_functions.py');
    expect(missingDependencies(withoutZeta)).toContain('cas_result.py → cas_zeta_functions.py');
    expect(missingDependencies(withoutZeta)).toContain('cas_derivatives.py → cas_zeta_functions.py');
    expect(missingDependencies(withoutElliptic)).toContain('cas_input.py → cas_elliptic_functions.py');
    expect(missingDependencies(withoutElliptic)).toContain('cas_result.py → cas_elliptic_functions.py');
    expect(missingDependencies(withoutElliptic)).toContain('cas_derivatives.py → cas_elliptic_functions.py');
    const withoutLambert = new Map(shipped); withoutLambert.delete('cas_lambert_functions.py');
    expect(missingDependencies(withoutLambert)).toContain('cas_input.py → cas_lambert_functions.py');
    expect(missingDependencies(withoutLambert)).toContain('cas_result.py → cas_lambert_functions.py');
    expect(missingDependencies(withoutLambert)).toContain('cas_derivatives.py → cas_lambert_functions.py');
    expect(missingDependencies(new Map([['cas_a.py', 'def f():\n    from cas_b import g\n    return g\n']])))
      .toEqual(['cas_a.py → cas_b.py']);
    const withoutMappings = new Map(shipped); withoutMappings.delete('cas_mappings.py');
    expect(missingDependencies(withoutMappings)).toContain('cas_input.py → cas_mappings.py');
    const withoutDispatch = new Map(shipped); withoutDispatch.delete('cas_extended_dispatch.py');
    expect(missingDependencies(withoutDispatch)).toContain('cas_input.py → cas_extended_dispatch.py');
    for (const module of ['cas_cardinality', 'cas_vector_projection', 'cas_matrix_constructors', 'cas_set_relations', 'cas_logic_extended']) {
      const without = new Map(shipped); without.delete(`${module}.py`);
      expect(missingDependencies(without)).toContain(`cas_extended_dispatch.py → ${module}.py`);
    }
  });
});


describe('固定Python初期化の診断境界', () => {
  it('実performance時刻で3区間の開始・終了だけを通知する', async () => {
    const { initializeFixedMathPython } = await import('./localExactMathEngine.js');
    const blocks: string[] = [], events: { stage: string; boundary: string; atMs: number }[] = [];
    initializeFixedMathPython({ runPython: source => { blocks.push(source); } },
      (stage, boundary, atMs) => { events.push({ stage, boundary, atMs }); });
    expect(events.map(({ stage, boundary }) => [stage, boundary])).toEqual([
      ['metadata', 'start'], ['metadata', 'end'], ['sympy-import', 'start'], ['sympy-import', 'end'],
      ['cas-evaluate-import', 'start'], ['cas-evaluate-import', 'end'],
    ]);
    expect(blocks).toHaveLength(3);
    for (const event of events) expect(Number.isFinite(event.atMs)).toBe(true);
    for (let index = 1; index < events.length; index += 1) {
      const current = events[index], previous = events[index - 1];
      if (current === undefined || previous === undefined) throw new Error('Missing initialization boundary');
      expect(current.atMs).toBeGreaterThanOrEqual(previous.atMs);
    }
    expect(events.every(event => Object.keys(event).sort().join(',') === 'atMs,boundary,stage')).toBe(true);
  });

  it.each([0, 1, 2])('区間%sの例外を保持し、失敗した終了と後続開始を記録しない', async failure => {
    const { initializeFixedMathPython } = await import('./localExactMathEngine.js');
    let calls = 0;
    const events: string[] = [];
    expect(() => initializeFixedMathPython({ runPython: () => {
      if (calls++ === failure) throw new Error('fixed-import-failure');
    } }, (stage, boundary) => { events.push(stage + ':' + boundary); })).toThrow('fixed-import-failure');
    expect(calls).toBe(failure + 1);
    const stages = ['metadata', 'sympy-import', 'cas-evaluate-import'];
    expect(events).toEqual(stages.slice(0, failure).flatMap(stage => [stage + ':start', stage + ':end'])
      .concat(stages[failure] + ':start'));
  });

  it('診断無効では固定ブロックを1回だけ実行し、ログを出さない', async () => {
    const { initializeFixedMathPython } = await import('./localExactMathEngine.js');
    const blocks: string[] = [];
    const debug = vi.spyOn(console, 'debug');
    try {
      initializeFixedMathPython({ runPython: source => { blocks.push(source); } });
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toContain("assert _pcad_metadata.version('sympy') == '1.14.0'");
      expect(blocks[0]).toContain("assert _pcad_metadata.version('mpmath') == '1.3.0'");
      expect(blocks[0]).toContain('from cas_evaluate import calculate_exact_json as _pcad_calculate_exact');
      expect(debug).not.toHaveBeenCalled();
    } finally { debug.mockRestore(); }
  });

  it('診断callbackの例外で固定初期化を中断しない', async () => {
    const { initializeFixedMathPython } = await import('./localExactMathEngine.js');
    const blocks: string[] = [];
    expect(() => initializeFixedMathPython({ runPython: source => { blocks.push(source); } },
      () => { throw new Error('recording-only'); })).not.toThrow();
    expect(blocks).toHaveLength(3);
  });
});
