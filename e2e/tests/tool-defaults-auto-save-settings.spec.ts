import { expect, test } from '@playwright/test';
import { toolDefaultsSettingsFlow } from './toolDefaultsSettingsFlow.js';
import { templateToolDefaultsFlow } from './templateToolDefaultsFlow.js';
import { drawingToolDefaultsFlow } from './drawingToolDefaultsFlow.js';
import { coordinateToolDefaultsFlow } from './coordinateToolDefaultsFlow.js';

test('P12-8 道具の数値初期値を取消・適用し、開始時の写し・保存・再読込・Undo・F1を通す', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    }
  });
  await page.goto('/'); await toolDefaultsSettingsFlow(page, info); expect(errors).toEqual([]);
});

test('P12-8 ひな形のmm初期値とinch入力を区別し、円の原式と半径を保存再開で保つ', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    }
  });
  await page.goto('/'); await templateToolDefaultsFlow(page, info); expect(errors).toEqual([]);
});

test('P12-8 図面初期値を新規注記へ使い、入力途中と既存注記・保存再開・Undoを保つ', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    }
  });
  await page.goto('/'); await drawingToolDefaultsFlow(page, info); expect(errors).toEqual([]);
});

test('P12-8 絶対・相対・極座標の初期値を区別し、連続入力と実座標・式・保存再開を保つ', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    }
  });
  await page.goto('/'); await coordinateToolDefaultsFlow(page, info); expect(errors).toEqual([]);
});
