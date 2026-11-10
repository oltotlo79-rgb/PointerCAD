import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { openTarget } from './electronAppFlow.js';
import { beginRecompute, waitForRecompute, type RecomputeWaitKind } from './recompute.js';

/** Reopen may cold-start exact math in any document; finish its new generation, not the empty startup document. */
export async function reopenPart(
  page: Page, info: TestInfo, filename: string, app?: ElectronApplication, waitKind: RecomputeWaitKind = 'exact-math',
): Promise<void> {
  // Never reload a page that is still loading its editor module. Firefox aborts the old page's
  // fetches when the reload starts; the startup retry (apps/web/src/startupRecovery.ts) then
  // reads that as a failed module load and calls location.reload() itself, which replaces this
  // reload and rejects it with NS_BINDING_ABORTED (CI 1e06c93, name-search on Firefox).
  // The hook below is installed only after the editor module has loaded and mounted.
  await page.waitForFunction(() => typeof window.pcadRecomputeStats === 'function');
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
  await waitForRecompute(page, before, waitKind);
}
