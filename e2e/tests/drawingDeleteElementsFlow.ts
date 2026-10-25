import { readFile, writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readDocumentBundle, readDrawingBundle, writeDrawingBundle } from '../../packages/io/src/index.js';
import { createDrawingDocument, embedDrawingSource, emptyDrawingSourceLibrary, partLibraryOfBundle,
  type DrawingDocument, type DrawingSourceInput } from '../../packages/model/src/index.js';
import { twoBoxAssemblyFile } from './assemblyTestSupport.js';
import { diskFile, openTarget, saveTarget } from './electronAppFlow.js';
import { waitForDrawingReady } from './drawingManufacturingFixture.js';

async function fixture(): Promise<Uint8Array> {
  const read = await readDocumentBundle(await twoBoxAssemblyFile(), 'assembly');
  if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('組立がありません。');
  const source: DrawingSourceInput = { sourceKind: 'assembly', document: read.bundle.document, library: partLibraryOfBundle(read.bundle) };
  const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(), source, '箱.pcada', '', { importedAt: '2026-10-04T00:00:00Z' });
  const base = createDrawingDocument('共通削除', embedded.source);
  const document: DrawingDocument = { ...base,
    views: [{ id: 'view-1', name: '正面図', kind: 'front', position: [200, 170], direction: [0, 1, 0], xDir: [1, 0, 0],
      scale: 1, showHidden: true, showCenterLines: true, layerId: 'layer-1' }],
    tables: [{ id: 'table-1', kind: 'revision', position: [40, 90], columns: ['revision', 'date', 'description', 'approvedBy'],
      rows: [['A', '', 'F05改訂', '']], options: {}, layerId: 'layer-1' }],
    balloons: [{ id: 'balloon-1', itemNumber: 1, componentIds: [source.document.components[0].id],
      position: [300, 190], leader: [[210, 170]], layerId: 'layer-1' }],
    dimensions: [{ id: 'dim-1', kind: 'length', measurement: 'trueDistance', origin: 'manual', reference: false, layerId: 'layer-4',
      placement: { commonNormalCoordinate: 235, textPosition: [220, 235] }, targets: [
        { kind: 'point', viewId: 'view-1', paperPoint: [200, 170], modelPoint: [0, 0, 0] },
        { kind: 'point', viewId: 'view-1', paperPoint: [240, 170], modelPoint: [40, 0, 0] },
      ] }],
  };
  return writeDrawingBundle(document, { source, savedAt: '2026-10-04T00:00:00Z' });
}

async function clickShape(page: Page, locator: Locator, modifier?: 'Shift' | 'Control', offsetY = 0): Promise<void> {
  const point = await locator.evaluate(element => {
    if (!(element instanceof SVGGeometryElement)) throw new Error('選択する図形がありません。');
    const bounds = element.getBBox(), matrix = element.getScreenCTM();
    const local = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    if (matrix === null) throw new Error('用紙がありません。');
    const screen = new DOMPoint(local.x, local.y).matrixTransform(matrix); return { x: screen.x, y: screen.y };
  });
  if (modifier !== undefined) await page.keyboard.down(modifier);
  await page.mouse.click(point.x, point.y + offsetY);
  if (modifier !== undefined) await page.keyboard.up(modifier);
}

