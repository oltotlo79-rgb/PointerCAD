/// <reference lib="dom" />
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { expressionValueFromNumber as number } from '../../packages/expression/src/index.js';
import { readDrawingBundle, writeDocumentBundle } from '../../packages/io/src/index.js';
import {
  absoluteCoordinate, appendSolid, createEmptyPartDocument, createPartDocumentBundle, createPrimitiveFeature, synchronizeConfigurations,
} from '../../packages/model/src/index.js';
import { chooseDrawingMenu } from './drawingManufacturingFixture.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';
import { drawingMessage as m } from './drawingMessages.js';
import { captureManualDetail } from './captureManualDetail.js';

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
  const updating = page.waitForEvent('filechooser'); await chooseDrawingMenu(page, 'ファイル', '元の部品・アセンブリを取り込み直す');
  await (await updating).setFiles({ name: '板.pcad', mimeType: 'application/zip', buffer: Buffer.from(changed) });
  await expect(dimension('120')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
  await page.keyboard.press('Control+z'); await expect(dimension('100')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
  await page.getByRole('button', { name: 'やり直す', exact: true }).click(); await expect(dimension('120')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
  await captureManualDetail(page, testInfo, { name: 'drawing-source-updated', dialog: page.locator('.pcad-drawing-sheet'),
    fixture: { sizeX: 120 }, script: new URL(import.meta.url) });
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

/*
 * J-05c 係数の表: 表の行は保存せず、表示のたびに図面の元(埋め込みの部品)の係数から作る(packages/ui/src/drawing/tableDisplay.ts の
 * parameter の枝 → drawingNoteFields.ts の drawingParameterRows)。元を取り込み直すと、埋め込みの部品と図面の元の指紋が一緒に替わる
 * (refreshDrawingSource.ts の applyDrawing)ので、表の値も替わる。表の文字は SVG の aria-label に出る(packages/drawing/src/render/toSvg.ts)。
 */
test('J-05c 元の部品の係数を係数の表に並べ、元を取り込み直すと値が替わり、保存は版24で表の定義だけを持つ', async ({ page }, testInfo) => {
  const empty = createEmptyPartDocument(), box = createPrimitiveFeature(empty, 'box', { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) });
  const width = (value: number) => ({ name: '幅', value: number(value), unit: 'mm' as const, description: '板の幅' });
  // 係数を足した部品は、選んでいる構成の値も同じ係数に揃える(model の synchronizeConfigurations)。揃えないと、io の読み手が
  // document.configurations[0].values の形の違いとして断り、ファイルを開けない。
  const part = synchronizeConfigurations({ ...appendSolid(empty, box), parameters: [width(100)] });
  const nextPart = synchronizeConfigurations({ ...part, parameters: [width(120)] });
  const [initial, changed] = await Promise.all([writeDocumentBundle(createPartDocumentBundle(part)), writeDocumentBundle(createPartDocumentBundle(nextPart))]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  const token = await beginRecompute(page);
  const opening = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '開く', exact: true }).click();
  await (await opening).setFiles({ name: '係数.pcad', mimeType: 'application/zip', buffer: Buffer.from(initial) });
  await waitForRecompute(page, token);
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/u }).first().click();
  await page.getByRole('button', { name: 'この部品から図面を作成', exact: true }).click();
  await expect.poll(() => page.locator('.pcad-drawing-svg [data-view-id="view-1"] path').count(), { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
  // 表の設定は右の「表と部品番号」の区画(DrawingPropertyPanel.tsx の details[data-property-kind])。
  const section = page.locator('.pcad-drawing-property-section[data-property-kind="table"]');
  if (await section.getAttribute('open') === null) await section.locator(':scope > summary').click();
  await expect(section).toHaveAttribute('open', '');
  const editor = page.locator('.pcad-drawing-table-editor');
  await editor.getByLabel(m('drawing.table.title'), { exact: true }).selectOption('parameter');
  await editor.getByLabel(m('drawing.table.parameterScope'), { exact: true }).selectOption('all');
  await editor.getByRole('button', { name: m('drawing.table.add'), exact: true }).click();
  const table = page.locator('.pcad-drawing-svg [data-owner-id="table-1"]');
  for (const text of ['幅', '100', 'mm', '板の幅']) await expect(table.locator(`[aria-label="${text}"]`)).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
  const updating = page.waitForEvent('filechooser'); await chooseDrawingMenu(page, 'ファイル', '元の部品・アセンブリを取り込み直す');
  await (await updating).setFiles({ name: '係数.pcad', mimeType: 'application/zip', buffer: Buffer.from(changed) });
  await expect(table.locator('[aria-label="120"]')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
  await expect(table.locator('[aria-label="100"]')).toHaveCount(0);
  const saving = page.waitForEvent('download'); await page.keyboard.press('Control+s');
  const saved = await saving; await saved.saveAs(testInfo.outputPath('parameter-table.pcadd'));
  const file = await saved.path(); if (file === null) throw new Error('図面保存なし');
  const read = await readDrawingBundle(await readFile(file));
  if (!read.ok) throw new Error('係数の表の図面を読めない');
  expect(read.document.schemaVersion).toBe(24);
  expect(read.document.tables).toHaveLength(1);
  expect(read.document.tables[0]).toMatchObject({ kind: 'parameter', columns: ['name', 'value', 'unit', 'description'], options: { scope: 'all' } });
  expect(read.document.tables[0]).not.toHaveProperty('rows');
});

/*
 * J-05e 寸法の前の文字の係数: `{=名前}` は描く時に元(埋め込みの部品)の係数の今の値へ置き換わり(dimensionDisplay.ts の
 * resolveFields → drawingNoteFields.ts)、保存する文字は入力したまま。元を取り込み直すと表示の値も替わる。
 * 部品は製品の書き手で作り、製品の読み手(io の readPcadFile)が受け付ける事を Node で確かめた(本数 4 と 6、幅 100)。
 */
test('J-05e 寸法の前の文字の {=本数} は元の部品の係数で描かれ、元を取り込み直すと替わり、保存は入力した文字のまま', async ({ page }, testInfo) => {
  const empty = createEmptyPartDocument(), box = createPrimitiveFeature(empty, 'box', { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) });
  if (box.shape.kind !== 'box') throw new Error('箱の定義なし');
  const feature = { ...box, shape: { ...box.shape, sizeX: number(100), sizeY: number(40), sizeZ: number(60) } };
  const count = (value: number) => ({ name: '本数', value: number(value), unit: 'none' as const, description: '穴の数' });
  const part = synchronizeConfigurations({ ...appendSolid(empty, feature), parameters: [count(4)] });
  const nextPart = synchronizeConfigurations({ ...part, parameters: [count(6)] });
  const [initial, changed] = await Promise.all([writeDocumentBundle(createPartDocumentBundle(part)), writeDocumentBundle(createPartDocumentBundle(nextPart))]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  const token = await beginRecompute(page);
  const opening = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '開く', exact: true }).click();
  await (await opening).setFiles({ name: '本数.pcad', mimeType: 'application/zip', buffer: Buffer.from(initial) });
  await waitForRecompute(page, token);
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/u }).first().click();
  await page.getByRole('button', { name: 'この部品から図面を作成', exact: true }).click();
  await expect.poll(() => page.locator('.pcad-drawing-svg [data-view-id="view-1"] path').count(), { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
  await expect(page.locator('.pcad-statusbar')).not.toContainText('作り直しています');
  // The same pick as the P8 test above: the middle of the 100 wide outline of view-1, then Enter places the dimension.
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
  const form = page.getByRole('form', { name: m('drawing.tolerance.title') });
  const prefix = form.getByLabel(m('drawing.dimension.prefix'), { exact: true });
  await prefix.fill('{=本数}×');
  await form.getByRole('button', { name: m('drawing.action.apply'), exact: true }).click();
  await expect(dimension('4×100')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
  await expect(prefix).toHaveValue('{=本数}×');
  const updating = page.waitForEvent('filechooser'); await chooseDrawingMenu(page, 'ファイル', '元の部品・アセンブリを取り込み直す');
  await (await updating).setFiles({ name: '本数.pcad', mimeType: 'application/zip', buffer: Buffer.from(changed) });
  await expect(dimension('6×100')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
  await expect(dimension('4×100')).toHaveCount(0);
  const saving = page.waitForEvent('download'); await page.keyboard.press('Control+s');
  const saved = await saving; await saved.saveAs(testInfo.outputPath('dimension-fields.pcadd'));
  const file = await saved.path(); if (file === null) throw new Error('図面保存なし');
  const read = await readDrawingBundle(await readFile(file));
  if (!read.ok) throw new Error('寸法の係数の図面を読めない');
  expect(read.document.dimensions.map(item => item.prefix)).toEqual(['{=本数}×']);
});
