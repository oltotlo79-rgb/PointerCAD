import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { waitForStartupHealth } from './startupHealth.js';

// Each case uses a fresh real process and profile. These are separate required
// starts, not retries that could turn a failed launch into an apparent success.
for (let attempt = 1; attempt <= 5; attempt += 1) {
  test(`実Electronの起動同期 ${attempt}/5: 接続前のreadyを保留し実画面を開く`, async ({ playwright }, info) => {
    const { app, directory } = await launchDesktop(playwright, info);
    // Playwright releases the application dispatcher on close. Retain the real
    // child process while the application is alive, then inspect its exit.
    const child = app.process();
    try {
      expect(JSON.parse(await readFile(join(directory, 'bootstrap.json'), 'utf8'))).toEqual({
        loader: true, ready: false, windows: 0,
      });
      const page = await app.firstWindow();
      await expect(page.getByRole('button', { name: '開く', exact: true })).toBeVisible();
      await waitForStartupHealth(page, info);
      expect(page.url()).toBe('app://pointercad/index.html');
      expect(await app.evaluate(({ app: electronApp }) => electronApp.isReady())).toBe(true);
      await page.reload();
      await expect(page.getByRole('button', { name: '開く', exact: true })).toBeVisible();
      await waitForStartupHealth(page, info);
    } finally { await app.close(); }
    await expect.poll(() => child.exitCode).toBe(0);
  });
}
