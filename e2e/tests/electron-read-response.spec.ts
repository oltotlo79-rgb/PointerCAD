/// <reference lib="dom" />
import { prepareLargeNativeReadFixture } from './largeNativeReadFixture.js';
import { largeNativeReadFlow } from './largeNativeReadFlow.js';
import { test } from '@playwright/test';
import { readOrphanIntegrityFlow, readResponsivenessFlow } from './readResponsivenessFlow.js';
import { readLifecycleFlow } from './readLifecycleFlow.js';
import { launchDesktop } from './electronAppFlow.js';

for (const mib of [32, 128] as const) {
  test(`E04 ${mib}MiB独立ZIPの元bytesと読込返信添付の長さ/SHA`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info, { waitForStartup: false });
    try {
      await readOrphanIntegrityFlow(await app.firstWindow(), info, mib, app);
    } finally { await app.close(); }
  });
  for (const kind of ['orphan', 'referenced'] as const) {
    test(`E04 ${mib}MiB ${kind} 読込の実処理中100入力p95<100msと保存再開`, async ({ playwright }, info) => {
      test.setTimeout(300000);
      const { app } = await launchDesktop(playwright, info, { waitForStartup: false });
      try {
        await readResponsivenessFlow(await app.firstWindow(), info, mib, kind, app);
      } finally { await app.close(); }
    });
  }
}
for (const action of ['new-request', 'switch', 'dispose'] as const) {
  test(`E04 読込中${action}は実Workerを終了し旧結果を採らない`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    const page = await app.firstWindow();
    try {
    await readLifecycleFlow(page, info, action, app);
    } finally { await app.close(); }
  });
}


test('A-14 WebとDesktopの通常Openで同じ実ファイル256MiB超を範囲読取する', async ({ page, playwright }, info) => {
  test.setTimeout(300000);
  const fixture = await prepareLargeNativeReadFixture();
  try {
    await test.step('Webの標準ファイル選択', async () => {
      await page.addInitScript(() => {
        Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: undefined });
      });
      try {
        await page.goto('/');
        await largeNativeReadFlow(page, info, fixture);
      } finally {
        await page.context().close();
      }
    });
    await test.step('Desktopの選択済みファイル', async () => {
      const { app } = await launchDesktop(playwright, info);
      try {
        await largeNativeReadFlow(await app.firstWindow(), info, fixture, app);
      } finally {
        await app.close();
      }
    });
  } finally {
    await fixture.dispose();
  }
});