export async function drawingDeleteElementsFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const input = info.outputPath('delete-elements.pcadd'); await writeFile(input, await fixture());
  if (app !== undefined) await openTarget(app, input);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : undefined;
  await page.getByRole('button', { name: '開く', exact: true }).click();
  if (chooser !== undefined) await (await chooser).setFiles(input);
  await waitForDrawingReady(page);
  const owner = (id: string) => page.locator(`.pcad-drawing-svg [data-owner-id="${id}"]`);
  const browserNames = { 'table-1': '改訂欄 1', 'balloon-1': '部品番号の風船 1', 'dim-1': '1. 長さ — 40' } as const;
  const assertSelection = async (ids: readonly string[]): Promise<void> => {
    for (const id of ['table-1', 'balloon-1', 'dim-1'] as const) {
      const selected = ids.includes(id);
      await expect.poll(() => owner(id).locator('path, text').evaluateAll(primitives => ({
        present: primitives.length > 0,
        highlighted: primitives.some(primitive => primitive.getAttribute('stroke') === '#2563eb'
          || primitive.getAttribute('fill') === '#2563eb'),
      }))).toEqual({ present: true, highlighted: selected });
      await expect(page.getByRole('button', { name: browserNames[id], exact: true })).toHaveAttribute('aria-pressed', String(selected));
    }
  };
  const save = async (name: string): Promise<DrawingDocument> => {
    const path = info.outputPath(`${name}.pcadd`);
    if (app !== undefined) await saveTarget(app, path);
    const download = app === undefined ? page.waitForEvent('download') : undefined;
    await page.locator('.pcad-drawing-sheet').focus(); await page.keyboard.press('Control+Shift+s');
    if (download !== undefined) await (await download).saveAs(path); else await diskFile(path);
    const result = await readDrawingBundle(await readFile(path)); if (!result.ok) throw new Error(result.error.message);
    return result.document;
  };
  const original = await save('delete-before');
  // 寸法線の描画幅外でも7CSSpx以内を拾い、許容幅外は選択をクリアする。
  await clickShape(page, owner('table-1').locator('path').first());
  await assertSelection(['table-1']);
  await clickShape(page, owner('dim-1').locator('path').first(), undefined, 10);
  await assertSelection([]);
  expect(await save('dimension-line-outside')).toEqual(original);
  const cases = [
    { name: 'table', key: 'Delete', clicks: [['table-1']], ids: ['table-1'] },
    { name: 'balloon', key: 'Backspace', clicks: [['balloon-1']], ids: ['balloon-1'] },
    { name: 'mixed-shift', key: 'Delete', clicks: [['table-1'], ['balloon-1', 'Shift'], ['dim-1', 'Shift'], ['table-1'], ['balloon-1'], ['dim-1']],
      ids: ['table-1', 'balloon-1', 'dim-1'] },
    { name: 'mixed-control-reversed', key: 'Delete', clicks: [['dim-1'], ['balloon-1', 'Control'], ['table-1', 'Control']],
      ids: ['table-1', 'balloon-1', 'dim-1'] },
    { name: 'balloon-shift-toggle', key: 'Delete', clicks: [['table-1'], ['balloon-1', 'Shift'], ['balloon-1', 'Shift']], ids: ['table-1'] },
    { name: 'table-control-toggle', key: 'Backspace', clicks: [['balloon-1'], ['table-1', 'Control'], ['table-1', 'Control']], ids: ['balloon-1'] },
    { name: 'table-shift-toggle', key: 'Delete', clicks: [['balloon-1'], ['table-1', 'Shift'], ['table-1', 'Shift']], ids: ['balloon-1'] },
    { name: 'balloon-control-toggle', key: 'Backspace', clicks: [['table-1'], ['balloon-1', 'Control'], ['balloon-1', 'Control']], ids: ['table-1'] },
    { name: 'dimension-shift-toggle', key: 'Delete', clicks: [['table-1'], ['dim-1', 'Shift'], ['dim-1', 'Shift']], ids: ['table-1'] },
    { name: 'dimension-control-toggle', key: 'Backspace', clicks: [['balloon-1'], ['dim-1', 'Control'], ['dim-1', 'Control']], ids: ['balloon-1'] },
    { name: 'dimension-line-near-shift', key: 'Delete', clicks: [['table-1'], ['dim-1', 'Shift']], ids: ['table-1', 'dim-1'] },
    { name: 'dimension-line-near-control', key: 'Backspace', clicks: [['balloon-1'], ['dim-1', 'Control']], ids: ['balloon-1', 'dim-1'] },
    { name: 'dimension-text-shift', key: 'Delete', clicks: [['table-1'], ['dim-1', 'Shift']], ids: ['table-1', 'dim-1'] },
    { name: 'dimension-text-control', key: 'Backspace', clicks: [['balloon-1'], ['dim-1', 'Control']], ids: ['balloon-1', 'dim-1'] },
    { name: 'plain-replaces', key: 'Delete', clicks: [['table-1'], ['balloon-1', 'Shift'], ['dim-1']], ids: ['dim-1'] },
  ] as const;
  for (const { name, key, clicks, ids } of cases) {
    let selected: readonly string[] = [];
    await assertSelection(selected);
    for (const click of clicks) {
      // 元の寸法線中点の反例を保ち、文字内クリックの正例も別に検査する。
      const primitive = owner(click[0]).locator(click[0] === 'dim-1' && name.startsWith('dimension-text-') ? 'g[aria-label] path' : 'path').first();
      await clickShape(page, primitive, click.length === 2 ? click[1] : undefined,
        click[0] === 'dim-1' && name.startsWith('dimension-line-near-') ? 2 : 0);
      selected = click.length === 2 ? selected.includes(click[0]) ? selected.filter(id => id !== click[0])
        : [...selected, click[0]] : selected.includes(click[0]) ? selected : [click[0]];
      await assertSelection(selected);
    }
    await assertSelection(ids);
    await page.locator('.pcad-drawing-sheet').focus(); await page.keyboard.press(key); await waitForDrawingReady(page);
    for (const id of ids) await expect(owner(id)).toHaveCount(0);
    const deleted = await save(`deleted-${name}`);
    expect(deleted.tables).toEqual(ids.some(id => id === 'table-1') ? [] : original.tables);
    expect(deleted.balloons).toEqual(ids.some(id => id === 'balloon-1') ? [] : original.balloons);
    expect(deleted.dimensions).toEqual(ids.some(id => id === 'dim-1') ? [] : original.dimensions);
    expect(deleted.views).toEqual(original.views); expect(deleted.layers).toEqual(original.layers);
    await page.keyboard.press('Control+z'); await waitForDrawingReady(page);
    expect(await save(`undo-${name}`)).toEqual(original);
    await page.keyboard.press('Control+y'); await waitForDrawingReady(page);
    expect(await save(`redo-${name}`)).toEqual(deleted);
    await page.keyboard.press('Control+z'); await waitForDrawingReady(page);
  }
  // 空選択・入力欄・日本語入力変換中は、Delete/Backspaceで文書を変えない。
  const sheet = page.locator('.pcad-drawing-sheet');
  const pressBoth = async (name: string): Promise<void> => {
    for (const key of ['Delete', 'Backspace']) {
      await page.keyboard.press(key); await waitForDrawingReady(page);
      expect(await save(`${name}-${key}`)).toEqual(original);
    }
  };
  await clickShape(page, owner('table-1').locator('path').first());
  await clickShape(page, owner('dim-1').locator('path').first(), undefined, 10);
  await assertSelection([]);
  await sheet.focus(); await pressBoth('empty-selection');
  await clickShape(page, owner('table-1').locator('path').first());
  await assertSelection(['table-1']);
  const cell = page.getByRole('textbox', { name: '1 変更内容', exact: true });
  await cell.focus(); await expect(cell).toBeFocused();
  for (const key of ['Delete', 'Backspace']) {
    await page.keyboard.press(key); await waitForDrawingReady(page);
    await assertSelection(['table-1']);
    await expect(owner('table-1')).not.toHaveCount(0);
    expect(await save(`text-input-${key}`)).toEqual(original);
    await clickShape(page, owner('table-1').locator('path').first());
    await cell.focus();
  }
  await sheet.focus();
  await clickShape(page, owner('table-1').locator('path').first());
  await clickShape(page, owner('balloon-1').locator('path').first(), 'Shift');
  await assertSelection(['table-1', 'balloon-1']);
  await sheet.focus();
  for (const key of ['Delete', 'Backspace']) {
    // 日本語入力の変換中のキーは、全体の削除へ渡さない。
    await sheet.evaluate((element, composingKey) => {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: composingKey, isComposing: true, keyCode: 229, bubbles: true, cancelable: true }));
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', isComposing: true, keyCode: 229, bubbles: true, cancelable: true }));
    }, key);
    await waitForDrawingReady(page); await assertSelection(['table-1', 'balloon-1']);
    expect(await save(`composing-${key}`)).toEqual(original);
    await sheet.focus();
  }
  // 投影図は共通削除の対象外。理由を1件出し、文書を変えない。
  const viewButton = page.getByRole('button', { name: '正面図', exact: true });
  await viewButton.click(); await expect(viewButton).toHaveAttribute('aria-pressed', 'true'); await sheet.focus();
  await page.keyboard.press('Delete'); await waitForDrawingReady(page);
  await expect(page.locator('.pcad-statusbar__text')).toHaveText(
    '投影図とレイヤーは Delete・Backspace では削除しません。レイヤーはレイヤーの設定の「レイヤーを削除」から消します。');
  expect(await save('view-delete-blocked')).toEqual(original);
  expect(await save('restored-final')).toEqual(original);
  const restoredPath = info.outputPath('restored-final.pcadd');
  if (app !== undefined) await openTarget(app, restoredPath);
  const restoredChooser = app === undefined ? page.waitForEvent('filechooser') : undefined;
  await page.getByRole('button', { name: '開く', exact: true }).click();
  if (restoredChooser !== undefined) await (await restoredChooser).setFiles(restoredPath);
  await waitForDrawingReady(page);
  expect(await save('reopened-final')).toEqual(original);
  await page.screenshot({ path: info.outputPath('drawing-delete-restored.png') });
}
