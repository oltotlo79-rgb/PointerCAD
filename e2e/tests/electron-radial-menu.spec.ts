import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { radialMenuFlow } from './radialMenuFlow.js';
import { radialAssemblyFlow, radialDrawingFlow } from './radialMenuModesFlow.js';

for (const [name, flow] of [
  ['部品の8道具を選び、取消・実保存・Undo・F1を通す', radialMenuFlow],
  ['組立の8道具から規格部品を開き、取消と実保存で元の文書を保つ', radialAssemblyFlow],
  ['図面の8道具から文字を記入し、実保存・Undoで元へ戻せる', radialDrawingFlow],
] as const) test(`P12-9 実Electronの右クリックで${name}`, async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await flow(page, info, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});
