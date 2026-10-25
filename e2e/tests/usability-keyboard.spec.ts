import { expect, test } from '@playwright/test';
import { compositionFlows, drawingBusyReasonProof } from './usabilityKeyboardFlow.js';
import { installDrawingRefreshHold } from './holdDrawingRefresh.js';
import { connectRefusalsFlow } from './connectRefusalsFlow.js';
import { installStartupDiagnostics, waitForStartupHealth } from './startupHealth.js';

for (const [name, flow] of compositionFlows) test(`V103 R20 ${name}で入力所有・確定・取消を保つ`, async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await installStartupDiagnostics(page);
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  if (name === '図面の文字注記') await installDrawingRefreshHold(page);
  await page.goto('/'); await waitForStartupHealth(page, info);
  await flow(page, info);
  if (name === '図面の文字注記') await drawingBusyReasonProof(page, info);
  expect(errors).toEqual([]);
});

test('V103 R20 実選択数・同座標・要素種類の拒否理由と文書不変を既存独立fixtureで確認', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await installStartupDiagnostics(page);
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await waitForStartupHealth(page, info);
  await connectRefusalsFlow(page, info);
  expect(errors).toEqual([]);
  await info.attach('r20-selection-refusals', { contentType: 'application/json', body: JSON.stringify({
    environment: info.project.name, fixture: 'connectRefusalsFlow', source: 'real PCAD file + tree selection',
    reasonVisibility: 'radial hint and refusal status asserted by existing flow', allDisabledCellsCertified: false,
  }) });
});
