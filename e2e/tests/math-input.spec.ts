import { mathSetBoundsFlow } from './mathSetBoundsFlow.js';
import { mathUnresolvedProblemFlow } from './mathUnresolvedProblemFlow.js';
import { mathNumericalRootFlow } from './mathNumericalRootFlow.js';
import { mathDifferentialEquationFlow } from './mathDifferentialEquationFlow.js';
import { mathEquationSystemFlow } from './mathEquationSystemFlow.js';
import { mathEquationFlow } from './mathEquationFlow.js';
import { mathFourierSeriesFlow } from './mathFourierSeriesFlow.js';
import { mathIntegralTransformsFlow } from './mathIntegralTransformsFlow.js';
import { mathDiscreteFourierFlow } from './mathDiscreteFourierFlow.js';
import { mathComplexErrorFunctionsFlow } from './mathComplexErrorFunctionsFlow.js';
import { mathComplexElementaryFlow } from './mathComplexElementaryFlow.js';
import { mathZetaFlow } from './mathZetaFlow.js';
import { mathEllipticFlow } from './mathEllipticFlow.js';
import { mathAiryFlow } from './mathAiryFlow.js';
import { mathLambertWFlow } from './mathLambertWFlow.js';
import { mathBesselFunctionFlow } from './mathBesselFunctionFlow.js';
import { mathBetaFunctionFlow } from './mathBetaFunctionFlow.js';
import { mathGammaFunctionFlow } from './mathGammaFunctionFlow.js';
import { mathErrorFunctionsFlow } from './mathErrorFunctionsFlow.js';
import { mathLegendreFlow } from './mathLegendreFlow.js';
import { mathTaylorCoefficientFlow } from './mathTaylorCoefficientFlow.js';
import { mathTaylorFlow } from './mathTaylorFlow.js';
import { mathSequenceFlow } from './mathSequenceFlow.js';
import { mathGeneralProbabilityFlow } from './mathGeneralProbabilityFlow.js';
import { mathDiscreteQuantilesFlow } from './mathDiscreteQuantilesFlow.js';
import { mathTestDistributionsFlow } from './mathTestDistributionsFlow.js';
import { expect, test } from '@playwright/test';
import { mathInputFlow } from './mathInputFlow.js';
import { mathTensorFlow } from './mathTensorFlow.js';
import { mathIntegerFlow } from './mathIntegerFlow.js';
import { mathLinearFlow } from './mathLinearFlow.js';
import { mathEigenspaceFlow } from './mathEigenspaceFlow.js';
import { mathSvdFlow } from './mathSvdFlow.js';
import { mathExactRuntimeFlow } from './mathExactRuntimeFlow.js';
import { mathExactLinearFlow } from './mathExactLinearFlow.js';
import { mathDiscreteRangesFlow } from './mathDiscreteRangesFlow.js';
import { mathInfiniteRangesFlow } from './mathInfiniteRangesFlow.js';
import { INFINITE_RANGES_SCENARIO_TIMEOUT_MS, waitForMathEditorText } from './mathEditorReady.js';
import { mathLimitsFlow } from './mathLimitsFlow.js';
import { mathDerivativesFlow } from './mathDerivativesFlow.js';
import { mathVectorCalculusAtFlow } from './mathVectorCalculusAtFlow.js';
import { mathLineIntegralsFlow } from './mathLineIntegralsFlow.js';
import { mathDistributionsFlow } from './mathDistributionsFlow.js';
import { mathProbabilityMomentsFlow } from './mathProbabilityMomentsFlow.js';
import { mathGammaBetaDistributionFlow } from './mathGammaBetaDistributionFlow.js';
import { mathNormalDistributionFlow } from './mathNormalDistributionFlow.js';
import { mathRegionIntegralsFlow } from './mathRegionIntegralsFlow.js';
import { INTEGRAL_SCENARIO_TIMEOUT_MS, mathIntegralsFlow } from './mathIntegralsFlow.js';
import { uiMessage } from './uiMessages.js';

test.use({ viewport: { width: 1440, height: 900 } });
test('ADD-24 Gamma・Beta分布の入力準備失敗を表示された理由で直ちに検出する', async ({ page }) => {
  test.setTimeout(10_000);
  await page.setContent('<dialog open><p role="alert">係数名の変換に失敗しました</p><button></button></dialog>');
  await page.getByRole('button').evaluate((button, label) => { button.textContent = label; }, uiMessage('math', 'math.retry'));
  await expect(waitForMathEditorText(page.locator('dialog'))).rejects.toThrow('数式の入力準備に失敗: 係数名の変換に失敗しました');
});

