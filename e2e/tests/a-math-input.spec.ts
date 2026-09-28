import { expect, test } from '@playwright/test';
import { mathDeclaredValuesFlow } from './mathDeclaredValuesFlow.js';
import { mathDeclaredRenameFlow } from './mathDeclaredRenameFlow.js';
import { mathSetBoundsFlow } from './mathSetBoundsFlow.js';
import { mathUnresolvedProblemFlow } from './mathUnresolvedProblemFlow.js';
import { mathComplexErrorFunctionsFlow } from './mathComplexErrorFunctionsFlow.js';
import { mathAiryFlow } from './mathAiryFlow.js';
import { mathInputFlow } from './mathInputFlow.js';
import { mathTensorFlow } from './mathTensorFlow.js';
import { EXACT_COORDINATE_SCENARIO_TIMEOUT_MS } from './mathEditorReady.js';
import { mathLimitsFlow } from './mathLimitsFlow.js';
import { mathProbabilityMomentsFlow } from './mathProbabilityMomentsFlow.js';
import { mathGammaBetaDistributionFlow } from './mathGammaBetaDistributionFlow.js';
import { uiMessage } from './uiMessages.js';
import { MATH_COVERAGE_SCENARIO_TIMEOUT_MS, mathCoverageFlow } from './mathCoverageFlow.js';

test.use({ viewport: { width: 1440, height: 900 } });
// なぜ分割したか: 旧 math-input.spec.ts 1本(57件、直列)は requireFile 単位で1塊の
// testGroup になり、CIの3分割(shard、件数ベースでPlaywrightのfilterForShardが
// 等分。実行時間は見ない)で必ず同じ組へ丸ごと入っていた。実測(CI run 36346675432、
// windows-latest shard 2/3、job-108697069540.log)で95.6〜100.2分かかり、他の2組
// より突出して遅い律速だった。
// なぜこの名前(a-math-input.spec.ts)か: firefoxのtestMatch正規表現
// (playwright.config.tsの/math-input\.spec\.ts$/、ファイル名末尾一致)へ入りつつ、
// ファイル列挙のアルファベット順で auto-save-settings.spec.ts より前に来る名前を
// 意図して選んだ("a-"は「アルファベット順で先頭」の意図。組の割当てはファイル名の
// 並び順で決まるため)。
// どの組に入る想定か: function-plot.spec.ts(24件、実測29.2分)と同じ1組目。この
// ファイルはmath-input.spec.tsの57件のうち実測13.9分相当の13件を持ち、
// 1組目の合計を function-plot.spec.ts と合わせて約43.1分(他2組と同程度)にする。
// 根拠の実測: scratchpad/claude/agents/w95a-split-slow-specs/mi_times.txt
// (CI run 36346675432 の job-108697069540.log から抽出した各テストの秒数)と
// plan_chunks2.py(実測秒数でのduration-balanced 3分割の計算)。
test.describe.configure({ mode: 'parallel' });
test('ADD-24 確率表の期待値・分散・条件付き確率の条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathProbabilityMomentsFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-18 複素数の誤差関数と成分と入力条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  // Includes a real symbolic derivative to check all shipped Python dependencies.
  test.setTimeout(360_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathComplexErrorFunctionsFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-18 Airyの四種類と原点と入力条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  // Includes a real symbolic derivative to check all shipped Python dependencies.
  test.setTimeout(360_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathAiryFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-24 Gamma・Beta分布の密度・累積・分位点の条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathGammaBetaDistributionFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-22 極限の左右・角度・不成立を区別し、表示切替・保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(EXACT_COORDINATE_SCENARIO_TIMEOUT_MS);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathLimitsFlow(page, info); expect(errors).toEqual([]);
});

test('追加計算部の読込み中でも取消で実Workerを終了し、次の入力を使える', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  let release: () => void = () => undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  const runtime = '**/exact-math/runtime/pyodide.asm.wasm';
  await page.route(runtime, async route => { await held; await route.abort('aborted'); });
  try {
    await page.goto('/');
    await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
    await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
    const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
    await row.getByRole('button', { name: '数式で入力', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'この式を使う', exact: true })).toBeEnabled();
    const requested = page.waitForRequest(request => request.url().endsWith('/exact-math/runtime/pyodide.asm.wasm'));
    await dialog.locator('textarea').fill('rank([[sqrt(2),1],[2,sqrt(2)]])'); await requested;
    await expect(dialog.locator('[role="status"]')).toContainText(uiMessage('math', 'math.preparingExact'));
    const worker = page.workers().find(worker => /\/math\.worker[-.]/u.test(worker.url()));
    expect(worker).toBeDefined(); if (worker === undefined) throw new Error('実際の数学Workerが見つかりません');
    let closed = false; worker.once('close', () => { closed = true; });
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect.poll(() => closed).toBe(true);
    await expect(dialog).toHaveCount(0); release(); await page.unrouteAll({ behavior: 'wait' });
    await row.getByRole('button', { name: '数式で入力', exact: true }).click();
    await dialog.locator('textarea').fill('2'); await expect(dialog.locator('[role="status"]')).toHaveText('= 2');
    await dialog.getByRole('button', { name: 'この式を使う', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await expect(row.locator('.pcad-field').nth(1).locator('.pcad-field__message')).toHaveText('= 2');
    expect(errors).toEqual([]);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('ADD-17 数学入力の実画面・係数追従・改名・Undo・保存再編集', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); console.error('[数学入力の画面例外]', error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await mathInputFlow(page, info);
  expect(errors).toEqual([]);
});

test('ADD-19 テンソルの添字指定・XYZ座標・保存再編集・Undo・F1を通す', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await mathTensorFlow(page, info);
  expect(errors).toEqual([]);
});

test('ADD-26 未解決の式と条件を保存再編集し、数値の拒否・取消・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(600_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathUnresolvedProblemFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-22 集合の上下限と極値を区別し、保存再編集・座標追従・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(EXACT_COORDINATE_SCENARIO_TIMEOUT_MS);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathSetBoundsFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-25 記号の改名で局所変数を変えず、予約名拒否・実保存再開・Undo・取消・F1を通す', async ({ page }, info) => {
  test.setTimeout(600_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathDeclaredRenameFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-25 記号の値の種類を確認し、実保存再開・値編集・座標追従・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(600_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathDeclaredValuesFlow(page, info); expect(errors).toEqual([]);
});

test('MC-21 追加の記号の候補・内積・成分・集合の場合分け・≈・∇・比・循環小数を係数と座標に使い、保存再開・Undo・F1を通す', async ({ page }, info) => {
  // Six exact-runtime preparations in sequence, the same count as the coordinate flows (mathCoverageFlow.ts).
  test.setTimeout(MATH_COVERAGE_SCENARIO_TIMEOUT_MS);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathCoverageFlow(page, info); expect(errors).toEqual([]);
});
