import { expect, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';

/** Call once per spec: the page/app association belongs to that spec's fixture closure. */
export function createElectronAppFixture() {
  const applications = new WeakMap<Page, ElectronApplication>();
  const test = base.extend({
    page: async ({ playwright }, use, info) => {
      const { app } = await launchDesktop(playwright, info);
      try {
        const page = await app.firstWindow();
        expect(page.url()).toBe('app://pointercad/index.html');
        await page.setViewportSize({ width: 1440, height: 900 });
        applications.set(page, app);
        await use(page);
      } finally {
        await app.close();
      }
    },
  });
  return { test, applicationFor: (page: Page): ElectronApplication | undefined => applications.get(page) };
}
