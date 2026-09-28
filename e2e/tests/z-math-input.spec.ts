import { expect, test } from '@playwright/test';
import { mathDeclaredSymbolsFlow } from './mathDeclaredSymbolsFlow.js';
import { mathMappingsFlow } from './mathMappingsFlow.js';
import { mathNumericalRootFlow } from './mathNumericalRootFlow.js';
import { mathEquationSystemFlow } from './mathEquationSystemFlow.js';
import { mathEquationFlow } from './mathEquationFlow.js';
import { mathEllipticFlow } from './mathEllipticFlow.js';
import { mathLambertWFlow } from './mathLambertWFlow.js';
import { mathGammaFunctionFlow } from './mathGammaFunctionFlow.js';
import { mathLegendreFlow } from './mathLegendreFlow.js';
import { mathTaylorFlow } from './mathTaylorFlow.js';
import { mathSequenceFlow } from './mathSequenceFlow.js';
import { mathLinearFlow } from './mathLinearFlow.js';
import { mathSvdFlow } from './mathSvdFlow.js';
import { mathExactRuntimeFlow } from './mathExactRuntimeFlow.js';
import { mathExactLinearFlow } from './mathExactLinearFlow.js';
import { mathDiscreteRangesFlow } from './mathDiscreteRangesFlow.js';
import { mathInfiniteRangesFlow } from './mathInfiniteRangesFlow.js';
import { EXACT_COORDINATE_SCENARIO_TIMEOUT_MS, INFINITE_RANGES_SCENARIO_TIMEOUT_MS, focusField } from './mathEditorReady.js';
import { mathLineIntegralsFlow } from './mathLineIntegralsFlow.js';
import { mathDistributionsFlow } from './mathDistributionsFlow.js';
import { mathRegionIntegralsFlow } from './mathRegionIntegralsFlow.js';
import { INTEGRAL_SCENARIO_TIMEOUT_MS } from './mathIntegralsFlow.js';
import { CLOSED_INTEGRALS_SCENARIO_TIMEOUT_MS, mathClosedIntegralsFlow } from './mathClosedIntegralsFlow.js';

test.use({ viewport: { width: 1440, height: 900 } });
// なぜ分割したか: a-math-input.spec.ts と同じ理由(旧57件が直列1塊のため、実測
// 95.6〜100.2分〔CI run 36346675432、windows-latest shard 2/3、
// job-108697069540.log〕でCIの3組のうち1組だけが律速していた)。
// なぜこの名前(z-math-input.spec.ts)か: firefoxのtestMatch正規表現
// (/math-input\.spec\.ts$/)へ入りつつ、ファイル列挙のアルファベット順で
// tutorial.spec.ts より後に来る名前を意図して選んだ("z-"は「アルファベット順で
// 末尾」の意図)。
// どの組に入る想定か: 3組目(単独)。math-input.spec.ts(57件)のうち実測43.2分相当の
// 22件を持ち、a-math-input.spec.ts(1組目)・math-input.spec.ts(2組目、約43.1分)と
// 合わせて3組がほぼ均等になる。
// 根拠の実測: scratchpad/claude/agents/w95a-split-slow-specs/mi_times.txt と
// plan_chunks2.py(w95a)。
test.describe.configure({ mode: 'parallel' });
test('ADD-24 一様・指数・ポアソン分布の条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathDistributionsFlow(page, info); expect(errors).toEqual([]);
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

test('ADD-18 Lambert Wの二枝と原点と入力条件と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  // Includes a real symbolic derivative to check all shipped Python dependencies.
  test.setTimeout(360_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathLambertWFlow(page, info); expect(errors).toEqual([]);
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

test('ADD-18 Legendre多項式の次数と値と保存再編集・Undo・F1を通す', async ({ page }, info) => {
  // Includes separate exact-runtime preparations before and after document reopen.
  test.setTimeout(600_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathLegendreFlow(page, info); expect(errors).toEqual([]);
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
  test.setTimeout(EXACT_COORDINATE_SCENARIO_TIMEOUT_MS);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathSequenceFlow(page, info); expect(errors).toEqual([]);
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
  test.setTimeout(EXACT_COORDINATE_SCENARIO_TIMEOUT_MS);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathLineIntegralsFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-23 閉じた曲線・曲面の積分（∮・∯）を閉じていることを確かめてから計算し、閉じていない理由・構造入力・保存再開・Undo・F1を通す', async ({ page }, info) => {
  // MC-21b: six exact-runtime preparations in sequence, the same count as the coordinate flows (mathClosedIntegralsFlow.ts).
  test.setTimeout(CLOSED_INTEGRALS_SCENARIO_TIMEOUT_MS);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathClosedIntegralsFlow(page, info); expect(errors).toEqual([]);
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

test('ADD-20 特異値分解の成分選択・保存再編集・Undo・F1を独立した文書で通す', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await mathSvdFlow(page, info);
  expect(errors).toEqual([]);
});

test('ADD-26 方程式の解集合と選択・重根・保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(EXACT_COORDINATE_SCENARIO_TIMEOUT_MS);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathEquationFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-26 複数式の解と自由変数・条件・保存再編集・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(EXACT_COORDINATE_SCENARIO_TIMEOUT_MS);
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

test('ADD-25 記号の名前・意味・種類を保存再編集し、未指定値と型違反の拒否・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(600_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathDeclaredSymbolsFlow(page, info); expect(errors).toEqual([]);
});

test('ADD-25 写像の定義域と逆数との区別を保ち、合成・実保存再開・座標追従・Undo・F1を通す', async ({ page }, info) => {
  test.setTimeout(600_000);
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await mathMappingsFlow(page, info); expect(errors).toEqual([]);
});

test('MC-27d Firefoxで構造入力に焦点があるままEscで閉じても、開き直した構造入力へ焦点を入れて例外にならない', async ({ page }) => {
  // Firefox does not fire `blur` when the focused math-field is removed from the document
  // (Chromium does), so MathLive's internal "currently focused mathfield" reference stayed stale
  // and the next math-field to receive focus crashed inside MathLive's own onFocus/onBlur handling.
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); });
  await page.goto('/');
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const openStructured = async () => {
    await row.getByRole('button', { name: '数式で入力', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'この式を使う', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
    await expect(dialog.locator('math-field')).toBeVisible();
    await focusField(dialog.locator('math-field'));
  };
  await openStructured();
  // Esc while focus is still inside the structured field closes the dialog without first
  // moving focus elsewhere (unlike clicking a button), which is what reproduces the Firefox bug.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await openStructured();
  await expect(dialog.locator('math-field')).toBeFocused();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});
