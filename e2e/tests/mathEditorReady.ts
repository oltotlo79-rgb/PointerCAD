import { expect, type Locator, type Page } from '@playwright/test';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { uiMessage } from './uiMessages.js';

// The full infinite-range scenario includes independent editor preparations,
// document reopen/recompute and Undo. Firefox reached the last edit at 360 s.
// Keep each operation's deadline; allow their cumulative scenario to finish.
export const INFINITE_RANGES_SCENARIO_TIMEOUT_MS = 600_000;

/** Preparing coefficients may load the exact runtime before the text field exists. */
export async function waitForMathEditorText(dialog: Locator): Promise<void> {
  const started = performance.now();
  const input = dialog.locator('textarea'), retry = dialog.getByRole('button', { name: uiMessage('math', 'math.retry'), exact: true });
  await expect(input.or(retry), '係数の準備を終え、数式の入力欄または準備失敗の理由を表示すること')
    .toBeVisible({ timeout: 225_000 });
  if (await retry.isVisible()) throw new Error('数式の入力準備に失敗: ' + await dialog.getByRole('alert').innerText());
  await expect(input).toBeVisible();
  console.log(`[実測] 数式入力の準備 ${String(Math.round(performance.now() - started))} ms`);
}

/** Verify the generation caused by Undo before inspecting its coefficient display or saving. */
export async function undoMathEdit(page: Page): Promise<void> {
  const before = await beginRecompute(page);
  await page.locator('canvas.pcad-viewport__canvas').focus();
  await page.keyboard.press('Control+z');
  await waitForRecompute(page, before);
}
