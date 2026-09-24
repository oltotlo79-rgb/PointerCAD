import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Check the real runtime inventory against the imported Python dependencies. */
function sources(): ReadonlyMap<string, string> {
  const host = new URL('./localExactMathEngine.ts', import.meta.url), text = readFileSync(host, 'utf8');
  const imported = new Map([...text.matchAll(/^import (\w+) from '([^']+\.py)\?raw';$/gmu)]
    .map(match => [match[1], { path: match[2], source: readFileSync(new URL(match[2], host), 'utf8') }]));
  expect(imported.size).toBeGreaterThan(0);
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
