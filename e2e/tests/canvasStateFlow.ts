/// <reference lib="dom" />
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { addImage, canvasRow, expectCanvasIdentity, expectImage, open, readPart, samplePng, save, sha256 } from './canvasAssetLifetimeFlow.js';
import { waitForStartupHealth } from './startupHealth.js';

/** 1440×900 の125%相当。実画像を選び、キーボード・保存再開・復号失敗を通す。 */
export async function canvasStateFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1152, height: 720 });
  await waitForStartupHealth(page, info);
  const bytes = await samplePng(page, 'rgb(255, 0, 0)', 128);
  await addImage(page, 'A.png', bytes); await expectImage(page, 'A');
  const row = canvasRow(page, 'A.png'), opacity = row.getByRole('textbox', { name: '濃さ A.png', exact: true });
  const scale = row.getByRole('button', { name: 'A.png の寸法を合わせる', exact: true });
  await expect(row.getByRole('status')).toHaveText('使用可能');
  await expect(row).toContainText('128 × 64 px'); await expect(row).toContainText('100 × 50 mm');
  await expect(scale).toBeEnabled();
  for (const name of ['A.png の表示を切り替える', 'A.png の寸法を合わせる', 'A.png を削除']) {
    const button = row.getByRole('button', { name, exact: true }); await button.scrollIntoViewIfNeeded();
    const rect = await button.boundingBox(); expect(rect).not.toBeNull();
    if (rect === null) throw new Error('Missing canvas control');
    expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.x + rect.width).toBeLessThanOrEqual(1152);
  }
  await opacity.fill(''); await expect(opacity).toHaveValue('');
  await opacity.pressSequentially('0.'); await expect(opacity).toHaveValue('0.');
  await expect(opacity).toBeFocused();
  expect(await opacity.evaluate(input => input instanceof HTMLInputElement ? input.selectionStart : null)).toBe(2);
  await opacity.press('Enter'); await expect(opacity).toHaveValue('0.');
  await opacity.press('Tab'); await expect(opacity).toHaveValue('0.');
  const intermediate = readPart(await save(page, info, 'canvas-intermediate.pcad', app));
  expect(intermediate.document.canvases[0].opacity.value).toBe(0.5);
  await opacity.focus(); await opacity.press('Escape'); await expect(opacity).toHaveValue('0.5');

  await opacity.dispatchEvent('compositionstart'); await opacity.fill('あ');
  await opacity.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await expect(opacity).toHaveValue('あ'); await expect(opacity).toBeFocused();
  await opacity.dispatchEvent('compositionend'); await opacity.press('Escape');
  await expect(opacity).toHaveValue('0.5');
  await opacity.fill('0.25'); await opacity.press('ArrowLeft'); await opacity.pressSequentially('1');
  await expect(opacity).toHaveValue('0.215'); await expect(opacity).toBeFocused();
  expect(await opacity.evaluate(input => input instanceof HTMLInputElement ? input.selectionStart : null)).toBe(4);
  await opacity.fill('0.25'); await opacity.press('Enter'); await expect(opacity).toBeFocused();
  await opacity.press('Tab');
  const committed = readPart(await save(page, info, 'canvas-opacity.pcad', app));
  expect(committed.document.canvases[0].opacity.value).toBe(0.25);
  await page.keyboard.press('Control+z'); await expect(opacity).toHaveValue('0.5');
  await page.keyboard.press('Control+y'); await expect(opacity).toHaveValue('0.25');
  const saved = await save(page, info, 'canvas-state.pcad', app);
  const parsed = readPart(saved), savedCanvas = parsed.document.canvases[0];
  expect(Buffer.from(parsed.attachments.canvases.get(savedCanvas.imageId) ?? [])).toEqual(bytes);
  await page.screenshot({ path: info.outputPath('canvas-state-input.png') });

  // Opening installs attachments before replacing the document. Hold all requests,
  // including that intermediate old-document request, until the current row is seen.
  await page.evaluate(() => {
    const original = window.createImageBitmap;
    const failures: ((reason: Error) => void)[] = [];
    const control = { fail: () => {
      window.createImageBitmap = original;
      for (const reject of failures) reject(new Error('Controlled canvas decode failure'));
    } };
    Object.assign(window, { __canvasStateDecode: control });
    window.createImageBitmap = () => new Promise<ImageBitmap>((_resolve, reject) => {
      failures.push(reject);
    });
  });
  await open(page, 'canvas-state.pcad', saved, info, app);
  await expect(row.getByRole('status')).toHaveText('読み込み中');
  await expect(row).toContainText('読み込み後に表示'); await expect(row).not.toContainText('128 × 64 px');
  await expect(scale).toBeDisabled(); await expect(opacity).toHaveValue('0.25');
  await page.evaluate(() => {
    if (!('__canvasStateDecode' in window)) throw new Error('Missing controlled decoder');
    const control = window.__canvasStateDecode;
    if (typeof control !== 'object' || control === null || !('fail' in control) || typeof control.fail !== 'function') throw new Error('Missing decoder failure');
    control.fail();
  });
  await expect(row.getByRole('status')).toHaveText('読込失敗'); await expect(scale).toBeDisabled();
  await expect(row).toContainText('再試行');
  await page.screenshot({ path: info.outputPath('canvas-state-failed.png') });
  const retry = row.getByRole('button', { name: 'A.png の画像読込を再試行', exact: true });
  await retry.scrollIntoViewIfNeeded();
  const retryBounds = await retry.boundingBox(); expect(retryBounds).not.toBeNull();
  if (retryBounds === null) throw new Error('Missing retry control');
  expect(retryBounds.x).toBeGreaterThanOrEqual(0); expect(retryBounds.x + retryBounds.width).toBeLessThanOrEqual(1152);
  await retry.focus(); await retry.press('Enter');
  await expect(row.getByRole('status')).toHaveText('使用可能'); await expect(scale).toBeEnabled();
  await expect(row).toContainText('128 × 64 px'); await expectImage(page, 'A');
  await scale.focus(); await scale.press('Enter');
  await expect(page.locator('.pcad-canvas-scale')).toContainText('1 点目を押してください');
  await page.locator('.pcad-canvas-scale').getByRole('button', { name: 'やめる', exact: true }).click();
  const retried = readPart(await save(page, info, 'canvas-retried.pcad', app));
  // 開き直すと画像番号は資産の衝突を避けて振り直される。名前・寸法・濃さ・画像のSHA-256で同一性を見る。
  const retriedCanvas = retried.document.canvases[0];
  expect({ ...retriedCanvas, imageId: savedCanvas.imageId }).toEqual(savedCanvas);
  expect(retried.document.canvases).toHaveLength(1);
  expectCanvasIdentity(retried, [{ name: 'A.png', width: 100, height: 50, sha: sha256(bytes) }]);
  expect(Buffer.from(retried.attachments.canvases.get(retriedCanvas.imageId) ?? [])).toEqual(bytes);
  await page.screenshot({ path: info.outputPath('canvas-state-ready.png') });
}
