import { test } from '@playwright/test';
import { readOrphanIntegrityFlow, readResponsivenessFlow } from './readResponsivenessFlow.js';
import { readLifecycleFlow } from './readLifecycleFlow.js';
import { FIREFOX_GRAPHICS_PREFS } from '../firefoxLaunch.js';
import { installStartupDiagnostics } from './startupHealth.js';
test.use({ browserName: 'firefox', launchOptions: { firefoxUserPrefs: FIREFOX_GRAPHICS_PREFS } });

test.beforeEach(async ({ page }) => {
  await installStartupDiagnostics(page);
  await page.addInitScript(() => {
    for (const key of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, key, { configurable: true, value: undefined });
  });
});

for (const mib of [32, 128] as const) {
  test(`E04 ${mib}MiB独立ZIPの元bytesと読込返信添付の長さ/SHA`, async ({ page }, info) => {
    await page.goto('/'); await readOrphanIntegrityFlow(page, info, mib);
  });
  for (const kind of ['orphan', 'referenced'] as const) {
    test(`E04 ${mib}MiB ${kind} 読込の実処理中100入力p95<100msと保存再開`, async ({ page }, info) => {
      test.setTimeout(300000);
      await page.goto('/'); await readResponsivenessFlow(page, info, mib, kind);
    });
  }
}
for (const action of ['new-request', 'switch', 'dispose'] as const) {
  test(`E04 読込中${action}は実Workerを終了し旧結果を採らない`, async ({ page }, info) => {
    await page.goto('/'); await readLifecycleFlow(page, info, action);
  });
}
