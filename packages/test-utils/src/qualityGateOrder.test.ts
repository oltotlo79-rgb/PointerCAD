import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { RECOMPUTE_TIMEOUT_MS } from './releasePerformance.js';

interface RootPackageJson {
  scripts?: Record<string, string>;
}

const rootUrl = new URL('../../../', import.meta.url);

function readRootFile(path: string): string {
  return readFileSync(new URL(path, rootUrl), 'utf8');
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ');
}

/** Only the accepted frozen 120 s and current 300 s windows, with their matching whole-test limits. */
function expectHostInterferenceWindow(source: string, specs: readonly string[]): void {
  const window = /^const INTERFERENCE_FOLLOW_MS = (120_000|300_000);$/mu.exec(source)?.[1];
  expect(window, 'accepted finite interference window').toBeDefined();
  if (window === '120_000') {
    for (const spec of specs) {
      expect(spec).toContain('const HOST_1000_TEST_TIMEOUT_MS = 900_000');
      expect(spec).toContain('test.setTimeout(HOST_1000_TEST_TIMEOUT_MS + 5 * (120_000 - 60_000))');
      expect(spec).not.toContain('test.setTimeout(ASSEMBLY_1000_FUNCTIONAL_TIMEOUT_MS)');
    }
  } else if (window === '300_000') {
    expect(source).toContain('export const ASSEMBLY_1000_FUNCTIONAL_TIMEOUT_MS = 600_000 + INTERFERENCE_RUNS * INTERFERENCE_FOLLOW_MS');
    for (const spec of specs) {
      expect(spec).toMatch(/import \{[^}]*\bASSEMBLY_1000_FUNCTIONAL_TIMEOUT_MS\b[^}]*\} from '\.\/assembly1000HostFlow\.js'/u);
      expect(spec).toContain('test.setTimeout(ASSEMBLY_1000_FUNCTIONAL_TIMEOUT_MS)');
      expect(spec).not.toMatch(/test\.setTimeout\(HOST_1000_TEST_TIMEOUT_MS \+/u);
    }
  }
}

function vitestConfigLinter(): ESLint {
  return new ESLint({ cwd: fileURLToPath(rootUrl), fix: false, cache: false, allowInlineConfig: false,
    ruleFilter: ({ ruleId }) => ruleId === 'module-style/vitest-config-wiring' });
}

