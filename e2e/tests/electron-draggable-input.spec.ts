import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { draggableCoordinatesFlow, draggableMathWindowFlow, draggableWindowBoundsFlow } from './draggableInputWindowsFlow.js';

for (const [name, flow] of [
  ['座標の窓の移動と点・線分の確定', draggableCoordinatesFlow],
  ['入力の窓の四辺と画面縮小', draggableWindowBoundsFlow],
  ['数式の窓の移動と適用', draggableMathWindowFlow],
] as const) test(`実Electronの${name}`, async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await flow(page);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
