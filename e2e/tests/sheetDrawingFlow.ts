import { readFile } from 'node:fs/promises';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { readDrawingBundle, readPcadFile, writePcadFile } from '../../packages/io/src/index.js';
import { sheetDrawingVectorFlow } from './sheetDrawingExportFlow.js';

export async function sheetFlatDrawingFlow(page: Page, testInfo: TestInfo, partPath: string): Promise<void> {
  const form = page.getByRole('form', { name: '板金の展開', exact: true });
  await form.getByRole('button', { name: '展開から図面を作成', exact: true }).click();
  const paths = page.locator('.pcad-drawing-svg [data-owner-id="view-1"] path');
  await expect.poll(() => paths.count(), { timeout: 60_000 }).toBeGreaterThan(0);
  await expect(page.locator('.pcad-statusbar')).not.toContainText('作り直しています');
  const shapeText = () => paths.evaluateAll((elements) => elements.map((element) => element.getAttribute('d')).join('|'));
  const originalOutline = await shapeText();
  await sheetDrawingVectorFlow(page, testInfo);
  await page.screenshot({ path: testInfo.outputPath('sheet-flat-drawing.png') });
  const saving = page.waitForEvent('download'); await page.keyboard.press('Control+s');
  const file = testInfo.outputPath('sheet-flat.pcadd'); await (await saving).saveAs(file);
  const saved = await readDrawingBundle(await readFile(file)); if (!saved.ok) throw new Error(saved.error.message);
  expect(saved.document.views).toHaveLength(1);
  expect(saved.document.views[0]).toMatchObject({ direction: [0, 0, -1], xDir: [1, 0, 0] });
  expect(saved.document.source.flatSheet).toMatchObject({ sourceFeatureId: expect.any(String), fixedPanelId: expect.any(String), seamConnectionIds: [] });
  expect(saved.source.sourceKind).toBe('part');
  await page.reload();
  const opening = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '開く', exact: true }).click();
  await (await opening).setFiles(file);
  await expect.poll(() => paths.count(), { timeout: 60_000 }).toBeGreaterThan(0);
  await expect.poll(shapeText, { timeout: 60_000 }).toBe(originalOutline);
  await expect(page.locator('.pcad-drawing-svg [aria-label="上 90° R3"]')).toHaveCount(1);
  const original = readPcadFile(await readFile(partPath)); if (!original.ok) throw new Error(original.error.message);
  const changed = { ...original.document, solids: original.document.solids.map((feature) => feature.kind === 'sheetBase'
    ? { ...feature, rule: { ...feature.rule, thickness: { source: '3', display: '3', value: 3 } } } : feature) };
  const updated = writePcadFile(changed);
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/ }).first().click();
  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '元の部品・組立を取り込み直す', exact: true }).click();
  await (await choosing).setFiles({ name: '板厚変更.pcad', mimeType: 'application/zip', buffer: Buffer.from(updated) });
  await expect.poll(shapeText, { timeout: 60_000 }).not.toBe(originalOutline);
  await expect.poll(() => paths.count()).toBeGreaterThan(0);
  await expect(page.locator('.pcad-statusbar')).not.toContainText('作り直しています');
  await page.screenshot({ path: testInfo.outputPath('sheet-flat-drawing-updated.png') });
  const resaving = page.waitForEvent('download'); await page.keyboard.press('Control+s');
  const updatedPath = testInfo.outputPath('sheet-flat-updated.pcadd'); await (await resaving).saveAs(updatedPath);
  const refreshed = await readDrawingBundle(await readFile(updatedPath)); if (!refreshed.ok) throw new Error(refreshed.error.message);
  expect(refreshed.document.source.flatSheet).toEqual(saved.document.source.flatSheet);
  expect(refreshed.document.source.contentHash).not.toBe(saved.document.source.contentHash);
  await expect(page.locator('.pcad-drawing-svg [aria-label="上 90° R3"]')).toHaveCount(1);
  await page.locator('.pcad-toolbar').getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect.poll(shapeText, { timeout: 60_000 }).toBe(originalOutline);
}