test('ADD-24 一様・指数・ポアソン分布の条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathDistributionsFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-24 確率表の期待値・分散・条件付き確率の条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathProbabilityMomentsFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-18 複素関数の主値と原式と入力条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathComplexElementaryFlow(page, info); expect(errors).toEqual([]);
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

test('ADD-18 ゼータ関数の値と微分と入力条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  // Includes a real symbolic derivative to check all shipped Python dependencies.
  test.setTimeout(360_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathZetaFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-18 楕円積分の六種類と周期と入力条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  // Includes a real symbolic derivative to check all shipped Python dependencies.
  test.setTimeout(360_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathEllipticFlow(page, info); expect(errors).toEqual([]);
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

test('ADD-18 Lambert Wの二枝と原点と入力条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  // Includes a real symbolic derivative to check all shipped Python dependencies.
  test.setTimeout(360_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathLambertWFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-18 Bessel四種類の値と原点と入力条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  // Includes a real symbolic derivative to check all shipped Python dependencies.
  test.setTimeout(360_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathBesselFunctionFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-18 Betaの値と正の入力条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  // Includes a real symbolic derivative to check all shipped Python dependencies.
  test.setTimeout(360_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathBetaFunctionFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-18 Gammaの値と極の拒否と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  // Includes a real symbolic derivative to check all shipped Python dependencies.
  test.setTimeout(360_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathGammaFunctionFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-18 誤差関数の小さい値と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  // The real numeric path runs without preparing the optional symbolic engine.
  test.setTimeout(180_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathErrorFunctionsFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-18 Legendre多項式の次数と値と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  // Includes separate exact-runtime preparations before and after document reopen.
  test.setTimeout(600_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathLegendreFlow(page, info); expect(errors).toEqual([]);
});
test('ADD-21 展開の係数選択と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  // Includes separate exact-runtime preparations before and after document reopen.
  test.setTimeout(600_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathTaylorCoefficientFlow(page, info); expect(errors).toEqual([]);
});
test('ADD-21 級数の展開・打切り・収束と取消・F1を通す', async ({ page }, info) => {
  // Includes separate exact-runtime preparations before and after document reopen.
  test.setTimeout(600_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathTaylorFlow(page, info); expect(errors).toEqual([]);
});
test('ADD-21 数列と差分と漸化式の条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  // Includes separate exact-runtime preparations before and after document reopen.
  test.setTimeout(600_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathSequenceFlow(page, info); expect(errors).toEqual([]);
});
test('ADD-24 分布を宣言した確率と依存関係の条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  // Includes separate exact-runtime preparations before and after document reopen.
  test.setTimeout(600_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathGeneralProbabilityFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-24 離散分布の分位点と境界の条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathDiscreteQuantilesFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-24 χ²・t・F分布の密度・累積・分位点の条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathTestDistributionsFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-24 Gamma・Beta分布の密度・累積・分位点の条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathGammaBetaDistributionFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-24 正規分布の密度・累積・分位点の条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathNormalDistributionFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-23 面積分・流束・体積積分の向きと成立条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(INTEGRAL_SCENARIO_TIMEOUT_MS);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathRegionIntegralsFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-23 線積分の弧長・向き・成立条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(420_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathLineIntegralsFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-23 指定位置の勾配・行列成分・成立条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(360_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathVectorCalculusAtFlow(page, info); expect(errors).toEqual([]);
});
test('ADD-22 指定位置の微分・高階・角度・不成立と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(360_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathDerivativesFlow(page, info); expect(errors).toEqual([]);
});
test('ADD-22 積分の端点・内部の発散・無限区間と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(INTEGRAL_SCENARIO_TIMEOUT_MS);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathIntegralsFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-22 極限の左右・角度・不成立を区別し、表示切替・保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(360_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathLimitsFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-21 無限の和と積の成立条件・発散を区別し、座標と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(INFINITE_RANGES_SCENARIO_TIMEOUT_MS);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathInfiniteRangesFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-21 刻み幅のある和と積を座標へ使い、表示切替・保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(360_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathDiscreteRangesFlow(page, info); expect(errors).toEqual([]);
});
test('追加計算部で平方根の連立式・基底・解なし・非一意と保存再編集を通す', async ({ page }, info) => {
  test.setTimeout(360_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathExactLinearFlow(page, info); expect(errors).toEqual([]);
});
test('採用済みの追加計算部で厳密な階数・度とラジアン・交換・保存再編集を通す', async ({ page }, info) => {
  test.setTimeout(360_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathExactRuntimeFlow(page, info); expect(errors).toEqual([]);
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

test('ADD-20 連立一次式とQR分解の分野検索・成分指定・非一意拒否・保存・F1を通す', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await mathLinearFlow(page, info);
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

test('ADD-21 整数条件を係数と座標に使い、保存再編集・Undo・F1を通す', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await mathIntegerFlow(page, info);
  expect(errors).toEqual([]);
});

for (const { name, flow } of [
  { name: '固有空間', flow: mathEigenspaceFlow },
  { name: '特異値分解', flow: mathSvdFlow },
]) {
  test(`ADD-20 ${name}の成分選択・保存再編集・Undo・F1を独立した文書で通す`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => { errors.push(error.message); });
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    });
    await page.goto('/');
    await flow(page, info);
    expect(errors).toEqual([]);
  });
}

test('ADD-26 離散フーリエ変換の符号と逆変換と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(360_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathDiscreteFourierFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-26 連続変換の成立範囲と数値選択と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(600_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathIntegralTransformsFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-26 フーリエ級数の係数と部分和と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(600_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathFourierSeriesFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-26 方程式の解集合と選択・重根・保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(600_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathEquationFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-26 複数式の解と自由変数・条件・保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(600_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathEquationSystemFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-26 数値解の区間と未解決・選択・保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(600_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathNumericalRootFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-26 微分方程式の条件と解候補・保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(600_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathDifferentialEquationFlow(page, info); expect(errors).toEqual([]);
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
  test.setTimeout(600_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathSetBoundsFlow(page, info); expect(errors).toEqual([]);
});
