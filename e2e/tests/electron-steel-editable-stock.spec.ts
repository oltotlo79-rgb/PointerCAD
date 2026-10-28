import { expect, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { registerSteelEditableStockTests, registerSteelUiAcceptanceTests } from './steelEditableStockFlow.js';

const applications = new WeakMap<Page, ElectronApplication>();
const restarts = new WeakMap<Page, () => Promise<{ page: Page; app: ElectronApplication }>>();
const test = base.extend({
  page: async ({ playwright }, use, info) => {
    let active: ElectronApplication | undefined = (await launchDesktop(playwright, info)).app;
    const preparePage = async (app: ElectronApplication): Promise<Page> => {
      const page = await app.firstWindow();
      expect(page.url()).toBe('app://pointercad/index.html');
      await page.setViewportSize({ width: 1440, height: 900 });
      applications.set(page, app); restarts.set(page, restart);
      return page;
    };
    // 同一試験のprofileは既存launchDesktopが保ち、実process/Worker heapは作り直す。
    const restart = async (): Promise<{ page: Page; app: ElectronApplication }> => {
      const before = active;
      if (before === undefined) throw new Error('再起動するElectronがありません');
      active = undefined;
      await before.close();
      const { app } = await launchDesktop(playwright, info); active = app;
      return { page: await preparePage(app), app };
    };
    try { await use(await preparePage(active)); }
    finally { if (active !== undefined) await active.close(); }
  },
});

registerSteelEditableStockTests(test, page => applications.get(page));
registerSteelUiAcceptanceTests(test, page => applications.get(page), async page => {
  const restart = restarts.get(page);
  if (restart === undefined) throw new Error('鋼材検査のElectron再起動がありません');
  return restart();
});
