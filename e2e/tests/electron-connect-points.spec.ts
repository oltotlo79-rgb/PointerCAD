import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { CONNECTED_ENDPOINT_CASES, connectedVerticesFlow, connectPointsFlow } from './connectPointsFlow.js';
import { drawingDeleteElementsFlow } from './drawingDeleteElementsFlow.js';
import { facePointsFlow, faceVerticesFlow } from './facePointsFlow.js';
import { connectRefusalsFlow } from './connectRefusalsFlow.js';

for (const spatial of [false, true]) test(`V103 実Electron ${spatial ? '3DのCtrl' : '2DのShift'}で2点をつなぎ実保存する`, async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await connectPointsFlow(page, info, app, spatial); expect(errors).toEqual([]);
  } finally { await app.close(); }
});

for (const mode of CONNECTED_ENDPOINT_CASES) test(`V103 実Electron ${mode}: 実pick・新世代追従・1Undo・実保存復元`, async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await connectedVerticesFlow(page, info, mode, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});
test('V103 実Electron F05 表・風船・混合選択の共通削除と実保存', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await drawingDeleteElementsFlow(page, info, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});

for (const [title, flow] of [['2DのShiftで選んだ4点', facePointsFlow], ['3DのCtrlで選んだ立体の4頂点', faceVerticesFlow]] as const) {
  test(`V103 R30 実Electron ${title}から面を張り、1Undo・実保存復元する`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    try {
      const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      await flow(page, info, app); expect(errors).toEqual([]);
    } finally { await app.close(); }
  });
}

test('V103 R29/R30 実Electron 7つの無効分類・右ドラッグ100・入力とIME・メニューキー・文書切替で旧選択を実行しない', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await connectRefusalsFlow(page, info, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});
