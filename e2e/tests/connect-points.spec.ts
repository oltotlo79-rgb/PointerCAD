import { expect, test } from '@playwright/test';
import { CONNECTED_ENDPOINT_CASES, connectedVerticesFlow, connectPointsFlow } from './connectPointsFlow.js';
import { facePointsFlow, faceVerticesFlow } from './facePointsFlow.js';
import { connectRefusalsFlow } from './connectRefusalsFlow.js';
import { installStartupDiagnostics, waitForStartupHealth } from './startupHealth.js';

for (const spatial of [false, true]) test(`V103 ${spatial ? '3DのCtrl' : '2DのShift'}で選んだ2点を参照してつなぎ保存する`, async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await installStartupDiagnostics(page);
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await waitForStartupHealth(page, info);
  await connectPointsFlow(page, info, undefined, spatial); expect(errors).toEqual([]);
});

for (const mode of CONNECTED_ENDPOINT_CASES) test(`V103 ${mode}: 実pick・新世代追従・1Undo・保存復元`, async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await installStartupDiagnostics(page);
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await waitForStartupHealth(page, info);
  await connectedVerticesFlow(page, info, mode); expect(errors).toEqual([]);
});

for (const [title, flow] of [['2DのShiftで選んだ4点', facePointsFlow], ['3DのCtrlで選んだ立体の4頂点', faceVerticesFlow]] as const) {
  test(`V103 R30 ${title}から面を張り、並べ直し・1Undo・保存再開する`, async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await installStartupDiagnostics(page);
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    });
    await page.goto('/'); await waitForStartupHealth(page, info);
    await flow(page, info); expect(errors).toEqual([]);
  });
}

test('V103 R29/R30 7つの無効分類・右ドラッグ100・入力とIME・メニューキー・文書切替で旧選択を実行しない', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await installStartupDiagnostics(page);
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); await waitForStartupHealth(page, info);
  await connectRefusalsFlow(page, info); expect(errors).toEqual([]);
});
