import { expect, test } from '@playwright/test';
import { draggableCoordinatesFlow, draggableMathWindowFlow, draggableWindowBoundsFlow } from './draggableInputWindowsFlow.js';

for (const [name, flow] of [
  ['座標の窓を見出しで動かし、焦点・Tab・Enter・Escと点・線分の入力を保つ', draggableCoordinatesFlow],
  ['入力の窓を画面内に収め、入力の増減と画面の縮小に追従する', draggableWindowBoundsFlow],
  ['数式の窓を動かし、画面縮小後も式を適用して点を作れる', draggableMathWindowFlow],
] as const) test(name, async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await flow(page);
  expect(errors).toEqual([]);
});
