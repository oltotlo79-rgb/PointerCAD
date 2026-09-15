import { expect, test } from '@playwright/test';
import { functionCurvePointFlow } from './functionCurvePointFlow.js';

test.use({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  // Firefox may keep the host's density despite the context override. Launch a
  // separate browser for this file, preserving the project's graphics prefs.
  // https://searchfox.org/mozilla-central/source/layout/base/nsPresContext.cpp
  launchOptions: async ({ browserName, launchOptions }, use) => {
    await use(browserName === 'firefox' ? {
      ...launchOptions,
      firefoxUserPrefs: { ...launchOptions.firefoxUserPrefs, 'layout.css.devPixelsPerPx': '2.0' },
    } : launchOptions);
  },
});

test('ADD-28 2倍の画素密度でも関数上の点とXYZの軸名を回転して確認できる', async ({ page }, info) => {
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    }
  });
  await page.goto('/');
  const density = await page.evaluate(() => ({
    ratio: window.devicePixelRatio,
    resolution: window.matchMedia('(resolution: 2dppx)').matches,
    viewport: [window.innerWidth, window.innerHeight],
  }));
  expect(density).toEqual({ ratio: 2, resolution: true, viewport: [1440, 900] });
  const pixels = await page.screenshot({ path: info.outputPath('high-dpi-viewport.png'), scale: 'device' });
  expect([pixels.readUInt32BE(16), pixels.readUInt32BE(20)]).toEqual([2880, 1800]);
  await functionCurvePointFlow(page, info, 'parametric');
});
