import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { waitForStartupHealth } from './startupHealth.js';
import { parameterSearchCsvFlow, type ParameterCsvIo } from './parameterSearchCsvFlow.js';

/** Web 版(Chromium・Firefox)。実ファイル選択(filechooser)とダウンロードで通す。 */
const webIo: ParameterCsvIo = {
  async importFile(page, button, path) {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()]);
    await chooser.setFiles(path);
  },
  async exportFile(page, button, path) {
    const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
    await download.saveAs(path);
    return readFile(path);
  },
};

test('R12/R13 100行のパラメータを検索・絞込し、CSV を往復・確認・取消・上限まで通す', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await waitForStartupHealth(page, info);
  await parameterSearchCsvFlow(page, info, webIo);
  expect(errors).toEqual([]);
});
