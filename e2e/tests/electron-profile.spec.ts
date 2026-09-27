import { expect, test, type PlaywrightWorkerArgs, type TestInfo } from '@playwright/test';
import { launchDesktop, profileDirectoryFor } from './electronAppFlow.js';

/*
 * E2E-01c: launchDesktop() must give a restart within the same test attempt the same userData
 * directory (settings and autosaved state written before the restart must still be there after it --
 * the property electron-auto-save-settings.spec.ts and the other specs that call launchDesktop( more
 * than once rely on), while a different test, or a retried attempt of the same test, must never reuse
 * another attempt's leftover userData. E2E-01b (2026-09-24) made every launchDesktop() call mint a
 * fresh random directory regardless of which test/attempt it belonged to, breaking the first property
 * for every spec that restarts mid-test. This is a small, fast regression check for both properties,
 * independent of those larger specs.
 */
async function launchAndReadUserData(playwright: PlaywrightWorkerArgs['playwright'], info: TestInfo): Promise<string> {
  const { app } = await launchDesktop(playwright, info);
  try {
    return await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  } finally { await app.close(); }
}

test('E2E-01c 再起動はuserDataを保ち、別の検査とは異なる', async ({ playwright }, info) => {
  const firstUserData = await launchAndReadUserData(playwright, info);
  expect(firstUserData, 'launchDesktopが計算した場所を実Electronがそのまま使うこと').toBe(profileDirectoryFor(info));

  const secondUserData = await launchAndReadUserData(playwright, info);
  expect(secondUserData, '同じ検査内の再起動は同じuserDataを使うこと').toBe(firstUserData);

  const otherTest = { testId: `${info.testId}#other`, retry: info.retry };
  expect(profileDirectoryFor(otherTest), '別の検査(testId違い)は別のuserDataになること').not.toBe(firstUserData);
  const retried = { testId: info.testId, retry: info.retry + 1 };
  expect(profileDirectoryFor(retried), '同じ検査でも再試行(retry違い)は別のuserDataになること').not.toBe(firstUserData);
});
