/// <reference lib="dom" />
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { readDrawingBundle, readPcaddFile, writeDocumentBundle } from '../../packages/io/src/index.js';
import { expressionValueFromNumber as number } from '../../packages/expression/src/index.js';
import { createPartDocumentBundle } from '../../packages/model/src/index.js';
import { fullManufacturingDrawing } from './gdtFullFixture.js';
import { chooseDrawingMenu, expectDrawingStroke } from './drawingManufacturingFixture.js';
import { drawingMessage as m } from './drawingMessages.js';
import { KERNEL_TIMEOUT_MS } from './recompute.js';

test('P9 全14種類の実形状参照・共通基準・基本角度・8溶接を編集し、再保存と全形式出力でも保持する', async ({ page }, testInfo) => {
  const fixture = await fullManufacturingDrawing();
  await page.setViewportSize({ width: 1600, height: 1000 });
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/'); const opening = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '開く', exact: true }).click();
  await (await opening).setFiles({ name: '全種類の製作指示.pcadd', mimeType: 'application/zip', buffer: Buffer.from(fixture.bytes) });
  const owner = (id: string) => page.locator(`.pcad-drawing-svg [data-owner-id="${id}"]`);
  await expect(owner('gdt-14').locator('[aria-label="0.05"]')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
  for (const item of [...fixture.document.gdtFrames, ...fixture.document.datums, ...fixture.document.weldSymbols]) await expectDrawingStroke(owner(item.id).locator('path'));
  await expect(page.getByRole('alert').filter({ hasText: m('drawing.manufacturing.outputUnresolved') })).toHaveCount(0);
  await expect(owner('gdt-8').locator('[aria-label="-"]')).toHaveCount(1);
  await expect(owner('dim-angle').locator('[aria-label="45°"]')).toHaveCount(1);
  const tree = page.locator('.pcad-panel--left'), sheet = page.locator('.pcad-drawing-sheet');
  const form = page.getByRole('form', { name: m('drawing.gdt.title'), exact: true });
  for (const [index, frame] of fixture.document.gdtFrames.entries()) {
    await tree.getByRole('button', { name: `幾何公差 ${index + 1}`, exact: true }).click();
    const row = form.getByRole('group', { name: m('drawing.gdt.row').replace('{number}', '1'), exact: true });
    await expect(row.getByLabel(m('drawing.gdt.characteristic'), { exact: true })).toHaveValue(frame.segments[0].characteristic);
    await row.getByLabel(m('drawing.gdt.characteristic'), { exact: true }).selectOption(frame.segments[0].characteristic);
    await row.getByLabel(m('drawing.gdt.value'), { exact: true }).fill(`${51 + index}/1000`);
    await form.getByRole('button', { name: m('drawing.action.apply'), exact: true }).click();
    await expect(owner(frame.id).locator(`[aria-label="${(51 + index) / 1000}"]`)).toHaveCount(1);
  }
  await tree.getByRole('button', { name: '幾何公差 9', exact: true }).click();
  await expect(form.getByRole('group', { name: m('drawing.gdt.basicDimensions'), exact: true }).getByRole('checkbox', { checked: true })).toHaveCount(1);
  await form.locator('strong').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('gdt-fourteen-types.png'), fullPage: true });
  async function save() {
    await sheet.focus(); const downloading = page.waitForEvent('download'); await page.keyboard.press('Control+s');
    const download = await downloading, path = await download.path(); if (path === null) throw new Error('図面保存なし');
    return { bytes: await readFile(path), download };
  }
  // 元ファイルを実際の選択UIから更新し、注記定義と形の関連付けを一緒に保持する。
  const original = await readDrawingBundle(fixture.bytes);
  if (!original.ok || original.source.sourceKind !== 'part') throw new Error('元部品なし');
  const part = original.source.document;
  const updatedPart = { ...part, solids: part.solids.map((feature, index) => index === 0 && feature.kind === 'primitive' && feature.shape.kind === 'box'
    ? { ...feature, shape: { ...feature.shape, sizeX: number(24) } } : feature) };
  const sourceBytes = await writeDocumentBundle(createPartDocumentBundle(updatedPart));
  const updating = page.waitForEvent('filechooser'); await chooseDrawingMenu(page, 'ファイル', m('drawing.sourceRefresh.title'));
  await (await updating).setFiles({ name: '製作指示.pcad', mimeType: 'application/zip', buffer: Buffer.from(sourceBytes) });
  await expect(owner('dim-box').locator('[aria-label="24"]')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
  for (const item of [...fixture.document.gdtFrames, ...fixture.document.datums, ...fixture.document.weldSymbols]) await expectDrawingStroke(owner(item.id).locator('path'));
  await expect(page.getByRole('alert').filter({ hasText: m('drawing.manufacturing.outputUnresolved') })).toHaveCount(0);
  await sheet.focus(); await page.keyboard.press('Control+z');
  await expect(owner('dim-box').locator('[aria-label="20"]')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  await expect(owner('dim-box').locator('[aria-label="24"]')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
  await page.screenshot({ path: testInfo.outputPath('gdt-source-updated.png'), fullPage: true });
  const saved = await save(); await saved.download.saveAs(testInfo.outputPath('gdt-fourteen.pcadd'));
  const updated = await readDrawingBundle(saved.bytes);
  if (!updated.ok || updated.source.sourceKind !== 'part') throw new Error('更新後の元部品なし');
  expect(updated.source.document).toEqual(updatedPart);
  const parsed = readPcaddFile(saved.bytes); if (!parsed.ok) throw new Error(parsed.error.message);
  expect(parsed.document.gdtFrames).toHaveLength(14); expect(parsed.document.weldSymbols).toEqual(fixture.document.weldSymbols);
  expect(parsed.document.datums).toEqual(fixture.document.datums); expect(parsed.document.dimensions).toEqual(fixture.document.dimensions);
  for (const [index, frame] of parsed.document.gdtFrames.entries()) expect(frame.segments[0].tolerance.expression.source).toBe(`${51 + index}/1000`);
  for (const format of ['svg', 'pdf', 'png', 'jpg', 'dxf']) {
    await chooseDrawingMenu(page, 'ファイル', '図面を書き出す');
    const output = page.getByRole('form', { name: '図面を書き出す', exact: true }); await output.getByLabel('ファイルの種類', { exact: true }).selectOption(format);
    const downloading = page.waitForEvent('download'); await output.getByRole('button', { name: '書き出す', exact: true }).click();
    const download = await downloading; await download.saveAs(testInfo.outputPath(`gdt-fourteen.${format}`));
    const path = await download.path(); if (path === null) throw new Error(`${format}なし`); const data = await readFile(path);
    expect(data.byteLength).toBeGreaterThan(100);
    if (format === 'svg') {
      const text = data.toString('utf8');
      for (const item of [...parsed.document.gdtFrames, ...parsed.document.weldSymbols]) expect(text).toContain(`data-owner-id="${item.id}"`);
      for (let index = 0; index < 14; index++) expect(text).toContain(`aria-label="${(51 + index) / 1000}"`);
    } else if (format === 'pdf') expect(data.subarray(0, 5).toString()).toBe('%PDF-');
    else if (format === 'png') expect([...data.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    else if (format === 'jpg') expect([...data.subarray(0, 3)]).toEqual([255, 216, 255]);
    else {
      const dxf = data.toString('utf8'); expect(dxf).toContain('ENTITIES'); expect(dxf).toContain('POLYLINE');
      // 公差値を受け側の字体へ置き換えず、輪郭として渡す。
      for (let index = 0; index < 14; index++) expect(dxf).not.toMatch(new RegExp(`(?:^|\\r?\\n)1\\r?\\n${((51 + index) / 1000).toFixed(3).replace('.', '\\.')}\\r?\\n`));
      await expect(page.locator('.pcad-statusbar__text')).toContainText('省略 0件');
    }
  }
  await page.reload(); const reopening = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '開く', exact: true }).click();
  await (await reopening).setFiles({ name: '保存済みの全公差.pcadd', mimeType: 'application/zip', buffer: saved.bytes });
  await expect(owner('gdt-14').locator('[aria-label="0.064"]')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
  const again = readPcaddFile((await save()).bytes); if (!again.ok) throw new Error(again.error.message);
  expect(again.document).toEqual(parsed.document);
  await page.screenshot({ path: testInfo.outputPath('gdt-fourteen-restored.png'), fullPage: true });
  expect(errors).toEqual([]);
});
