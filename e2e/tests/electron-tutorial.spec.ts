import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { tutorialFlow, tutorialPauseFlow } from './tutorialFlow.js';

for (const [name, flow] of [
  ['Enterで点から穴のある板を作り、保存取消・実保存・再開まで通す', tutorialFlow],
  ['中断しても入力を保ち、不正値・取消・ヘルプで文書を変えない', tutorialPauseFlow],
] as const) test(`P12-10 実Electronの初回案内で${name}`, async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await flow(page, info, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});
