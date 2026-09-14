import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface RootPackageJson {
  scripts?: Record<string, string>;
}

const rootUrl = new URL('../../../', import.meta.url);

function readRootFile(path: string): string {
  return readFileSync(new URL(path, rootUrl), 'utf8');
}

describe('品質ゲートのテスト実行順', () => {
  it('数学を先行し、失敗なら後続を止め、成功時も数学を二重実行しない', () => {
    const packageJson = JSON.parse(readRootFile('package.json')) as RootPackageJson;

    expect(packageJson.scripts?.test).toBe(
      'pnpm --filter @pointercad/expression run test && pnpm --recursive --filter !@pointercad/expression --reverse --workspace-concurrency=1 --if-present run test',
    );
  });

  it.each([
    'packages/expression/vitest.config.ts',
    'packages/io/vitest.config.ts',
    'packages/kernel/vitest.config.ts',
    'packages/model/vitest.config.ts',
    'packages/ui/vitest.config.ts',
  ])('%sが厳密性能検査の固定順を使う', (path) => {
    const config = readRootFile(path);

    expect(config).toContain('PerformanceFirstSequencer');
    expect(config).toContain('sequence: { sequencer: PerformanceFirstSequencer }');
    expect(config).toContain('fileParallelism:');
  });

  it('板金の性能判定が共通の厳密/参考モードと優先実行へ接続される', () => {
    const source = readRootFile('packages/model/src/sheetMetal/sheetPerformance.test.ts');
    expect(source).toContain("import { expectWithinBudget } from '@pointercad/test-utils'");
    expect(source).toMatch(/expectWithinBudget\(elapsed, 5000,/u);
    expect(source).toMatch(/expectWithinBudget\(elapsed, 500,/u);
    expect(source).not.toMatch(/expect\(elapsed\)\.toBeLessThan/u);
  });

  it.each(['model', 'kernel', 'expression'])('%sの実形状検査はCommit・CIでも1 workerに固定する', (name) => {
    const config = readRootFile(`packages/${name}/vitest.config.ts`);
    // 性能の参考モードでも5000msの通常期限は有効。環境変数で並列へ戻さない。
    expect(config).toMatch(/fileParallelism:\s*false\s*,/u);
  });

  it('連続E2Eはほかの4段を重複させず品質ゲートの正本から実行する', () => {
    const checkScript = readRootFile('scripts/check.ps1');

    expect(checkScript).toContain('[int]$E2ERepeats = 1');
    expect(checkScript).toContain('$e2eRun -le $E2ERepeats');
    expect(checkScript).toContain('$e2eArgs = @("run", "test:e2e")');
    expect(checkScript).toMatch(/Invoke-Check[^\r\n]*pnpm \$e2eArgs/u);
  });

  it('E2E操作上限をPlaywrightのuse内に置き、遮られた操作を15秒で止める', () => {
    const config = readRootFile('e2e/playwright.config.ts');
    const useIndex = config.indexOf('use: {');

    expect(useIndex).toBeGreaterThan(0);
    expect(config.slice(0, useIndex)).not.toContain('actionTimeout:');
    expect(config.slice(useIndex)).toMatch(/use:\s*\{[\s\S]*?actionTimeout:\s*15_000,/u);
  });

  it('絞り込み診断は余分な区切りを挟まずgrepをPlaywrightへ渡す', () => {
    const checkScript = readRootFile('scripts/check.ps1');

    expect(checkScript).toContain('$e2eArgs += @("--grep", $E2EGrep)');
    expect(checkScript).not.toContain('@("--", "--grep", $E2EGrep)');
  });

  it('50部品と4分割のFPS測定をソフトウェア描画で先行し、他のE2Eと競合させない', () => {
    const config = readRootFile('e2e/playwright.config.ts');
    const performance = config.slice(config.indexOf("name: 'viewport-performance'"), config.indexOf("name: 'functional'"));
    const functional = config.slice(config.indexOf("name: 'functional'"));
    const selectedSource = /^const VIEWPORT_PERFORMANCE_TEST = \/(.+)\/u;/mu.exec(config)?.[1];
    const filesSource = /testMatch: \/(.+)\/u,/u.exec(performance)?.[1];
    if (selectedSource === undefined || filesSource === undefined) throw new Error('性能検査の対象指定がありません');
    const selected = new RegExp(selectedSource, 'u');
    const files = new RegExp(filesSource, 'u');
    expect(selected.test('空状態、原点・式配置、各Undo、保存往復、見分けられる同じ箱50個')).toBe(true);
    expect(selected.test('4分割の実描画性能')).toBe(true);
    expect(selected.test('図面を保存して開き直す')).toBe(false);
    expect(files.test('e2e/tests/assembly.spec.ts')).toBe(true);
    expect(files.test('e2e/tests/p8-drawing.spec.ts')).toBe(true);
    expect(files.test('e2e/tests/smoke.spec.ts')).toBe(false);
    expect(performance).toContain('grep: VIEWPORT_PERFORMANCE_TEST');
    expect(performance).toContain("args: ['--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader']");
    expect(performance).not.toContain("'--use-angle=swiftshader'");
    expect(performance).toContain('workers: 1');
    expect(functional).toContain('grepInvert: VIEWPORT_PERFORMANCE_TEST');
    expect(functional).toContain("dependencies: ['viewport-performance']");
    expect(config).toContain('workers: 2');
  });

  it('承認した性能値を全4描画検査と図面検査へ接続し、性能専用projectから漏らさない', () => {
    const config = readRootFile('e2e/playwright.config.ts');
    const selectedSource = /^const VIEWPORT_PERFORMANCE_TEST = \/(.+)\/u;/mu.exec(config)?.[1];
    if (selectedSource === undefined) throw new Error('性能検査の対象指定がありません');
    const selected = new RegExp(selectedSource, 'u');
    for (const file of ['assembly', 'p8-drawing', 'script-performance', 'sheet-performance']) {
      const source = readRootFile(`e2e/tests/${file}.spec.ts`);
      expect(source).toContain("from '../../packages/test-utils/src/releasePerformance.js'");
      expect(source).toContain('.toBeGreaterThanOrEqual(RELEASE_SOFTWARE_VIEWPORT_MIN_FPS)');
      expect(source).not.toMatch(/expect\((?:fps(?:\.fps)?|measured\.fps)\)\.toBeGreaterThanOrEqual\(\d+\)/u);
    }
    const drawing = readRootFile('e2e/tests/drawing-performance.spec.ts');
    expect(drawing).toContain('expect(loading.openingMs).toBeLessThanOrEqual(RELEASE_DRAWING_OPEN_MAX_MS)');
    expect(drawing).toContain('expect(loading.fontMs).toBeLessThanOrEqual(1000)');
    for (const file of ['drawing-performance', 'script-performance', 'sheet-performance']) {
      const source = readRootFile(`e2e/tests/${file}.spec.ts`);
      const title = /test\('([^']+)'/u.exec(source)?.[1];
      expect(title, file).toBeDefined();
      expect(selected.test(title ?? ''), file).toBe(true);
    }
  });

  it('初回読み込みを含む待機を共通の有限上限へ接続し、取消や失敗を成功にしない', () => {
    const recompute = readRootFile('e2e/tests/recompute.ts');
    const reopen = readRootFile('e2e/tests/reopenPart.ts');
    expect(recompute).toContain('export const KERNEL_TIMEOUT_MS = RECOMPUTE_TIMEOUT_MS');
    expect(recompute).toContain('timeout: KERNEL_TIMEOUT_MS');
    expect(recompute).toContain(".not.toBe('waiting')");
    expect(recompute).toContain("expect(last.stats?.lastOutcome,");
    expect(recompute).toContain(".toBe('success')");
    expect(reopen).toContain('waitForRecompute(page, before)');
    const policy = readRootFile('packages/test-utils/src/releasePerformance.ts');
    expect(policy).toContain('export const RECOMPUTE_TIMEOUT_MS = 90_000');
    expect(policy).not.toMatch(/process\.env|import\.meta\.env/u);
  });
});
