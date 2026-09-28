import { expect, test } from '@playwright/test';
import { mathLimitBoundsFlow } from './mathLimitBoundsFlow.js';
import { mathDifferentialEquationFlow } from './mathDifferentialEquationFlow.js';
import { mathFourierSeriesFlow } from './mathFourierSeriesFlow.js';
import { mathIntegralTransformsFlow } from './mathIntegralTransformsFlow.js';
import { mathDiscreteFourierFlow } from './mathDiscreteFourierFlow.js';
import { mathComplexElementaryFlow } from './mathComplexElementaryFlow.js';
import { mathZetaFlow } from './mathZetaFlow.js';
import { mathBesselFunctionFlow } from './mathBesselFunctionFlow.js';
import { mathBetaFunctionFlow } from './mathBetaFunctionFlow.js';
import { mathErrorFunctionsFlow } from './mathErrorFunctionsFlow.js';
import { mathTaylorCoefficientFlow } from './mathTaylorCoefficientFlow.js';
import { mathGeneralProbabilityFlow } from './mathGeneralProbabilityFlow.js';
import { mathDiscreteQuantilesFlow } from './mathDiscreteQuantilesFlow.js';
import { mathTestDistributionsFlow } from './mathTestDistributionsFlow.js';
import { mathIntegerFlow } from './mathIntegerFlow.js';
import { mathEigenspaceFlow } from './mathEigenspaceFlow.js';
import { EXACT_COORDINATE_SCENARIO_TIMEOUT_MS, waitForMathEditorText } from './mathEditorReady.js';
import { mathDerivativesFlow } from './mathDerivativesFlow.js';
import { mathVectorCalculusAtFlow } from './mathVectorCalculusAtFlow.js';
import { mathNormalDistributionFlow } from './mathNormalDistributionFlow.js';
import { INTEGRAL_SCENARIO_TIMEOUT_MS, mathIntegralsFlow } from './mathIntegralsFlow.js';
import { INDEFINITE_INTEGRALS_SCENARIO_TIMEOUT_MS, mathIndefiniteIntegralsFlow } from './mathIndefiniteIntegralsFlow.js';
import { uiMessage } from './uiMessages.js';

test.use({ viewport: { width: 1440, height: 900 } });
// なぜ分割したか: a-math-input.spec.ts と同じ理由(旧57件が直列1塊のため、実測
// 95.6〜100.2分〔CI run 36346675432、windows-latest shard 2/3、
// job-108697069540.log〕でCIの3組のうち1組だけが律速していた)。
// なぜこのファイル名(元のmath-input.spec.tsを維持)か: アルファベット順で
// history-notes.spec.ts の後・name-search.spec.ts の前という元々の位置が、
// そのままCIの2組目に収まる位置だったため、ファイル名は変えずに中身だけ
// 実測所要ベースで22件(約43.1分相当)に絞った。
// どの組に入る想定か: 2組目(単独)。a-math-input.spec.ts(1組目、function-plot.spec.ts
// と合わせて約43.1分)・z-math-input.spec.ts(3組目、約43.2分)と合わせて3組が
// ほぼ均等になる。
// 根拠の実測: scratchpad/claude/agents/w95a-split-slow-specs/mi_times.txt と
// plan_chunks2.py(w95a)。
test.describe.configure({ mode: 'parallel' });
test('ADD-24 Gamma・Beta分布の入力準備失敗を表示された理由で直ちに検出する', async ({ page }) => {
  test.setTimeout(10_000);
  await page.setContent('<dialog open><p role="alert">係数名の変換に失敗しました</p><button></button></dialog>');
  await page.getByRole('button').evaluate((button, label) => { button.textContent = label; }, uiMessage('math', 'math.retry'));
  await expect(waitForMathEditorText(page.locator('dialog'))).rejects.toThrow('数式の入力準備に失敗: 係数名の変換に失敗しました');
});

test('ADD-18 複素関数の主値と原式と入力条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathComplexElementaryFlow(page, info); expect(errors).toEqual([]);
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

test('ADD-18 誤差関数の小さい値と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  // The real numeric path runs without preparing the optional symbolic engine.
  test.setTimeout(180_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathErrorFunctionsFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-21 展開の係数選択と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  // Includes separate exact-runtime preparations before and after document reopen.
  test.setTimeout(EXACT_COORDINATE_SCENARIO_TIMEOUT_MS);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathTaylorCoefficientFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-24 分布を宣言した確率と依存関係の条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  // Includes separate exact-runtime preparations before and after document reopen.
  test.setTimeout(EXACT_COORDINATE_SCENARIO_TIMEOUT_MS);
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

test('ADD-24 正規分布の密度・累積・分位点の条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathNormalDistributionFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-23 指定位置の勾配・行列成分・成立条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(EXACT_COORDINATE_SCENARIO_TIMEOUT_MS);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathVectorCalculusAtFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-22 指定位置の微分・高階・角度・不成立と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(EXACT_COORDINATE_SCENARIO_TIMEOUT_MS);
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

test('ADD-22 不定積分の原始関数と積分定数・係数と座標への適用不可・構造入力の往復・保存再開・Undo・F1を通す', async ({ page }, info) => {
  // MC-21b: six exact-runtime preparations in sequence, the same count as the coordinate flows (mathIndefiniteIntegralsFlow.ts).
  test.setTimeout(INDEFINITE_INTEGRALS_SCENARIO_TIMEOUT_MS);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathIndefiniteIntegralsFlow(page, info); expect(errors).toEqual([]);
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

test('ADD-20 固有空間の成分選択・保存再編集・Undo・F1を独立した文書で通す', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await mathEigenspaceFlow(page, info);
  expect(errors).toEqual([]);
});

test('ADD-26 離散フーリエ変換の符号と逆変換と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(EXACT_COORDINATE_SCENARIO_TIMEOUT_MS);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathDiscreteFourierFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-26 連続変換の成立範囲と数値選択と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(EXACT_COORDINATE_SCENARIO_TIMEOUT_MS);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathIntegralTransformsFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-26 フーリエ級数の係数と部分和と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(EXACT_COORDINATE_SCENARIO_TIMEOUT_MS);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathFourierSeriesFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-26 微分方程式の条件と解候補・保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(EXACT_COORDINATE_SCENARIO_TIMEOUT_MS);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathDifferentialEquationFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-22 上極限と下極限の方向・整数条件を保ち、保存再編集・座標追従・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(600_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathLimitBoundsFlow(page, info); expect(errors).toEqual([]);
});
