import { expect, test } from '@playwright/test';
import { mathInputFlow } from './mathInputFlow.js';
import { mathTensorFlow } from './mathTensorFlow.js';
import { mathIntegerFlow } from './mathIntegerFlow.js';
import { mathLinearFlow } from './mathLinearFlow.js';
import { mathEigenspaceFlow } from './mathEigenspaceFlow.js';
import { mathSvdFlow } from './mathSvdFlow.js';

test.use({ viewport: { width: 1440, height: 900 } });
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
