import { expect, test } from '@playwright/test';
import { installStartupDiagnostics, waitForStartupHealth } from './startupHealth.js';
import { tutorialFlow, tutorialPauseFlow } from './tutorialFlow.js';

for (const [name, flow] of [
  ['Enterで点から穴のある板を作り、実保存・再開と再実行まで通す', tutorialFlow],
  ['中断しても入力を保ち、不正値・取消・ヘルプで文書を変えない', tutorialPauseFlow],
] as const) test(`P12-10 初回案内で${name}`, async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await installStartupDiagnostics(page);
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    }
  });
  await page.goto('/'); await waitForStartupHealth(page, info);
  await flow(page, info); expect(errors).toEqual([]);
});
