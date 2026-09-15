import { expect, test } from '@playwright/test';
import { installStartupDiagnostics, waitForStartupHealth } from './startupHealth.js';
import { radialMenuFlow } from './radialMenuFlow.js';
import { radialAssemblyFlow, radialDrawingFlow } from './radialMenuModesFlow.js';

for (const [name, flow] of [
  ['部品の8道具を選び、取消・実保存・Undo・F1を通す', radialMenuFlow],
  ['組立の8道具から規格部品を開き、取消と保存で元の文書を保つ', radialAssemblyFlow],
  ['図面の8道具から文字を記入し、保存・Undoで元へ戻せる', radialDrawingFlow],
] as const) test(`P12-9 右クリックで${name}`, async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await installStartupDiagnostics(page);
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    }
  });
  await page.goto('/'); await waitForStartupHealth(page, info);
  await flow(page, info); expect(errors).toEqual([]);
});
