import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
  ])('%sが性能測定の固定順を使う', (path) => {
    const config = readRootFile(path);

    expect(config).toContain('PerformanceFirstSequencer');
    expect(config).toContain('sequence: { sequencer: PerformanceFirstSequencer }');
    expect(config).toContain('fileParallelism:');
  });

  it('板金の性能判定が共通の目標記録と実用性の判定へ接続される', () => {
    const source = readRootFile('packages/model/src/sheetMetal/sheetPerformance.test.ts');
    expect(source).toContain("import { expectWithinBudget } from '@pointercad/test-utils'");
    expect(source).toMatch(/expectWithinBudget\(elapsed, 5000,/u);
    expect(source).toMatch(/expectWithinBudget\(elapsed, 500,/u);
    expect(source).not.toMatch(/expect\(elapsed\)\.toBeLessThan/u);
  });

  it.each(['model', 'kernel', 'expression'])('%sの実形状検査はCommit・CIでも1 workerに固定する', (name) => {
    const config = readRootFile(`packages/${name}/vitest.config.ts`);
    // 完了までの有限な待機枠を保ち、環境変数で並列へ戻さない。
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

  it('全パッケージの結果検査は5秒の既定値へ戻さず、速度目標と別の有限枠を使う', () => {
    const policy = readRootFile('packages/test-utils/src/releasePerformance.ts');
    expect(policy).toContain('export const FUNCTIONAL_TEST_TIMEOUT_MS = 60_000');
    for (const folder of ['packages', 'apps']) {
      for (const name of readdirSync(new URL(`${folder}/`, rootUrl))) {
        const path = `${folder}/${name}/vitest.config.ts`;
        if (!existsSync(new URL(path, rootUrl))) continue;
        const config = readRootFile(path);
        // 実OCCTを起動するカーネルの既存120秒は短縮しない。
        expect(config, path).toContain(name === 'kernel'
          ? 'testTimeout: 120_000' : 'testTimeout: FUNCTIONAL_TEST_TIMEOUT_MS');
      }
    }
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
    const recompute = readRootFile('e2e/tests/recompute.ts');
    const reopen = readRootFile('e2e/tests/reopenPart.ts');
    expect(recompute).toContain('export const KERNEL_TIMEOUT_MS = RECOMPUTE_TIMEOUT_MS');
    expect(recompute).toContain('timeout: KERNEL_TIMEOUT_MS');
    expect(recompute).toContain(".not.toBe('waiting')");
    expect(recompute).toContain("expect(last.stats?.lastOutcome,");
    expect(recompute).toContain(".toBe(outcome)");
    expect(recompute).toContain("waitForRecomputeOutcome(page, token, 'success')");
    expect(reopen).toContain('waitForRecompute(page, before)');
    const policy = readRootFile('packages/test-utils/src/releasePerformance.ts');
    expect(policy).toContain('export const RECOMPUTE_TIMEOUT_MS = 150_000');
    expect(policy).not.toMatch(/process\.env|import\.meta\.env/u);
  });
});

describe('1000点スケッチの機能優先と時間観測の境界', () => {
  it('100msは全描画と最終previewの参考値とし、取消・有限待機・幾何・保存の判定は保持する', () => {
    const source = readRootFile('e2e/tests/sketchConnected1000Flow.ts');
    expect(source).toContain("import { observeDuration } from '../../packages/test-utils/src/releasePerformance.js'");
    expect(source).toContain('observeDuration(row.renderedAtMs - row.eventAtMs, 100,');
    expect(source).toContain('observeDuration(finalPreview.renderedAtMs - finalPreview.eventAtMs, 100,');
    expect(source).not.toMatch(/expect\((?:row|finalPreview)\.renderedAtMs\s*-\s*(?:row|finalPreview)\.eventAtMs\)\.toBeLessThan/u);
    expect(source).toContain('durationObservations.push(observeDuration(');
    expect(source).toContain("attachJsonEvidence(info, 'sketch-duration-observations.json'");
    expect(source).toContain("decisionUse: 'observation', samples: durationObservations");
    expect(source).toContain("await writeFile(path, JSON.stringify(value), { flag: 'wx' })");
    expect(source).toContain("await info.attach(name, { path, contentType: 'application/json' })");
    expect(source).toContain("attachJsonEvidence(info, 'sketch-input-scene-render.json'");
    expect(source).toContain('expect(cancelTiming.renderedAtMs - cancelTiming.eventAtMs).toBeLessThanOrEqual(1000)');
    expect(source).toContain("{ polling: 'raf', timeout: 30_000 }");
    expect(source).toContain("expect(timing.boundary).toBe('scene-render-return')");
    expect(source).toContain('expect(timing.clockValid).toBe(true)');
    expect(source).toContain('expect(timing.overflow).toBe(0)');
    expect(source).toContain('!Number.isFinite(row.eventAtMs) || !Number.isFinite(row.renderedAtMs)');
    expect(source).toContain('row.eventAtMs < 0 || row.renderedAtMs < 0');
    expect(source).toContain('expect(position,');
    expect(source).toContain('.toBeLessThanOrEqual(SKETCH_TOLERANCE_MM)');
    expect(source).toContain('.toBeLessThanOrEqual(CONSTRAINT_TOLERANCE)');
    expect(source).toContain('const TARGET_TOLERANCE_MM = 1');
    expect(source).toContain('expect(afterCancel.document).toEqual(beforeCancel.document)');
    expect(source).toContain('await waitForRecompute(page, commit)');
    expect(source).toContain('expect(sketch.constraints).toEqual(writtenConstraints)');
    expect(source).toContain('const translation = expectRigidTranslation(sketch)');
    expect(source).toContain('await expect(undoButton(page)).toBeEnabled()');
    expect(source).toContain("attachJsonEvidence(info, 'sketch-connected-1000-final-observation.json'");
  });
});

describe('OCCT起動の機能優先と比較観測の境界', () => {
  it('比率だけのhard assertionを拒否し、5組・実形状・cleanupと生JSON保存を保持する', () => {
    const source = readRootFile('e2e/tests/occtCompileReuseFlow.ts');
    const start = source.indexOf('export async function assertFiveOcctPairs(');
    expect(start).toBeGreaterThan(0);
    const judge = source.slice(start);
    const hardComparison = /expect\s*\([^;]*?\)\s*\.\s*(?:toBeLessThan(?:OrEqual)?|toBeGreaterThan(?:OrEqual)?|toBeCloseTo)\s*\(/u;
    expect(judge).not.toMatch(hardComparison);
    expect(judge).not.toMatch(/expect\s*\([^;]*(?:cold|warm|ratio|meetsTarget|referenceRatio)[^;]*?\)\s*\.\s*(?:toBe|toEqual|toBeTruthy)\s*\(/u);
    expect('expect(warm).toBeLessThanOrEqual(cold * 0.8);').toMatch(hardComparison);
    expect('expect(observation.ratio).toBeLessThanOrEqual(0.8);').toMatch(hardComparison);
    expect(judge).not.toMatch(/\b(?:if|throw)\b[^;]*(?:ratio|meetsTarget|referenceRatio|0\.8)/u);
    expect(judge).toContain('observeStartupReuse(');
    expect(judge).toContain('pairs.map(pair => pair.cold.startupMs)');
    expect(judge).toContain('pairs.map(pair => pair.warm.startupMs)');
    expect(judge).toContain('expect(pairs).toHaveLength(5)');
    expect(judge).toContain('new Set(pairs.map(pair => pair.profile)).size).toBe(5)');
    expect(judge).toContain('toEqual([1, 2, 3, 4, 5])');
    expect(judge).toContain("persistOcctEvidence(info, 'five-pair-raw-measurements'");
    expect(judge).toContain("persistOcctEvidence(info, 'five-pair-medians'");
    expect(source).toContain("await writeFile(path, JSON.stringify(value, null, 2), { flag: 'wx' })");
    expect(source).toContain("await info.attach(name, { path, contentType: 'application/json' })");
    for (const kept of ['expect(warm.sha256).toBe(cold.sha256)', 'await sampler?.stop()',
      'await context?.close()', 'await app?.close()', 'expect(starts).toHaveLength(2)',
      'expect(ready).toHaveLength(2)', "waitForRecompute(page, token)"]) expect(source).toContain(kept);
    for (const path of ['e2e/tests/occt-compile-reuse-solid.spec.ts', 'e2e/tests/electron-occt-compile-reuse.spec.ts']) {
      const spec = readRootFile(path);
      expect(spec).toContain('for (const offline of [false, true])');
      expect(spec).toContain('index <= 5');
      expect(spec).toContain('if (index === 5) await assertFiveOcctPairs(pairs, info)');
    }
  });
});

describe('1000部品の参考4観測と安全・機能条件の境界', () => {
  it('open/save/reopen/FPSだけのhard再混入を拒否し、有限待機と全機能を維持する', () => {
    const source = readRootFile('e2e/tests/assembly1000HostFlow.ts');
    expect(source).toContain('observePositiveDuration(actualMs, targetMs, label)');
    expect(source).toContain('observeViewportRate(fps,');
    expect(source).not.toMatch(/judge\('(open|save|reopen|fps)'/u);
    expect(source).not.toMatch(/reportViewportRate\(/u);
    expect(source).not.toMatch(/expect\([^;]*(?:openToDrawnMs|reopenToDrawnMs|saveMs|fps\.fps)[^;]*\)\.toBe(?:LessThan|GreaterThan)/u);
    expect(source).not.toMatch(/expect\([^;]*(?:meetsTarget|referenceTargetFps)[^;]*\)\.(?:toBe|toEqual)/u);
    expect("judge('open', () => reportDuration(openToDrawnMs, HOST_LOAD_TARGET_MS, 'open'));").toMatch(/judge\('(open|save|reopen|fps)'/u);
    for (const name of ['open', 'save', 'reopen']) expect(source).toContain(`'${name}',`);
    expect(source).toContain('const HOST_LOAD_TARGET_MS = 5_000');
    expect(source).toContain('const HOST_SAVE_TARGET_MS = 5_000');
    expect(source).toContain("attachHostObservation(info, `assembly-1000-${name}-duration.json`");
    expect(source).toContain("attachHostObservation(info, 'assembly-1000-fps-raw.json', fps)");
    expect(source).toContain("attachHostObservation(info, 'assembly-1000-observations.json'");
    expect(source).toContain("await writeFile(path, JSON.stringify(value, null, 2), { flag: 'wx' })");
    expect(source).toContain("await info.attach(name, { path, contentType: 'application/json' })");
    for (const token of ['const INTERFERENCE_RUNS = 5', 'const INTERFERENCE_FOLLOW_MS = 60_000',
      'const HOST_CANCEL_TARGET_MS = 200', "judge('cancel', () => reportDuration(cancelMs, HOST_CANCEL_TARGET_MS,",
      "'異なる1,000定義の組立の干渉（全経路）', 'interference'", 'expectSavedFile(new Uint8Array(savedBytes), shown)',
      'await expectLoaded(page,', 'driveTwoGroups(page, initial)', 'HOST_TOTAL - driven.size',
      'RING_VOLUME_MM3.toFixed(3)', "expect(runs.some((run) => run.progressSeen)", 'expect(errors).toEqual([])',
      "expect(judgements,"]) expect(source).toContain(token);
    for (const spec of ['assembly-1000-host.spec.ts', 'electron-assembly-1000-host.spec.ts']) {
      expect(readRootFile(`e2e/tests/${spec}`)).toContain('const HOST_1000_TEST_TIMEOUT_MS = 900_000');
    }
    expect(readRootFile('e2e/tests/recompute.ts')).toContain('export const KERNEL_TIMEOUT_MS = RECOMPUTE_TIMEOUT_MS');
  });
});