describe('品質ゲートのテスト実行順', () => {
  it('共通検査・数学・FEMを順に先行し、失敗なら後続を止め、各packageを二重実行しない', () => {
    const packageJson = JSON.parse(readRootFile('package.json')) as RootPackageJson;

    expect(normalizeWhitespace(packageJson.scripts?.test ?? '')).toBe(
      normalizeWhitespace('pnpm --filter @pointercad/test-utils run test && pnpm --filter @pointercad/expression run test && pnpm --filter @pointercad/fem run test && pnpm --recursive --filter !@pointercad/test-utils --filter !@pointercad/expression --filter !@pointercad/fem --reverse --workspace-concurrency=1 --if-present run test'),
    );
  });

  it('全パッケージが共通設定を直接書き出し、実行順・worker・上限の組を保つ', async () => {
    const expected = ['apps/desktop', 'apps/web', 'packages/drawing', 'packages/expression', 'packages/fem',
      'packages/help-content', 'packages/io', 'packages/kernel', 'packages/model', 'packages/test-utils', 'packages/ui'];
    const directories = ['apps', 'packages'].flatMap(folder => readdirSync(new URL(`${folder}/`, rootUrl))
      .map(name => `${folder}/${name}`).filter(dir => existsSync(new URL(`${dir}/vitest.config.ts`, rootUrl))));
    expect(directories.sort()).toEqual(expected);
    const paths = directories.map(directory => `${directory}/vitest.config.ts`);
    const eslint = vitestConfigLinter();
    const results = await eslint.lintFiles(paths);
    expect(results).toHaveLength(paths.length);
    expect(results.flatMap(result => result.messages)).toEqual([]);
    for (const filePath of paths) {
      const [result] = await eslint.lintText('export default {};', { filePath });
      expect(result?.messages.map(message => message.messageId).sort(), filePath).toEqual(['factoryExport', 'factoryImport']);
    }
  });

  it('共通設定の呼出しは整形を問わず、別のprofile・設定元・上書きを拒む', async () => {
    const eslint = vitestConfigLinter();
    const filePath = 'packages/model/vitest.config.ts';
    const source = `import {
  createPackageVitestConfig,
} from "../test-utils/src/vitest.package.testSupport.js";
const options = { include: ["src/**/*.test.ts"] };
export default createPackageVitestConfig(
  "performance-serial",
  options,
);`;
    const examples = [
      { code: source, diagnostics: [] },
      { code: source.replace('performance-serial', 'performance-strict'), diagnostics: ['factoryExport'] },
      { code: source.replace('vitest.package.testSupport.js', 'other.js'), diagnostics: ['factoryImport'] },
      { code: source.replace('import {', 'import type {'), diagnostics: ['factoryImport'] },
      { code: source.replace('export default createPackageVitestConfig(', 'export default wrap(createPackageVitestConfig(')
        .replace(');', '));'), diagnostics: ['factoryExport'] },
      { code: source.replace('include:', 'fileParallelism: true, "testTimeout": 1, ["sequence"]: {}, include:'),
        diagnostics: ['ownedPolicy', 'ownedPolicy', 'ownedPolicy'] },
    ];
    for (const { code, diagnostics } of examples) {
      const [result] = await eslint.lintText(code, { filePath });
      expect(result?.messages.map(message => message.messageId), code).toEqual(diagnostics);
    }
  });

  it('板金の性能判定が共通の目標記録と実用性の判定へ接続される', () => {
    const source = readRootFile('packages/model/src/sheetMetal/sheetPerformance.test.ts');
    expect(source).toContain("import { expectWithinBudget } from '@pointercad/test-utils'");
    expect(source).toMatch(/expectWithinBudget\(elapsed, 5000,/u);
    expect(source).toMatch(/expectWithinBudget\(elapsed, 500,/u);
    expect(source).not.toMatch(/expect\(elapsed\)\.toBeLessThan/u);
  });

  it('連続E2Eはほかの4段を重複させず品質ゲートの正本から実行する', () => {
    const checkScript = readRootFile('scripts/check.ps1');
    const normalizedScript = normalizeWhitespace(checkScript);

    expect(normalizedScript).toContain(normalizeWhitespace('[int]$E2ERepeats = 1'));
    expect(normalizedScript).toContain(normalizeWhitespace('$e2eRun -le $E2ERepeats'));
    expect(normalizedScript).toContain(normalizeWhitespace('$e2eArgs = @("run", "test:e2e")'));
    expect(checkScript.split(/[\r\n]+/u).map(normalizeWhitespace).join('\n')).toMatch(/Invoke-Check[^\r\n]*pnpm \$e2eArgs/u);
  });

  it('E2E操作上限をPlaywrightのuse内に置き、遮られた操作を15秒で止める', () => {
    const config = normalizeWhitespace(readRootFile('e2e/playwright.config.ts'));
    const useIndex = config.indexOf(normalizeWhitespace('use: {'));

    expect(useIndex).toBeGreaterThan(0);
    expect(config.slice(0, useIndex)).not.toContain(normalizeWhitespace('actionTimeout:'));
    expect(config.slice(useIndex)).toMatch(/use:\s*\{[\s\S]*?actionTimeout:\s*15_000,/u);
  });

  it('絞り込み診断は余分な区切りを挟まずgrepをPlaywrightへ渡す', () => {
    const checkScript = normalizeWhitespace(readRootFile('scripts/check.ps1'));

    expect(checkScript).toContain(normalizeWhitespace('$e2eArgs += @("--grep", $E2EGrep)'));
    expect(checkScript).not.toContain(normalizeWhitespace('@("--", "--grep", $E2EGrep)'));
  });

  it('50部品と4分割のFPS測定をソフトウェア描画で先行し、他のE2Eと競合させない', () => {
    const config = readRootFile('e2e/playwright.config.ts');
    const functionalStart = config.search(/name:\s+'functional'/u);
    const performance = config.slice(config.search(/name:\s+'viewport-performance'/u), functionalStart);
    const functional = normalizeWhitespace(config.slice(functionalStart));
    const selectedSource = /^const VIEWPORT_PERFORMANCE_TEST = \/(.+)\/u;/mu.exec(config)?.[1];
    const filesSource = /testMatch: \/(.+)\/u,/u.exec(performance)?.[1];
    const normalizedPerformance = normalizeWhitespace(performance);
    if (selectedSource === undefined || filesSource === undefined) throw new Error('性能検査の対象指定がありません');
    const selected = new RegExp(selectedSource, 'u');
    const files = new RegExp(filesSource, 'u');
    expect(selected.test('空状態、原点・式配置、各Undo、保存往復、見分けられる同じ箱50個')).toBe(true);
    expect(selected.test('4分割の実描画性能')).toBe(true);
    expect(selected.test('図面を保存して開き直す')).toBe(false);
    expect(files.test('e2e/tests/assembly.spec.ts')).toBe(true);
    expect(files.test('e2e/tests/p8-drawing.spec.ts')).toBe(true);
    expect(files.test('e2e/tests/smoke.spec.ts')).toBe(false);
    expect(normalizedPerformance).toContain(normalizeWhitespace('grep: VIEWPORT_PERFORMANCE_TEST'));
    expect(normalizedPerformance).toContain(normalizeWhitespace("args: ['--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader']"));
    expect(normalizedPerformance).not.toContain(normalizeWhitespace("'--use-angle=swiftshader'"));
    expect(normalizedPerformance).toContain(normalizeWhitespace('workers: 1'));
    expect(functional).toContain(normalizeWhitespace('grepInvert: VIEWPORT_PERFORMANCE_TEST'));
    expect(functional).toContain(normalizeWhitespace("dependencies: ['viewport-performance']"));
    // 全体は 2 本。外部検査の 1 組目だけ 1 本(組ごとの実際の本数は ciSharding.test.ts が --list で確かめる)。
    expect(normalizeWhitespace(config)).toContain(normalizeWhitespace('workers: FIRST_SHARD_ALONE ? 1 : 2,'));
  });

  it('目標記録と実用性の判定を全4描画検査と図面検査へ接続し、性能専用projectから漏らさない', () => {
    const config = readRootFile('e2e/playwright.config.ts');
    const selectedSource = /^const VIEWPORT_PERFORMANCE_TEST = \/(.+)\/u;/mu.exec(config)?.[1];
    if (selectedSource === undefined) throw new Error('性能検査の対象指定がありません');
    const selected = new RegExp(selectedSource, 'u');
    for (const file of ['assembly', 'p8-drawing', 'script-performance', 'sheet-performance']) {
      const source = readRootFile(`e2e/tests/${file}.spec.ts`);
      expect(source).toContain("from '../../packages/test-utils/src/releasePerformance.js'");
      expect(source).toMatch(/reportViewportRate\((?:fps(?:\.fps)?|measured\.fps),/u);
      expect(source).not.toMatch(/expect\((?:fps(?:\.fps)?|measured\.fps)\)\.toBeGreaterThanOrEqual/u);
    }
    const drawing = readRootFile('e2e/tests/drawing-performance.spec.ts');
    expect(drawing).toContain('reportDuration(loading.openingMs, DRAWING_OPEN_TARGET_MS,');
    expect(drawing).toContain('reportDuration(loading.fontMs, 1_000,');
    expect(drawing).toContain('reportDuration(measurements.maxRenderingMs, 16,');
    expect(drawing).toContain('reportDuration(viewMeasurements.maxRenderingMs, 16,');
    expect(drawing).not.toMatch(/expect\((?:loading\.[a-zA-Z]+|measurements\.maxRenderingMs|viewMeasurements\.maxRenderingMs)\)\.toBeLessThan/u);
    for (const file of ['drawing-performance', 'script-performance', 'sheet-performance']) {
      const source = readRootFile(`e2e/tests/${file}.spec.ts`);
      const title = /test\('([^']+)'/u.exec(source)?.[1];
      expect(title, file).toBeDefined();
      expect(selected.test(title ?? ''), file).toBe(true);
    }
  });

  it('性能予算は環境変数に依存せず共通の記録へ渡す', () => {
    const budget = readRootFile('packages/test-utils/src/perfBudget.ts');
    expect(budget).toContain('reportDuration(actualMs, limitMs, label, profile)');
    expect(budget).not.toContain('process.env');
  });

  it('干渉計算は全条件を同じ有限上限へ渡し、環境や球の条件だけで判定を変えない', () => {
    const source = readRootFile('packages/kernel/src/worker/interferencePerformance.test.ts');
    expect(source).toContain("expectWithinBudget(Math.max(...samples), budget, id, 'interference')");
    expect(source).not.toContain('process.env');
    expect(source).toContain('assertResult(result, total, volumes)');
    expect(source).toContain('expect(native.live).toBe(0)');
  });

  it('検索・PDF・STEP・中止表示の速度だけの判定も共通の記録へ揃える', () => {
    for (const file of ['packages/help-content/src/searchIndex.test.ts',
      'packages/drawing/src/render/pdfAcceptance.font.test.ts', 'packages/kernel/src/occt/readStep.test.ts']) {
      const source = readRootFile(file);
      expect(source).toContain('expectWithinBudget(');
      expect(source).not.toMatch(/expect\(elapsed(?:Ms)?\)\.toBeLessThan/u);
    }
    expect(readRootFile('e2e/tests/scriptLimitsFlow.ts')).toContain('reportDuration(cancelMs, 200,');
    expect(readRootFile('e2e/tests/assembly.spec.ts')).toContain('reportDuration(distinctElapsed, 5_000,');
  });

  it('初回読み込みを含む待機を共通の有限上限へ接続し、取消や失敗を成功にしない', () => {
    const recompute = normalizeWhitespace(readRootFile('e2e/tests/recompute.ts'));
    const reopen = normalizeWhitespace(readRootFile('e2e/tests/reopenPart.ts'));
    expect(recompute).toContain(normalizeWhitespace('export const KERNEL_TIMEOUT_MS = RECOMPUTE_TIMEOUT_MS'));
    expect(recompute).toContain(normalizeWhitespace("waitKind: RecomputeWaitKind = 'kernel'"));
    expect(recompute).toContain(normalizeWhitespace("const timeoutMs = waitKind === 'exact-math' ? EXACT_MATH_ENGINE_LIMITS.totalMs : KERNEL_TIMEOUT_MS"));
    expect(recompute).toContain(normalizeWhitespace('timeout: timeoutMs'));
    expect(recompute).toContain(normalizeWhitespace(".not.toBe('waiting')"));
    expect(recompute).toContain(normalizeWhitespace("expect(last.stats?.lastOutcome,"));
    expect(recompute).toContain(normalizeWhitespace(".toBe(outcome)"));
    expect(recompute).toContain(normalizeWhitespace("waitForRecomputeOutcome(page, token, 'success', waitKind)"));
    expect(reopen).toContain(normalizeWhitespace("app?: ElectronApplication, waitKind: RecomputeWaitKind = 'exact-math'"));
    expect(reopen).toContain(normalizeWhitespace('waitForRecompute(page, before, waitKind)'));
    const policy = readRootFile('packages/test-utils/src/releasePerformance.ts');
    const expectedTimeoutMs = 150_000;
    expect(RECOMPUTE_TIMEOUT_MS satisfies typeof expectedTimeoutMs).toBe(expectedTimeoutMs);
    const exactMathPolicy = normalizeWhitespace(readRootFile('packages/expression/src/math/exactMathEngineClient.ts'));
    expect(exactMathPolicy).toContain(normalizeWhitespace('totalMs: 225_000'));
    expect(normalizeWhitespace(policy)).not.toMatch(/process\.env|import\.meta\.env/u);
  });
});

describe('1000点スケッチの機能優先と時間観測の境界', () => {
  it('100msは全描画と最終previewの参考値とし、取消・有限待機・幾何・保存の判定は保持する', () => {
    const source = readRootFile('e2e/tests/sketchConnected1000Flow.ts');
    const normalizedSource = normalizeWhitespace(source);
    expect(normalizedSource).toContain(normalizeWhitespace("import { observeDuration } from '../../packages/test-utils/src/releasePerformance.js'"));
    expect(normalizedSource).toContain(normalizeWhitespace('observeDuration(row.renderedAtMs - row.eventAtMs, 100,'));
    expect(normalizedSource).toContain(normalizeWhitespace('observeDuration(finalPreview.renderedAtMs - finalPreview.eventAtMs, 100,'));
    expect(source).not.toMatch(/expect\((?:row|finalPreview)\.renderedAtMs\s*-\s*(?:row|finalPreview)\.eventAtMs\)\.toBeLessThan/u);
    expect(normalizedSource).toContain(normalizeWhitespace('durationObservations.push(observeDuration('));
    expect(normalizedSource).toContain(normalizeWhitespace("attachJsonEvidence(info, 'sketch-duration-observations.json'"));
    expect(normalizedSource).toContain(normalizeWhitespace("decisionUse: 'observation', samples: durationObservations"));
    expect(normalizedSource).toContain(normalizeWhitespace("await writeFile(path, JSON.stringify(value), { flag: 'wx' })"));
    expect(normalizedSource).toContain(normalizeWhitespace("await info.attach(name, { path, contentType: 'application/json' })"));
    expect(normalizedSource).toContain(normalizeWhitespace("attachJsonEvidence(info, 'sketch-input-scene-render.json'"));
    expect(normalizedSource).toContain(normalizeWhitespace('expect(cancelTiming.renderedAtMs - cancelTiming.eventAtMs).toBeLessThanOrEqual(1000)'));
    expect(normalizedSource).toContain(normalizeWhitespace("{ polling: 'raf', timeout: 30_000 }"));
    expect(normalizedSource).toContain(normalizeWhitespace("expect(timing.boundary).toBe('scene-render-return')"));
    expect(normalizedSource).toContain(normalizeWhitespace('expect(timing.clockValid).toBe(true)'));
    expect(normalizedSource).toContain(normalizeWhitespace('expect(timing.overflow).toBe(0)'));
    expect(normalizedSource).toContain(normalizeWhitespace('!Number.isFinite(row.eventAtMs) || !Number.isFinite(row.renderedAtMs)'));
    expect(normalizedSource).toContain(normalizeWhitespace('row.eventAtMs < 0 || row.renderedAtMs < 0'));
    expect(normalizedSource).toContain(normalizeWhitespace('expect(position,'));
    expect(normalizedSource).toContain(normalizeWhitespace('.toBeLessThanOrEqual(SKETCH_TOLERANCE_MM)'));
    expect(normalizedSource).toContain(normalizeWhitespace('.toBeLessThanOrEqual(CONSTRAINT_TOLERANCE)'));
    expect(normalizedSource).toContain(normalizeWhitespace('const TARGET_TOLERANCE_MM = 1'));
    expect(normalizedSource).toContain(normalizeWhitespace('expect(afterCancel.document).toEqual(beforeCancel.document)'));
    expect(normalizedSource).toContain(normalizeWhitespace('await waitForRecompute(page, commit)'));
    expect(normalizedSource).toContain(normalizeWhitespace('expect(sketch.constraints).toEqual(writtenConstraints)'));
    expect(normalizedSource).toContain(normalizeWhitespace('const translation = expectRigidTranslation(sketch)'));
    expect(normalizedSource).toContain(normalizeWhitespace('await expect(undoButton(page)).toBeEnabled()'));
    expect(normalizedSource).toContain(normalizeWhitespace("attachJsonEvidence(info, 'sketch-connected-1000-final-observation.json'"));
  });
});

describe('OCCT起動の機能優先と比較観測の境界', () => {
  it('比率だけのhard assertionを拒否し、5組・実形状・cleanupと生JSON保存を保持する', () => {
    const source = readRootFile('e2e/tests/occtCompileReuseFlow.ts');
    const normalizedSource = normalizeWhitespace(source);
    const start = source.search(/export\s+async\s+function\s+assertFiveOcctPairs\(/u);
    expect(start).toBeGreaterThan(0);
    const judge = source.slice(start);
    const normalizedJudge = normalizeWhitespace(judge);
    const hardComparison = /expect\s*\([^;]*?\)\s*\.\s*(?:toBeLessThan(?:OrEqual)?|toBeGreaterThan(?:OrEqual)?|toBeCloseTo)\s*\(/u;
    expect(judge).not.toMatch(hardComparison);
    expect(judge).not.toMatch(/expect\s*\([^;]*(?:cold|warm|ratio|meetsTarget|referenceRatio)[^;]*?\)\s*\.\s*(?:toBe|toEqual|toBeTruthy)\s*\(/u);
    expect('expect(warm).toBeLessThanOrEqual(cold * 0.8);').toMatch(hardComparison);
    expect('expect(observation.ratio).toBeLessThanOrEqual(0.8);').toMatch(hardComparison);
    expect(judge).not.toMatch(/\b(?:if|throw)\b[^;]*(?:ratio|meetsTarget|referenceRatio|0\.8)/u);
    expect(normalizedJudge).toContain(normalizeWhitespace('observeStartupReuse('));
    expect(normalizedJudge).toContain(normalizeWhitespace('pairs.map(pair => pair.cold.startupMs)'));
    expect(normalizedJudge).toContain(normalizeWhitespace('pairs.map(pair => pair.warm.startupMs)'));
    expect(normalizedJudge).toContain(normalizeWhitespace('expect(pairs).toHaveLength(5)'));
    expect(normalizedJudge).toContain(normalizeWhitespace('new Set(pairs.map(pair => pair.profile)).size).toBe(5)'));
    expect(normalizedJudge).toContain(normalizeWhitespace('toEqual([1, 2, 3, 4, 5])'));
    expect(normalizedJudge).toContain(normalizeWhitespace("persistOcctEvidence(info, 'five-pair-raw-measurements'"));
    expect(normalizedJudge).toContain(normalizeWhitespace("persistOcctEvidence(info, 'five-pair-medians'"));
    expect(normalizedSource).toContain(normalizeWhitespace("await writeFile(path, JSON.stringify(value, null, 2), { flag: 'wx' })"));
    expect(normalizedSource).toContain(normalizeWhitespace("await info.attach(name, { path, contentType: 'application/json' })"));
    for (const kept of ['expect(warm.sha256).toBe(cold.sha256)', 'await sampler?.stop()',
      'await context?.close()', 'await app?.close()', 'expect(starts).toHaveLength(2)',
      'expect(ready).toHaveLength(2)', "waitForRecompute(page, token)"]) expect(normalizedSource).toContain(normalizeWhitespace(kept));
    for (const path of ['e2e/tests/occt-compile-reuse-solid.spec.ts', 'e2e/tests/electron-occt-compile-reuse.spec.ts']) {
      const spec = normalizeWhitespace(readRootFile(path));
      expect(spec).toContain(normalizeWhitespace('for (const offline of [false, true])'));
      expect(spec).toContain(normalizeWhitespace('index <= 5'));
      expect(spec).toContain(normalizeWhitespace('if (index === 5) await assertFiveOcctPairs(pairs, info)'));
    }
  });
});

describe('1000部品の参考4観測と安全・機能条件の境界', () => {
  it('open/save/reopen/FPSだけのhard再混入を拒否し、有限待機と全機能を維持する', () => {
    const source = readRootFile('e2e/tests/assembly1000HostFlow.ts');
    const normalizedSource = normalizeWhitespace(source);
    expect(normalizedSource).toContain(normalizeWhitespace('observePositiveDuration(actualMs, targetMs, label)'));
    expect(normalizedSource).toContain(normalizeWhitespace('observeViewportRate(fps,'));
    expect(source).not.toMatch(/judge\('(open|save|reopen|fps)'/u);
    expect(source).not.toMatch(/reportViewportRate\(/u);
    expect(source).not.toMatch(/expect\([^;]*(?:openToDrawnMs|reopenToDrawnMs|saveMs|fps\.fps)[^;]*\)\.toBe(?:LessThan|GreaterThan)/u);
    expect(source).not.toMatch(/expect\([^;]*(?:meetsTarget|referenceTargetFps)[^;]*\)\.(?:toBe|toEqual)/u);
    expect("judge('open', () => reportDuration(openToDrawnMs, HOST_LOAD_TARGET_MS, 'open'));").toMatch(/judge\('(open|save|reopen|fps)'/u);
    for (const name of ['open', 'save', 'reopen']) expect(normalizedSource).toContain(normalizeWhitespace(`'${name}',`));
    expect(normalizedSource).toContain(normalizeWhitespace('const HOST_LOAD_TARGET_MS = 5_000'));
    expect(normalizedSource).toContain(normalizeWhitespace('const HOST_SAVE_TARGET_MS = 5_000'));
    expect(normalizedSource).toContain(normalizeWhitespace("attachHostObservation(info, `assembly-1000-${name}-duration.json`"));
    expect(normalizedSource).toContain(normalizeWhitespace("attachHostObservation(info, 'assembly-1000-fps-raw.json', fps)"));
    expect(normalizedSource).toContain(normalizeWhitespace("attachHostObservation(info, 'assembly-1000-observations.json'"));
    expect(normalizedSource).toContain(normalizeWhitespace("await writeFile(path, JSON.stringify(value, null, 2), { flag: 'wx' })"));
    expect(normalizedSource).toContain(normalizeWhitespace("await info.attach(name, { path, contentType: 'application/json' })"));
    for (const token of ['const INTERFERENCE_RUNS = 5',
      'const HOST_CANCEL_TARGET_MS = 200', "judge('cancel', () => reportDuration(cancelMs, HOST_CANCEL_TARGET_MS,",
      "HOST_INTERFERENCE_TARGET_MS, '異なる1,000定義の組立の干渉（全経路）')", 'expectSavedFile(new Uint8Array(savedBytes), shown)',
      'await expectLoaded(page,', 'driveTwoGroups(page, initial)', 'HOST_TOTAL - driven.size',
      'RING_VOLUME_MM3.toFixed(3)', "expect(runs.some((run) => run.progressSeen)", 'expect(errors).toEqual([])',
      "expect(judgements,"]) expect(normalizedSource).toContain(normalizeWhitespace(token));
    expect(normalizedSource).toContain(normalizeWhitespace('for (let run = 0; run < INTERFERENCE_RUNS; run += 1)'));
    expect(normalizedSource).toContain(normalizeWhitespace("judge('interference completion', () => requireCompletedInterferenceRuns(runs, INTERFERENCE_RUNS))"));
    expect(normalizedSource).toContain(normalizeWhitespace("timeout: INTERFERENCE_FOLLOW_MS, message: 'interference result painted'"));
    expect(normalizedSource).toContain(normalizeWhitespace("await page.locator('.pcad-interference__close').click()"));
    expect(normalizedSource).toContain(normalizeWhitespace("completed: false, progressSeen, rows: [], summary: '', error: null"));
    expect(normalizedSource).toContain(normalizeWhitespace('if (measured.completed)'));
    const specs = ['assembly-1000-host.spec.ts', 'electron-assembly-1000-host.spec.ts']
      .map((spec) => readRootFile(`e2e/tests/${spec}`));
    expectHostInterferenceWindow(source, specs);
    // Reject the original stale window, an unapproved extension and mismatched per-spec limits.
    expect(() => expectHostInterferenceWindow(source.replace(/INTERFERENCE_FOLLOW_MS = [0-9_]+/u,
      'INTERFERENCE_FOLLOW_MS = 60_000'), specs)).toThrow();
    expect(() => expectHostInterferenceWindow(source.replace(/INTERFERENCE_FOLLOW_MS = [0-9_]+/u,
      'INTERFERENCE_FOLLOW_MS = 600_000'), specs)).toThrow();
    for (let index = 0; index < specs.length; index += 1) {
      expect(() => expectHostInterferenceWindow(source, specs.map((spec, i) => i === index
        ? spec.replace(/test\.setTimeout\([^)]*\)/gu, 'test.setTimeout(900_000)') : spec))).toThrow();
    }
    const recompute = normalizeWhitespace(readRootFile('e2e/tests/recompute.ts'));
    expect(recompute).toContain(normalizeWhitespace('export const KERNEL_TIMEOUT_MS = RECOMPUTE_TIMEOUT_MS'));
  });
});

describe('曲面返信の複合窓の参考値と機能上限の境界', () => {
  it('転用100msの必須判定を再導入せず、取消・有限待機・全機能を保持する', () => {
    const source = readRootFile('packages/expression/src/math/functionSurfaceReplyResponse.test.ts');
    const normalizedSource = normalizeWhitespace(source);
    expect(normalizedSource).toContain(normalizeWhitespace("import { observeDuration } from '../../../test-utils/src/releasePerformance.js'"));
    expect(normalizedSource).toContain(normalizeWhitespace('const LONG_TASK_REFERENCE_MS = 100'));
    expect(normalizedSource).toContain(normalizeWhitespace('observeDuration(record?.blockedMs ?? Number.NaN, LONG_TASK_REFERENCE_MS,'));
    expect(normalizedSource).toContain(normalizeWhitespace('observeDuration(record?.longestGapMs ?? Number.NaN, LONG_TASK_REFERENCE_MS,'));
    expect(normalizedSource).toContain(normalizeWhitespace('observeDuration(receivingGapMs, LONG_TASK_REFERENCE_MS,'));
    expect(normalizedSource).toContain(normalizeWhitespace('observeDuration(wholeGapMs, LONG_TASK_REFERENCE_MS,'));
    const hardTiming = /expect\s*\([^;]*?(?:blockedMs|longestGapMs|receivingGapMs|wholeGapMs)[^;]*?\)\s*\.toBeLessThan(?:OrEqual)?\s*\(/u;
    expect(source).not.toMatch(hardTiming);
    expect('expect(record?.longestGapMs ?? Infinity).toBeLessThanOrEqual(100);').toMatch(hardTiming);
    for (const kept of ['const CANCEL_DELIVERY_LIMIT_MS = 1_000', 'const RUN_LIMIT_MS = 60_000',
      'await client.evaluate(input, 30_000, abort.signal)',
      'expect(record?.cancelDeliveryMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(CANCEL_DELIVERY_LIMIT_MS)',
      "expect(record?.status).toBe('cancelled')", "expect(completion.status).toBe('cancelled')",
      "status: 'rejected', reason: 'budget'", "status: 'rejected', reason: 'overlap'",
      "status: 'rejected', reason: 'coverage'", 'work: 3_997_696', 'coveredCells: 16_384',
      'client.dispose(); await port.close()', 'Number.isFinite(record.totalMs)',
      'expect(record.totalMs).toBeGreaterThanOrEqual(0)',
      "expect((await stale.evaluate(input, 30_000)).status).toBe('worker-error')"]) expect(normalizedSource).toContain(normalizeWhitespace(kept));
    const requirements = normalizeWhitespace(readRootFile('docs/requirements.md'));
    expect(requirements).toContain(normalizeWhitespace('曲面返信のNode Worker準備・通信・OS待ち・受信検査を含む複合窓'));
    expect(requirements).toContain(normalizeWhitespace('100msは全実測と達否を保持する参考値'));
  });
});
