import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { openTarget } from './electronAppFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';

/** Reopening must finish a generation after the file choice, not the empty startup document. */
export async function reopenPart(page: Page, info: TestInfo, filename: string, app?: ElectronApplication): Promise<void> {
  await page.reload();
  const open = page.getByRole('group', { name: 'ファイル', exact: true }).getByRole('button', { name: '開く', exact: true });
  await expect(open).toBeVisible();
  await page.waitForFunction(() => typeof window.pcadRecomputeStats === 'function');
  const before = await beginRecompute(page);
  if (app) {
    await openTarget(app, info.outputPath(filename));
    await open.click();
  } else {
    // Attach both rejection handlers before either operation can close the page.
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), open.click()]);
    await chooser.setFiles(info.outputPath(filename));
  }
  await waitForRecompute(page, before);
}
