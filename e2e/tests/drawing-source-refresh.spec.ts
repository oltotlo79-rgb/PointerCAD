/// <reference lib="dom" />
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { expressionValueFromNumber as number } from '../../packages/expression/src/index.js';
import { readDrawingBundle, writeDocumentBundle } from '../../packages/io/src/index.js';
import { absoluteCoordinate, appendSolid, createEmptyPartDocument, createPartDocumentBundle, createPrimitiveFeature } from '../../packages/model/src/index.js';
import { chooseDrawingMenu } from './drawingManufacturingFixture.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';
import { drawingMessage as m } from './drawingMessages.js';

test('P8 元部品の100×40×60をA3の1:1で寸法記入し、元を120へ更新・Undo・保存往復する', async ({ page }, testInfo) => {
  const empty = createEmptyPartDocument(), box = createPrimitiveFeature(empty, 'box', { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) });
  if (box.shape.kind !== 'box') throw new Error('箱の定義なし');
  const feature = { ...box, shape: { ...box.shape, sizeX: number(100), sizeY: number(40), sizeZ: number(60) } };
  const part = appendSolid(empty, feature), nextPart = { ...part, solids: [{ ...feature, shape: { ...feature.shape, sizeX: number(120) } }] };
  const [initial, changed] = await Promise.all([writeDocumentBundle(createPartDocumentBundle(part)), writeDocumentBundle(createPartDocumentBundle(nextPart))]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  const token = await beginRecompute(page);
  const opening = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '開く', exact: true }).click();
  await (await opening).setFiles({ name: '板.pcad', mimeType: 'application/zip', buffer: Buffer.from(initial) });
  await waitForRecompute(page, token);
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/u }).first().click();
  await page.getByRole('button', { name: 'この部品から図面を作成', exact: true }).click();
  await expect(page.getByTestId('drawing-status-scale')).toHaveText(m('drawing.status.scale').replace('{ratio}', '1:1'), { timeout: KERNEL_TIMEOUT_MS });
  await expect.poll(() => page.locator('.pcad-drawing-svg [data-view-id="view-1"] path').count(), { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
  await expect(page.locator('.pcad-statusbar')).not.toContainText('作り直しています');
  const point = await page.locator('.pcad-drawing-svg [data-view-id="view-1"][data-layer-id="layer-1"] path').evaluateAll((paths) => {
    for (const path of paths) {
      if (!(path instanceof SVGPathElement)) continue;
      const a = path.getPointAtLength(0), b = path.getPointAtLength(path.getTotalLength()), matrix = path.getScreenCTM();
      if (matrix === null || Math.abs(a.y - b.y) > 0.01 || Math.abs(a.x - b.x) < 90) continue;
      const at = new DOMPoint((a.x + b.x) / 2, (a.y + b.y) / 2).matrixTransform(matrix); return { x: at.x, y: at.y };
    }
    throw new Error('幅100の実輪郭なし');
  });
  await page.mouse.click(point.x, point.y); await page.keyboard.press('Enter');
  const dimension = (value: string) => page.locator(`.pcad-drawing-svg [data-owner-id="dim-1"] [aria-label="${value}"]`);
  await expect(dimension('100')).toHaveCount(1);
  const updating = page.waitForEvent('filechooser'); await chooseDrawingMenu(page, 'ファイル', '元の部品・組立を取り込み直す');
  await (await updating).setFiles({ name: '板.pcad', mimeType: 'application/zip', buffer: Buffer.from(changed) });
  await expect(dimension('120')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
  await page.keyboard.press('Control+z'); await expect(dimension('100')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
  await page.getByRole('button', { name: 'やり直す', exact: true }).click(); await expect(dimension('120')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
  await page.screenshot({ path: testInfo.outputPath('drawing-source-updated.png'), fullPage: true });
  const saving = page.waitForEvent('download'); await page.keyboard.press('Control+s');
  const saved = await saving; await saved.saveAs(testInfo.outputPath('source-updated.pcadd'));
  const file = await saved.path(); if (file === null) throw new Error('図面保存なし');
  const bytes = await readFile(file), read = await readDrawingBundle(bytes);
  if (!read.ok || read.source.sourceKind !== 'part') throw new Error('元部品の保存なし');
  expect(read.source.document.solids[0]).toMatchObject({ shape: { sizeX: { value: 120 } } });
  expect(read.document.dimensions).toHaveLength(1);
  await page.reload(); const reopening = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '開く', exact: true }).click();
  await (await reopening).setFiles({ name: '更新済み.pcadd', mimeType: 'application/zip', buffer: bytes });
  await expect(dimension('120')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
});
