/// <reference lib="dom" />
import { expect, test, type Page } from '@playwright/test';
import { installStartupDiagnostics, waitForStartupHealth } from './startupHealth.js';

import { uiMessage } from './uiMessages.js';

test.use({ viewport: { width: 1440, height: 900 } });
test.beforeEach(async ({ page }, info) => {
  await installStartupDiagnostics(page);
  await page.goto('/');
  await waitForStartupHealth(page, info);
});

async function expectMark(page: Page, selector: string, description: string): Promise<void> {
  await expect(page.getByRole('status').filter({ hasText: description })).toBeVisible();
  const ring = page.locator('.pcad-coach-ring');
  await expect(ring).toBeVisible();
  await expect.poll(() => ring.evaluate((mark, targetSelector) => {
    const target = document.querySelector(targetSelector);
    if (!target) return false;
    const actual = mark.getBoundingClientRect();
    const expected = target.getBoundingClientRect();
    const dimensions = ['left', 'top', 'width', 'height'] as const;
    return dimensions.every(key => Math.round(actual[key]) === Math.round(expected[key]));
  }, selector)).toBe(true);
}

test('画面の案内をキーボードで5か所巡り、Escで始めたボタンへ戻る', async ({ page }) => {
  const name = uiMessage('commands', 'guide.start');
  const start = page.getByRole('button', { name, exact: true });
  const controls = page.getByRole('group', { name, exact: true });
  const next = controls.getByRole('button', { name: uiMessage('commands', 'guide.next'), exact: true });
  await expect(start).toBeVisible();
  await expect(controls).toHaveCount(0);
  await start.focus();
  await page.keyboard.press('Enter');
  await expect(start).toBeFocused();
  await expectMark(page, '[data-command-id="file.new"]', uiMessage('commands', 'guide.toolbar'));
  await page.keyboard.press('Tab');
  await expect(next).toBeFocused();
  await page.keyboard.press('Enter');
  await expectMark(page, '[data-command-id="toolbar.sketch.point"]', uiMessage('commands', 'guide.point'));
  await page.keyboard.press('Tab');
  await expect(controls.getByRole('button', { name: uiMessage('commands', 'guide.previous') })).toBeFocused();
  await page.keyboard.press('Enter');
  await expectMark(page, '[data-command-id="file.new"]', uiMessage('commands', 'guide.toolbar'));
  await page.keyboard.press('Shift+Tab');
  await expect(next).toBeFocused();
  for (const [selector, description] of [
    ['[data-command-id="toolbar.sketch.point"]', uiMessage('commands', 'guide.point')],
    ['[data-guide-id="history"]', uiMessage('commands', 'guide.history')],
    ['[data-guide-id="properties"]', uiMessage('commands', 'guide.properties')],
    ['[data-guide-id="statusBar"]', uiMessage('commands', 'guide.statusBar')],
  ] as const) {
    await page.keyboard.press('Enter');
    await expectMark(page, selector, description);
    await expect(next).toBeFocused();
  }
  await page.keyboard.press('Enter');
  await expect(controls.getByRole('button', { name: uiMessage('commands', 'tutorial.start') })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(controls).toHaveCount(0);
  await expect(page.locator('.pcad-coach-ring')).toHaveCount(0);
  await expect(start).toBeFocused();
});

test('設定の入口から見直し、Escで同じ入口へ戻る', async ({ page }) => {
  const gear = page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.settings.open'), exact: true });
  await gear.focus();
  await page.keyboard.press('Enter');
  const replay = page.getByRole('button', { name: uiMessage('commands', 'guide.replay') });
  await expect(replay).toBeVisible();
  await replay.focus();
  await page.keyboard.press('Enter');
  await expect(replay).toBeFocused();
  await page.keyboard.press('Tab');
  const controls = page.getByRole('group', { name: uiMessage('commands', 'guide.start'), exact: true });
  await expect(controls.getByRole('button', { name: uiMessage('commands', 'guide.next') })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(controls).toHaveCount(0);
  await expect(replay).toBeFocused();
});
