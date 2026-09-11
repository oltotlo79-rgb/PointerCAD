import { scriptToolsFlow } from './scriptToolsFlow.js';
import { scriptLimitsFlow } from './scriptLimitsFlow.js';
import { expect, test } from '@playwright/test';
import { scriptsFlow } from './scriptsFlow.js';
test('P11 自動作図の実Worker・保存・Undo・道具登録・隔離と中止', async ({ page }, info) => {
  test.setTimeout(150000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await scriptsFlow(page, info); expect(errors).toEqual([]);
});

test('P11 自動作図の実Worker・資源上限・中止応答・コード競合からの復旧', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await scriptLimitsFlow(page, info); expect(errors).toEqual([]);
});

test('P11 自動作図の実Worker・20道具の登録編集削除・moduleの編集と行表示', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await scriptToolsFlow(page, info); expect(errors).toEqual([]);
});
