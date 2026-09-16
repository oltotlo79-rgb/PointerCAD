import { expect, test } from '@playwright/test';
import { mathInputFlow } from './mathInputFlow.js';
import { mathTensorFlow } from './mathTensorFlow.js';
import { mathIntegerFlow } from './mathIntegerFlow.js';
import { mathLinearFlow } from './mathLinearFlow.js';
import { mathEigenspaceFlow } from './mathEigenspaceFlow.js';
import { mathSvdFlow } from './mathSvdFlow.js';
import { mathExactRuntimeFlow } from './mathExactRuntimeFlow.js';
import { mathExactLinearFlow } from './mathExactLinearFlow.js';
import { uiMessage } from './uiMessages.js';

test.use({ viewport: { width: 1440, height: 900 } });
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
