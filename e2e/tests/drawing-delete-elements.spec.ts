import { expect, test } from '@playwright/test';
import { drawingDeleteElementsFlow } from './drawingDeleteElementsFlow.js';
import { installStartupDiagnostics, waitForStartupHealth } from './startupHealth.js';

test('V103 F05 表・風船・寸法をDeleteとBackspaceで削除しUndoとRedoでIDを保つ', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await installStartupDiagnostics(page);
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await waitForStartupHealth(page, info);
  await drawingDeleteElementsFlow(page, info); expect(errors).toEqual([]);
});
