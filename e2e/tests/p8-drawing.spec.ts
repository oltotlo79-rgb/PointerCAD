/// <reference lib="dom" />
import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';
import { addThirdBoxAssemblyFile, twoBoxAssemblyFile } from './assemblyTestSupport.js';
import { configurableBoxPartFile, dimensionSeriesPartFile, offsetHolePartFile } from './drawingTestSupport.js';
import { drawingMessage } from './drawingMessages.js';
import { expectDrawingStroke } from './drawingManufacturingFixture.js';

type ClientBounds = Readonly<{ x: number; y: number; width: number; height: number }>;

function toolbarHelpButton(page: Page): Locator {
  return page.locator('.pcad-toolbar').getByRole('button', { name: 'ヘルプ (F1)', exact: true });
}

async function openDrawingProperties(page: Page, kind: 'sheet' | 'view' | 'dimension' | 'annotation' | 'table' | 'layer'): Promise<void> {
  const section = page.locator(`.pcad-drawing-property-section[data-property-kind="${kind}"]`);
  if (await section.getAttribute('open') === null) await section.locator(':scope > summary').click();
  await expect(section).toHaveAttribute('open', '');
}

/** SVGの再生成をまたぐElementHandleを保持せず、現在の文字と矩形を同じDOM処理で読む。 */
async function readTextBounds(locator: Locator): Promise<ClientBounds | null> {
  return locator.evaluateAll((elements) => {
    if (elements.length !== 1) return null;
    const element = elements[0];
    if (element === undefined || !element.isConnected) return null;
    const { x, y, width, height } = element.getBoundingClientRect();
    return width > 0 && height > 0 ? { x, y, width, height } : null;
  });
}

async function waitForTextBounds(locator: Locator): Promise<ClientBounds> {
  const result: { current: ClientBounds | null } = { current: null };
  await expect.poll(async () => {
    result.current = await readTextBounds(locator);
    return result.current !== null;
  }, { message: '現在のSVGに寸法文字の実矩形が現れる' }).toBe(true);
  if (result.current === null) throw new Error('寸法文字の実矩形なし');
  return result.current;
}

async function createBox(page: Page): Promise<void> {
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^作る/ }).first().click();
  await page.getByRole('group', { name: '作る', exact: true }).getByRole('button', { name: '箱', exact: true }).click();
  const token = await beginRecompute(page);
  await page.locator('.pcad-popover input.pcad-field__input').first().press('Enter');
  await waitForRecompute(page, token);
  if (await page.locator('.pcad-popover').count() > 0) await page.locator('.pcad-popover input').first().press('Escape');
}

async function drawingFromBox(page: Page): Promise<void> {
  await createBox(page);
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/ }).first().click();
  await page.getByRole('button', { name: 'この部品から図面を作成', exact: true }).click();
  await expect(page.locator('.pcad-drawing-svg svg')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
  await expect.poll(() => page.locator('.pcad-drawing-svg [data-owner-id="view-1"] path').count(), { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
  await expect(page.locator('.pcad-statusbar')).not.toContainText('作り直しています');
}

/** 保存文書を注入せず、実際に画面へ描かれた輪郭の中点を押す。 */
async function clickFrontEdge(page: Page): Promise<void> {
  const point = await page.locator('.pcad-drawing-svg [data-owner-id="view-1"] path').first().evaluate((element) => {
    if (!(element instanceof SVGPathElement)) throw new Error('投影線なし');
    const local = element.getPointAtLength(element.getTotalLength() / 2), matrix = element.getScreenCTM();
    if (matrix === null) throw new Error('用紙なし');
    const client = new DOMPoint(local.x, local.y).matrixTransform(matrix);
    return { x: client.x, y: client.y };
  });
  await page.mouse.click(point.x, point.y);
}

/** 最後に使った道具で読み上げ名が変わっても、区画名から同じ共通メニューを開く。 */
async function chooseDrawingMenu(page: Page, group: string, item: string): Promise<void> {
  const menu = page.locator('.pcad-toolbar .pcad-toolbar__group').filter({
    has: page.locator('.pcad-toolbar__group-label', { hasText: new RegExp(`^${group}$`, 'u') }),
  });
  await menu.locator('.pcad-menu__trigger').click();
  await menu.getByRole('button', { name: item, exact: true }).click();
}

test.describe('P8 図面の実操作', () => {
  test('部品・組立・図面のツールバーが1440pxと1280pxで1段に収まり、図面の5メニューをキーボードでも開ける(P8-66)', async ({ page }, testInfo) => {
    await page.goto('/');
    const layout = async (mode: string): Promise<void> => {
      for (const width of [1440, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        const toolbar = page.locator('.pcad-toolbar'); await expect(toolbar).toBeVisible();
        const metrics = await toolbar.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return { height: box.height, overflow: element.scrollWidth - element.clientWidth,
            untitled: Array.from(element.querySelectorAll('button')).filter((button) => button.getBoundingClientRect().width > 0 && !button.title.trim())
              .map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '') };
        });
        console.log(`[ツールバー] ${mode}/${width}: ${JSON.stringify(metrics)}`);
        await page.screenshot({ path: testInfo.outputPath(`toolbar-${mode}-${width}.png`), fullPage: true });
        expect(metrics.height, `${mode}/${width}`).toBeLessThan(80);
        expect(metrics.overflow, `${mode}/${width}`).toBeLessThanOrEqual(1);
        expect(metrics.untitled, `${mode}/${width}`).toEqual([]);
      }
      const help = toolbarHelpButton(page);
      await help.focus(); await page.keyboard.press('F1');
      const dialog = page.getByRole('dialog', { name: 'PointerCAD ヘルプ', exact: true });
      await expect(dialog).toBeVisible(); await expect(dialog.locator('article h1')).toHaveCount(1);
      await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(help).toBeFocused();
    };
    await layout('part');
    const token = await beginRecompute(page);
    await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/u }).first().click();
    await page.getByRole('button', { name: '新しいアセンブリ', exact: true }).click();
    await waitForRecompute(page, token);
    await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
    await layout('assembly');
    await drawingFromBox(page); await layout('drawing');
    const toolbar = page.locator('.pcad-toolbar');
    await expect(toolbar.locator('.pcad-menu__trigger')).toHaveCount(5);
    const dimensions = toolbar.getByRole('button', { name: /^寸法(?::|$)/u });
    await dimensions.focus(); await page.keyboard.press('ArrowDown');
    await expect(toolbar.getByRole('group', { name: '寸法', exact: true })).toBeVisible();
    await page.keyboard.press('End'); await expect(toolbar.getByRole('button', { name: '自動寸法', exact: true })).toBeFocused();
    await page.keyboard.press('Escape'); await expect(dimensions).toBeFocused();
    await expect(toolbar.getByRole('group', { name: '寸法', exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('drawing-toolbar-1280.png'), fullPage: true });
  });
  test('F1で操作のヘルプを開き、本文検索と章移動後に元の編集へ戻る(P8-68・69)', async ({ page }, testInfo) => {
    await drawingFromBox(page);
    const viewPaths = page.locator('.pcad-drawing-svg [data-owner-id="view-1"] path');
    await expectDrawingStroke(viewPaths);
    const originalPaths = await viewPaths.evaluateAll((elements) => elements.map((element) => element.getAttribute('d')));
    const toolbar = page.locator('.pcad-toolbar');
    const views = toolbar.getByRole('button', { name: /^図(?::|$)/u });
    await views.focus(); await page.keyboard.press('F1');
    const dialog = page.getByRole('dialog', { name: 'PointerCAD ヘルプ', exact: true });
    const article = dialog.getByRole('article', { name: 'ヘルプ本文', exact: true });
    await expect(article.getByRole('heading', { level: 1 })).toContainText('図を追加');
    const search = dialog.getByRole('searchbox', { name: 'ヘルプ本文を検索', exact: true });
    await search.fill('存在しない語彙XYZ'); await expect(dialog).toContainText('一致する項目がありません');
    await search.fill('画面に表示する 印刷・書き出し');
    await dialog.getByRole('button', { name: 'レイヤーで色・線・表示・印刷を管理する', exact: true }).click();
    await expect(article.getByRole('heading', { level: 1 })).toHaveText('レイヤーで色・線・表示・印刷を管理する');
    await search.fill('');
    await dialog.getByRole('button', { name: '部品から図面を作る・注記する・書き出す', exact: true }).click();
    await article.getByRole('button', { name: '断面図とハッチング', exact: true }).click();
    await expect(article.getByRole('heading', { level: 1 })).toContainText('断面');
    await article.focus(); await page.keyboard.press('Control+z'); await page.keyboard.press('Delete');
    expect(await viewPaths.evaluateAll((elements) => elements.map((element) => element.getAttribute('d')))).toEqual(originalPaths);
    await page.screenshot({ path: testInfo.outputPath('help-section-search.png'), fullPage: true });
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(views).toBeFocused();
    await expectDrawingStroke(viewPaths);
    await chooseDrawingMenu(page, '見た目', drawingMessage('drawing.property.sheet'));
    const input = page.locator('.pcad-panel--right input').first(); await input.focus(); const value = await input.inputValue();
    await page.keyboard.press('F1'); await expect(article.getByRole('heading', { level: 1 })).toContainText('用紙');
    await page.keyboard.press('Escape'); await expect(input).toBeFocused(); await expect(input).toHaveValue(value);
  });
  test('断面・詳細・補助・部分・破断図を実形状から作り、編集とUndoと保存往復でも条件が残る(P8-68・71)', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await drawingFromBox(page);
    const toolbar = page.locator('.pcad-toolbar');
    const properties = page.locator('.pcad-panel--right');
    const tree = page.locator('.pcad-panel--left');
    const start = async (key: string): Promise<void> => {
      await chooseDrawingMenu(page, drawingMessage('drawing.toolbar.views'), drawingMessage(key));
    };
    const fill = async (key: string, value: string): Promise<void> => { await properties.getByLabel(drawingMessage(key), { exact: true }).fill(value); };
    const create = async (key: string, name: string, x: number, y: number, scale = '1'): Promise<void> => {
      await start(key);
      await properties.getByLabel(drawingMessage('drawing.advanced.source'), { exact: true }).selectOption('view-1');
      await fill('drawing.view.name', name); await fill('drawing.view.x', String(x)); await fill('drawing.view.y', String(y));
      await fill('drawing.view.scale', scale);
    };
    const apply = async (name: string, id: string): Promise<void> => {
      await properties.getByRole('button', { name: drawingMessage('drawing.view.add'), exact: true }).click();
      await expect(tree.getByRole('button', { name, exact: true })).toBeVisible();
      await expectDrawingStroke(page.locator(`.pcad-drawing-svg [data-owner-id="${id}"] path`));
      await expect(page.locator('.pcad-statusbar')).not.toContainText('作り直しています');
      await expect(properties.getByRole('alert')).toHaveCount(0);
    };
    await create('drawing.tool.sectionView', '断面A', 90, 265);
    await fill('drawing.advanced.offset', '0');
    await apply('断面A', 'view-4');
    await expect(page.locator('.pcad-drawing-svg [data-owner-id="view-4"] [aria-label="A–A"]')).toHaveCount(1);
    await expect(page.locator('.pcad-drawing-svg [data-owner-id="view-4"] [aria-label="A"]')).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath('advanced-drawing-section.png'), fullPage: true });
    const section = page.locator('.pcad-drawing-svg [data-owner-id="view-4"] path');
    await expect.poll(() => section.evaluateAll((elements) => elements.filter((element) => {
      if (!(element instanceof SVGPathElement) || Number.parseFloat(getComputedStyle(element).strokeWidth) !== 0.25) return false;
      const first = element.getPointAtLength(0), last = element.getPointAtLength(element.getTotalLength());
      return Math.abs(first.x - last.x) > 1 && Math.abs(first.y - last.y) > 1;
    }).length)).toBeGreaterThan(2);

    await create('drawing.tool.detailView', '詳細B', 165, 265, '2');
    await fill('drawing.advanced.label', 'B');
    await fill('drawing.advanced.radius', '12'); await apply('詳細B', 'view-5');
    await expect(page.locator('.pcad-drawing-svg [data-owner-id="view-5"] [aria-label="B (2:1)"]')).toHaveCount(1);
    await expect(page.locator('.pcad-drawing-svg [data-owner-id="view-5"] [aria-label="B"]')).toHaveCount(1);
    await expect(page.getByTestId('drawing-status-scale')).toContainText('2:1');
    await fill('drawing.advanced.radius', '11');
    await properties.getByRole('button', { name: drawingMessage('drawing.view.apply'), exact: true }).click();
    await expect(properties.getByLabel(drawingMessage('drawing.advanced.radius'), { exact: true })).toHaveValue('11');
    await toolbar.getByRole('button', { name: '元に戻す', exact: true }).click();
    await tree.getByRole('button', { name: '詳細B', exact: true }).click();
    await expect(properties.getByLabel(drawingMessage('drawing.advanced.radius'), { exact: true })).toHaveValue('12');

    await create('drawing.tool.auxiliaryView', '補助C', 240, 265);
    // 正面図の上方向と平行にならない平面を使う。
    await properties.getByLabel(drawingMessage('drawing.advanced.workPlane'), { exact: true }).selectOption('yz');
    await apply('補助C', 'view-6');
    await create('drawing.tool.partialView', '部分D', 305, 265);
    await fill('drawing.advanced.radius', '12'); await apply('部分D', 'view-7');
    await create('drawing.tool.brokenView', '破断E', 350, 165);
    await fill('drawing.advanced.from', '-5'); await fill('drawing.advanced.to', '5'); await fill('drawing.advanced.gap', '3');
    await apply('破断E', 'view-8');
    await page.screenshot({ path: testInfo.outputPath('advanced-drawing-views.png'), fullPage: true });
    const saving = page.waitForEvent('download'); await page.keyboard.press('Control+s');
    const downloaded = await saving; const path = await downloaded.path(); if (path === null) throw new Error('図面保存なし');
    const bytes = await readFile(path);
    await page.reload();
    const opening = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '開く', exact: true }).click();
    await (await opening).setFiles({ name: '派生図.pcadd', mimeType: 'application/zip', buffer: bytes });
    for (const name of ['断面A', '詳細B', '補助C', '部分D', '破断E']) await expect(tree.getByRole('button', { name, exact: true })).toBeVisible();
    await tree.getByRole('button', { name: '破断E', exact: true }).click();
    await expect(properties.getByLabel(drawingMessage('drawing.advanced.gap'), { exact: true })).toHaveValue('3');
    await expectDrawingStroke(page.locator('.pcad-drawing-svg [data-owner-id="view-4"] path'));
    await expect(page.locator('.pcad-drawing-svg [data-owner-id="view-4"] [aria-label="A–A"]')).toHaveCount(1);
    await expect(page.locator('.pcad-drawing-svg [data-owner-id="view-5"] [aria-label="B (2:1)"]')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('advanced-drawing-reopened.png'), fullPage: true });
    expect(errors).toEqual([]);
  });

  test('構成を切り替えるとパラメータと実体積が変わり、Undoと保存往復で残る(P8-62・63)', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    });
    await page.goto('/');
    const openButton = page.getByRole('button', { name: '開く', exact: true });
    await expect(openButton).toBeVisible();
    const opening = page.waitForEvent('filechooser'); await openButton.click();
    await (await opening).setFiles({ name: '構成の箱.pcad', mimeType: 'application/zip', buffer: Buffer.from(configurableBoxPartFile()) });
    const parametersTab = page.getByRole('tab', { name: 'パラメータ', exact: true });
    const propertiesTab = page.getByRole('tab', { name: 'プロパティ', exact: true });
    const box = page.locator('.pcad-panel--left').getByRole('button', { name: '箱1', exact: true });
    const volume = page.locator('.pcad-panel--right dt.pcad-properties__key', { hasText: /^体積$/u }).locator('xpath=following-sibling::dd[1]');
    const expectVolume = async (expected: number): Promise<void> => {
      await propertiesTab.click(); await box.click();
      await expect.poll(async () => Math.abs(Number.parseFloat(await volume.innerText()) - expected), { timeout: KERNEL_TIMEOUT_MS }).toBeLessThan(0.01);
    };
    await expectVolume(8000);
    await parametersTab.click();
    const configuration = page.getByRole('region', { name: '構成', exact: true });
    const select = configuration.getByRole('combobox', { name: '構成', exact: true });
    const source = page.locator('.pcad-parameter').first().locator('.pcad-field').nth(1).locator('input');
    await configuration.getByRole('textbox', { name: '構成の名前', exact: true }).fill('長い');
    await configuration.getByRole('button', { name: '追加', exact: true }).click();
    await select.selectOption({ label: '長い' });
    await source.fill('40'); await source.press('Enter');
    await expectVolume(16000);
    await parametersTab.click(); await select.selectOption({ label: '既定' }); await expect(source).toHaveValue('20');
    await expectVolume(8000);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expectVolume(16000);
    await parametersTab.click(); await expect(source).toHaveValue('40');
    await expect(select.locator('option:checked')).toHaveText('長い');
    await page.screenshot({ path: testInfo.outputPath('configuration-long.png'), fullPage: true });
    const saving = page.waitForEvent('download'); await page.keyboard.press('Control+s');
    const download = await saving; expect(download.suggestedFilename()).toMatch(/\.pcad$/u);
    const savedPath = await download.path(); if (savedPath === null) throw new Error('部品を保存できませんでした');
    const bytes = await readFile(savedPath);
    await page.reload(); await expect(openButton).toBeVisible();
    const reopening = page.waitForEvent('filechooser'); await openButton.click();
    await (await reopening).setFiles({ name: '構成の箱.pcad', mimeType: 'application/zip', buffer: bytes });
    await expectVolume(16000);
    await parametersTab.click(); await expect(select.locator('option:checked')).toHaveText('長い'); await expect(source).toHaveValue('40');
    await select.selectOption({ label: '既定' }); await expect(source).toHaveValue('20'); await expectVolume(8000);
    expect(errors).toEqual([]);
  });

  test.use({ viewport: { width: 1440, height: 900 } });
  test('実頂点4つから寸法列4方式を記入し、基準変更・整列・Undo・累進の保存往復ができる(P8-66・68)', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    });
    await page.goto('/'); const opening = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '開く', exact: true }).click(); const token = await beginRecompute(page);
    await (await opening).setFiles({ name: '寸法列.pcad', mimeType: 'application/zip', buffer: Buffer.from(dimensionSeriesPartFile()) });
    await waitForRecompute(page, token);
    await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/u }).first().click();
    await page.getByRole('button', { name: 'この部品から図面を作成', exact: true }).click();
    const paths = page.locator('.pcad-drawing-svg [data-owner-id="view-1"] path');
    await expectDrawingStroke(paths); await expect(page.locator('.pcad-statusbar')).not.toContainText('作り直しています');
    const vertices = await paths.evaluateAll((elements) => {
      const ends = elements.flatMap((element) => {
        if (!(element instanceof SVGPathElement)) return []; const matrix = element.getScreenCTM(); if (matrix === null) return [];
        return [0, element.getTotalLength()].map((distance) => { const point = element.getPointAtLength(distance);
          const at = new DOMPoint(point.x, point.y).matrixTransform(matrix); return { x: at.x, y: at.y }; });
      });
      const bottom = Math.max(...ends.map((point) => point.y));
      const points = ends.filter((point) => Math.abs(point.y - bottom) < 0.01).sort((a, b) => a.x - b.x);
      return points.filter((point, index) => index === 0 || Math.abs(point.x - points[index - 1].x) > 0.01);
    });
    expect(vertices).toHaveLength(4);
    const form = page.getByRole('form', { name: drawingMessage('drawing.series.title'), exact: true });
    const rows = page.locator('.pcad-drawing-tree-dimension');
    const create = async (kind: string, baseIndex = 0): Promise<void> => {
      await chooseDrawingMenu(page, '寸法', drawingMessage(`drawing.series.${kind}`));
      for (const point of vertices) await page.mouse.click(point.x, point.y);
      await expect(form).toContainText('選択した頂点: 4個');
      for (let index = 0; index < 4; index++) await expect(page.locator(`.pcad-drawing-svg [data-owner-id="drawing-target-${index}"] [aria-label="${index + 1}"]`)).toHaveCount(1);
      if (kind === 'chain') await page.screenshot({ path: testInfo.outputPath('dimension-series-selected-points.png'), fullPage: true });
      if (baseIndex !== 0) await form.getByRole('combobox', { name: drawingMessage('drawing.series.base'), exact: true }).selectOption(String(baseIndex));
      await form.getByRole('button', { name: drawingMessage('drawing.action.apply'), exact: true }).click();
      await expect(form).toHaveCount(0);
    };
    await create('chain'); await expect(rows).toHaveCount(3);
    for (const [index, value] of ['20', '30', '40'].entries()) await expect(rows.nth(index)).toContainText(`— ${value}`);
    await page.screenshot({ path: testInfo.outputPath('chain-dimensions.png'), fullPage: true });
    await page.keyboard.press('Control+z'); await expect(rows).toHaveCount(0);
    await create('parallel'); await expect(rows).toHaveCount(3);
    for (const [index, value] of ['20', '50', '90'].entries()) await expect(rows.nth(index)).toContainText(`— ${value}`);
    // 実際の文字を重なる位置へ編集した後に、複数選択から整列する。
    await rows.nth(0).click();
    const tolerance = page.getByRole('form', { name: drawingMessage('drawing.tolerance.title'), exact: true });
    const original = await tolerance.getByLabel(drawingMessage('drawing.dimension.offset'), { exact: true }).inputValue();
    await rows.nth(1).click(); await tolerance.getByLabel(drawingMessage('drawing.dimension.offset'), { exact: true }).fill(original);
    await tolerance.getByRole('button', { name: drawingMessage('drawing.action.apply'), exact: true }).click();
    await rows.nth(0).click(); await rows.nth(1).click({ modifiers: ['Control'] }); await rows.nth(2).click({ modifiers: ['Control'] });
    await chooseDrawingMenu(page, '寸法', drawingMessage('drawing.arrange.title'));
    await rows.nth(1).click();
    await expect.poll(async () => Math.abs(Number(await tolerance.getByLabel(drawingMessage('drawing.dimension.offset'), { exact: true }).inputValue()) - Number(original)))
      .toBeGreaterThanOrEqual(8);
    await page.screenshot({ path: testInfo.outputPath('parallel-arranged.png'), fullPage: true });
    await page.locator('.pcad-drawing-sheet').focus();
    for (let index = 0; index < 3; index++) await page.keyboard.press('Control+z');
    await expect(rows).toHaveCount(0);
    await create('coordinate', 1); await expect(rows).toHaveCount(4);
    for (const [index, value] of ['-20', '0', '30', '70'].entries()) await expect(rows.nth(index)).toContainText(`X: ${value} / Y: 0`);
    await page.keyboard.press('Control+z'); await expect(rows).toHaveCount(0);
    await create('progressive', 1); await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('累進寸法 — -20 / 0 / 30 / 70');
    const progressive = page.locator('.pcad-drawing-svg [data-owner-id="dim-1"]');
    for (const value of ['-20', '0', '30', '70']) await expect(progressive.locator(`[aria-label="${value}"]`)).toHaveCount(1);
    await expectDrawingStroke(progressive.locator('path'));
    await page.screenshot({ path: testInfo.outputPath('progressive-dimensions.png'), fullPage: true });
    const saving = page.waitForEvent('download'); await page.keyboard.press('Control+s');
    const saved = await (await saving).path(); if (saved === null) throw new Error('累進保存なし'); const bytes = await readFile(saved);
    await page.reload(); const reopening = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '開く', exact: true }).click();
    await (await reopening).setFiles({ name: '寸法列.pcadd', mimeType: 'application/zip', buffer: bytes });
    await expect(rows).toContainText('累進寸法 — -20 / 0 / 30 / 70', { timeout: KERNEL_TIMEOUT_MS });
    for (const value of ['-20', '0', '30', '70']) await expect(progressive.locator(`[aria-label="${value}"]`)).toHaveCount(1);
    expect(errors).toEqual([]);
  });
  test('実際の円周に弧長、2頂点に座標寸法を入れ、公差と保存往復でも実寸を保つ(P8-66・68)', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    });
    await page.goto('/'); const opening = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '開く', exact: true }).click(); const token = await beginRecompute(page);
    await (await opening).setFiles({ name: '偏心穴.pcad', mimeType: 'application/zip', buffer: Buffer.from(offsetHolePartFile()) });
    await waitForRecompute(page, token);
    await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/u }).first().click();
    await page.getByRole('button', { name: 'この部品から図面を作成', exact: true }).click();
    const topPaths = page.locator('.pcad-drawing-svg [data-owner-id="view-2"] path');
    await expectDrawingStroke(topPaths); await expect(page.locator('.pcad-statusbar')).not.toContainText('作り直しています');
    const tree = page.locator('.pcad-panel--left'), properties = page.locator('.pcad-panel--right');
    const centerLines = page.locator('.pcad-drawing-svg [data-owner-id="view-2"][data-layer-id="layer-3"] path');
    await expect(centerLines).toHaveCount(2);
    const selectCenters = async (): Promise<void> => {
      await tree.getByRole('button', { name: '平面図', exact: true }).click();
      await properties.getByText(drawingMessage('drawing.centers.individual'), { exact: true }).click();
    };
    await selectCenters();
    const centerToggle = properties.getByRole('checkbox', { name: drawingMessage('drawing.centers.item').replace('{number}', '1'), exact: true });
    await centerToggle.uncheck(); await expect(centerLines).toHaveCount(0);
    await page.locator('.pcad-toolbar').getByRole('button', { name: '元に戻す', exact: true }).click(); await expect(centerLines).toHaveCount(2);
    await selectCenters(); await centerToggle.uncheck(); await expect(centerLines).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('individual-center-mark.png'), fullPage: true });
    // 実際に描いた円周の点を選ぶ。値や対象をアプリ内部へ注入しない。
    const arcPoint = await topPaths.evaluateAll((elements) => {
      const curve = elements.find((element) => element instanceof SVGPathElement && /C/u.test(element.getAttribute('d') ?? ''));
      if (!(curve instanceof SVGPathElement)) throw new Error('投影された円周がありません');
      const at = curve.getPointAtLength(curve.getTotalLength() / 2), matrix = curve.getScreenCTM();
      if (matrix === null) throw new Error('投影図の座標なし'); const point = new DOMPoint(at.x, at.y).matrixTransform(matrix);
      return { x: point.x, y: point.y };
    });
    await chooseDrawingMenu(page, '寸法', drawingMessage('drawing.dimension.arcLength'));
    await page.mouse.click(arcPoint.x, arcPoint.y);
    const arcText = page.locator('.pcad-drawing-svg [data-owner-id="dim-1"] [aria-label="⌒12.57"]');
    await expect(arcText).toHaveCount(1); await expectDrawingStroke(page.locator('.pcad-drawing-svg [data-owner-id="dim-1"] path'));
    const corners = await page.locator('.pcad-drawing-svg [data-owner-id="view-1"] path').evaluateAll((elements) => {
      const points = elements.flatMap((element) => {
        if (!(element instanceof SVGPathElement)) return []; const matrix = element.getScreenCTM(); if (matrix === null) return [];
        return [0, element.getTotalLength()].map((distance) => { const point = element.getPointAtLength(distance);
          const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix); return { x: screen.x, y: screen.y }; });
      });
      const left = Math.min(...points.map((point) => point.x)), right = Math.max(...points.map((point) => point.x));
      const top = Math.min(...points.map((point) => point.y)), bottom = Math.max(...points.map((point) => point.y));
      const first = points.find((point) => Math.abs(point.x - left) < 0.01 && Math.abs(point.y - bottom) < 0.01);
      const last = points.find((point) => Math.abs(point.x - right) < 0.01 && Math.abs(point.y - top) < 0.01);
      if (first === undefined || last === undefined) throw new Error('箱の対角の頂点なし'); return [first, last];
    });
    await chooseDrawingMenu(page, '寸法', drawingMessage('drawing.dimension.coordinate'));
    for (const point of corners) await page.mouse.click(point.x, point.y);
    const coordinate = page.locator('.pcad-drawing-svg [data-owner-id="dim-2"]');
    await expect(coordinate.locator('[aria-label="X: 20 / Y: 20"]')).toHaveCount(1);
    await properties.getByRole('combobox', { name: drawingMessage('drawing.tolerance.kind'), exact: true }).selectOption('symmetric');
    await properties.getByLabel(drawingMessage('drawing.tolerance.symmetric'), { exact: true }).fill('0.1');
    await properties.getByRole('button', { name: drawingMessage('drawing.action.apply'), exact: true }).click();
    await expect(coordinate.locator('[aria-label="X: 20±0.1 / Y: 20±0.1"]')).toHaveCount(1);
    await expect(page.locator('.pcad-panel--left').getByRole('button', { name: '1. 弧長 — ⌒12.57', exact: true })).toBeVisible();
    await expect(page.locator('.pcad-panel--left').getByRole('button', { name: '2. 座標寸法 — X: 20±0.1 / Y: 20±0.1', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('arc-and-coordinate-dimensions.png'), fullPage: true });
    const saving = page.waitForEvent('download'); await page.keyboard.press('Control+s');
    const saved = await (await saving).path(); if (saved === null) throw new Error('寸法の保存なし'); const bytes = await readFile(saved);
    await page.reload(); const reopening = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '開く', exact: true }).click();
    await (await reopening).setFiles({ name: '拡張寸法.pcadd', mimeType: 'application/zip', buffer: bytes });
    await expect(arcText).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
    await expect(coordinate.locator('[aria-label="X: 20±0.1 / Y: 20±0.1"]')).toHaveCount(1);
    await expect(centerLines).toHaveCount(0);
    await selectCenters(); await centerToggle.check(); await expect(centerLines).toHaveCount(2);
    expect(errors).toEqual([]);
  });
  test('実際の貫通穴から穴表とA1の引出線を作り、基準点の変更とUndoが追従する(P8-56・57)', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    });
    await page.goto('/');
    const open = page.locator('.pcad-toolbar').getByRole('button', { name: '開く', exact: true });
    await expect(open).toBeVisible();
    const choosing = page.waitForEvent('filechooser'); await open.click();
    const token = await beginRecompute(page);
    await (await choosing).setFiles({ name: '偏心穴.pcad', mimeType: 'application/zip', buffer: Buffer.from(offsetHolePartFile()) });
    await waitForRecompute(page, token);
    await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/u }).first().click();
    await page.getByRole('button', { name: 'この部品から図面を作成', exact: true }).click();
    await expect.poll(() => page.locator('.pcad-drawing-svg [data-owner-id="view-2"] path').count(), { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
    await openDrawingProperties(page, 'table');
    const tables = page.locator('.pcad-drawing-table-editor');
    await tables.getByLabel('表と部品番号', { exact: true }).selectOption('hole');
    await tables.getByLabel('穴の座標を測る図', { exact: true }).selectOption('view-2');
    await tables.getByLabel('穴座標の基準点（元部品のmm） X', { exact: true }).fill('1');
    await tables.getByLabel('穴座標の基準点（元部品のmm） Y', { exact: true }).fill('-2');
    await tables.getByRole('button', { name: '表を配置', exact: true }).click();
    const table = page.locator('.pcad-drawing-svg [data-owner-id="table-1"]');
    await expect(table.locator('[aria-label="A1"]')).toHaveCount(2, { timeout: KERNEL_TIMEOUT_MS });
    for (const text of ['2', '6', 'φ4', '貫通']) await expect(table.locator(`[aria-label="${text}"]`)).toHaveCount(1);
    await tables.getByLabel('穴座標の基準点（元部品のmm） X', { exact: true }).fill('0');
    await tables.getByRole('button', { name: '表を更新', exact: true }).click();
    await expect(table.locator('[aria-label="3"]')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(table.locator('[aria-label="2"]')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
    await expect(page.locator('.pcad-drawing-notice')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('drawing-hole-table.png'), fullPage: true });
    await openDrawingProperties(page, 'table');
    await tables.getByLabel('表と部品番号', { exact: true }).selectOption('revision');
    await tables.getByLabel('左からの位置（mm）', { exact: true }).fill('220');
    await tables.getByLabel('下からの位置（mm）', { exact: true }).fill('210');
    // 操作用ラベルは製品の辞書を使う。入力値・図面に残る結果は独立に確かめる。
    for (const [label, value] of [[drawingMessage('drawing.table.revision'), 'A'], [drawingMessage('drawing.table.date'), '2026-09-10'],
      [drawingMessage('drawing.table.description'), '穴の寸法を確定'], [drawingMessage('drawing.table.approvedBy'), '設計担当']]) {
      await tables.getByLabel(`1 ${label}`, { exact: true }).fill(value);
    }
    await tables.getByRole('button', { name: drawingMessage('drawing.table.addRow'), exact: true }).click();
    await tables.getByLabel(`2 ${drawingMessage('drawing.table.revision')}`, { exact: true }).fill('B');
    await tables.getByLabel(`2 ${drawingMessage('drawing.table.description')}`, { exact: true }).fill('備考を追加');
    await tables.getByRole('button', { name: '表を配置', exact: true }).click();
    const revision = page.locator('.pcad-drawing-svg [data-owner-id="table-2"]');
    await expect(revision.locator('[aria-label="穴の寸法を確定"]')).toHaveCount(1);
    await expect(revision.locator('[aria-label="備考を追加"]')).toHaveCount(1);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click(); await expect(revision).toHaveCount(0);
    await page.getByRole('button', { name: 'やり直す', exact: true }).click(); await expect(revision.locator('[aria-label="B"]')).toHaveCount(1);
    const saving = page.waitForEvent('download'); await page.getByRole('button', { name: '保存', exact: true }).click();
    const savedPath = await (await saving).path(); if (savedPath === null) throw new Error('穴表と改訂欄を保存できませんでした');
    const savedBytes = await readFile(savedPath);
    await page.reload(); await expect(open).toBeVisible();
    const reopening = page.waitForEvent('filechooser'); await open.click();
    await (await reopening).setFiles({ name: '穴表と改訂.pcadd', mimeType: 'application/zip', buffer: savedBytes });
    await expect(table.locator('[aria-label="A1"]')).toHaveCount(2, { timeout: KERNEL_TIMEOUT_MS });
    await expect(revision.locator('[aria-label="穴の寸法を確定"]')).toHaveCount(1);
    await expect(revision.locator('[aria-label="備考を追加"]')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('drawing-hole-revision-reopened.png'), fullPage: true });
    expect(errors).toEqual([]);
  });

  test('組図の部品表・風船が双方向に連動し、参照部品ごと保存して開き直せる(P8-55・59・64)', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    });
    await page.goto('/');
    const openButton = page.locator('.pcad-toolbar').getByRole('button', { name: '開く', exact: true });
    await expect(openButton).toBeVisible();
    const opening = page.waitForEvent('filechooser'); await openButton.click();
    const token = await beginRecompute(page);
    const originalAssembly = await twoBoxAssemblyFile();
    await (await opening).setFiles({ name: '2部品.pcada', mimeType: 'application/zip', buffer: Buffer.from(originalAssembly) });
    await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
    await waitForRecompute(page, token);
    await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/u }).first().click();
    await page.getByRole('button', { name: 'この組立から図面を作成', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg svg')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
    const paths = page.locator('.pcad-drawing-svg [data-owner-id^="projection:"] path');
    await expect.poll(() => paths.count(), { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
    await openDrawingProperties(page, 'table');
    const tables = page.locator('.pcad-drawing-table-editor');
    await tables.getByLabel('表と部品番号', { exact: true }).selectOption('bom');
    await tables.getByRole('checkbox', { name: '構成', exact: true }).check();
    await tables.getByRole('button', { name: '表を配置', exact: true }).click();
    const row = page.locator('.pcad-drawing-svg [data-owner-id^="bom-row:"]');
    await expect(row.locator('[aria-label="既定"]')).toHaveCount(1);
    await expect(row.locator('[aria-label="2"]')).toHaveCount(1); // 同じ参照の2配置を数量2と集計
    const clickEdge = async (): Promise<void> => {
      const point = await paths.first().evaluate((element) => {
        if (!(element instanceof SVGPathElement)) throw new Error('投影線がありません');
        const local = element.getPointAtLength(element.getTotalLength() / 2), matrix = element.getScreenCTM();
        if (matrix === null) throw new Error('用紙がありません');
        const client = new DOMPoint(local.x, local.y).matrixTransform(matrix); return { x: client.x, y: client.y };
      });
      await page.mouse.click(point.x, point.y);
    };
    await clickEdge();
    await expect(row.locator('path[fill="#2563eb"]').first()).toBeVisible();
    await openDrawingProperties(page, 'table');
    await page.getByRole('button', { name: '部品番号の風船', exact: true }).click();
    // 直前の投影線の選択を使って、紙上320,220mmへ風船を置く。
    const position = await page.locator('.pcad-drawing-svg svg').evaluate((element) => {
      if (!(element instanceof SVGSVGElement)) throw new Error('図面がありません');
      const matrix = element.getScreenCTM(); if (matrix === null) throw new Error('用紙がありません');
      const point = new DOMPoint(320, element.viewBox.baseVal.height - 220).matrixTransform(matrix);
      return { x: point.x, y: point.y };
    });
    await page.mouse.click(position.x, position.y);
    const balloon = page.locator('.pcad-drawing-svg [data-owner-id="balloon-1"]');
    await expect(balloon.locator('[aria-label="1"]')).toHaveCount(1);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click(); await expect(balloon).toHaveCount(0);
    await page.getByRole('button', { name: 'やり直す', exact: true }).click(); await expect(balloon.locator('[aria-label="1"]')).toHaveCount(1);
    // 表の行からも対応する配置と風船が強調される。選択で文書や番号は変えない。
    const rowNumber = row.locator('[aria-label="2"]');
    const rowBounds = await waitForTextBounds(rowNumber);
    await page.mouse.click(rowBounds.x + rowBounds.width / 2, rowBounds.y + rowBounds.height / 2);
    await expectDrawingStroke(balloon.locator('path[stroke="#2563eb"]'));
    await expectDrawingStroke(page.locator('.pcad-drawing-svg [data-owner-id^="projection:"] path[stroke="#2563eb"]'));
    await page.screenshot({ path: testInfo.outputPath('drawing-bom-balloon.png'), fullPage: true });
    const updating = page.waitForEvent('filechooser');
    await chooseDrawingMenu(page, 'ファイル', '元の部品・組立を取り込み直す');
    await (await updating).setFiles({ name: '2部品.pcada', mimeType: 'application/zip', buffer: Buffer.from(await addThirdBoxAssemblyFile(originalAssembly)) });
    await expect(row.locator('[aria-label="3"]')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
    await expect(balloon.locator('[aria-label="1"]')).toHaveCount(1);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(row.locator('[aria-label="2"]')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
    await page.getByRole('button', { name: 'やり直す', exact: true }).click();
    await expect(row.locator('[aria-label="3"]')).toHaveCount(1, { timeout: KERNEL_TIMEOUT_MS });
    // 図面モードかつ入力欄に焦点がある場合も、共通の保存処理へ届く。
    await openDrawingProperties(page, 'sheet');
    await page.getByLabel('図面ひな形の名前', { exact: true }).focus();
    const saving = page.waitForEvent('download'); await page.keyboard.press('Control+s');
    const download = await saving; expect(download.suggestedFilename()).toMatch(/\.pcadd$/u);
    await expect(page.locator('.pcad-statusbar')).toContainText('保存しました');
    const savedPath = await download.path(); if (savedPath === null) throw new Error('図面を保存できませんでした');
    const bytes = await readFile(savedPath);
    await page.reload(); // 元のアセンブリもカーネルの形も無い新しい実行環境で開く
    await expect(openButton).toBeVisible();
    const reopening = page.waitForEvent('filechooser'); await openButton.click();
    await (await reopening).setFiles({ name: '組図.pcadd', mimeType: 'application/zip', buffer: bytes });
    await expect.poll(() => paths.count(), { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
    await expect(row.locator('[aria-label="3"]')).toHaveCount(1);
    await expect(balloon.locator('[aria-label="1"]')).toHaveCount(1);
    await expect(page.locator('.pcad-drawing-notice')).toHaveCount(0);
    await expect(row.locator('[aria-label="既定"]')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('4分割の実描画性能・区画ごとの立体選択と1画面復帰(FR-113)', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await createBox(page);
    const namedMenu = page.locator('details').filter({ has: page.locator('summary', { hasText: /^保存した視点$/u }) });
    await namedMenu.locator('summary').click(); await page.getByRole('button', { name: '4分割で見る', exact: true }).click();
    await namedMenu.locator('summary').click();
    const canvas = page.locator('canvas.pcad-viewport__canvas');
    await expect(canvas).toHaveCount(1); await expect(page.locator('.pcad-quad__pane')).toHaveCount(4);
    const box = await canvas.boundingBox(); if (box === null) throw new Error('描画面がありません');
    // 4区画の中心に同じ実ボディが見え、実際のraycastで各方向から選べる。
    for (const [x, y] of [[0.25, 0.25], [0.25, 0.75], [0.75, 0.75], [0.75, 0.25]]) {
      await canvas.focus(); await page.keyboard.press('Escape'); await page.keyboard.press('4');
      await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
      const selected = page.locator('.pcad-panel--right dt').filter({ hasText: /^選んでいるもの$/u }).locator('xpath=following-sibling::dd[1]');
      await expect(selected).toHaveText('立体');
    }
    await page.screenshot({ path: testInfo.outputPath('quad-four-views.png'), fullPage: true });
    const center = { x: box.x + box.width * 0.75, y: box.y + box.height * 0.25 };
    await page.mouse.move(center.x, center.y);
    const stats = () => page.evaluate(() => {
      const value = window.pcadViewportRenderStats?.(); if (value === undefined) throw new Error('描画統計がありません');
      return { ...value, now: performance.now() };
    });
    await page.mouse.down({ button: 'middle' });
    const before = await stats();
    try {
      const end = Date.now() + 2000; let index = 0;
      while (Date.now() < end) {
        const sign = index++ % 2 === 0 ? 1 : -1;
        await page.mouse.move(center.x + sign * 36, center.y + sign * 18);
      }
    } finally { await page.mouse.up({ button: 'middle' }); }
    const after = await stats(), elapsedMs = after.now - before.now, frames = after.completedRenders - before.completedRenders;
    const fps = frames * 1000 / elapsedMs;
    console.log(`[実測] 4分割ビューポート: ${fps.toFixed(1)} fps (${frames}画面/${elapsedMs.toFixed(1)}ms、1画面は4カメラ分)`);
    expect(fps).toBeGreaterThanOrEqual(30);
    await namedMenu.locator('summary').click(); await page.getByRole('button', { name: '1画面に戻す', exact: true }).click();
    await expect(page.locator('.pcad-quad')).toHaveCount(0); await expect(canvas).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('用紙と表題欄をひな形へ保存し、空の図面から保存した視点で投影図を作る(P8-58〜60)', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await createBox(page);
    const namedMenu = page.locator('details').filter({ has: page.locator('summary', { hasText: /^保存した視点$/u }) });
    await namedMenu.locator('summary').click();
    await namedMenu.getByLabel('視点を選ぶ', { exact: true }).selectOption('namedView-top');
    await namedMenu.getByRole('button', { name: 'この視点へ', exact: true }).click();
    await namedMenu.getByLabel('視点の名前', { exact: true }).fill('検査用の平面');
    await namedMenu.getByRole('button', { name: '今の視点を保存', exact: true }).click();
    await namedMenu.getByLabel('視点を選ぶ', { exact: true }).selectOption({ label: '検査用の平面' });
    await namedMenu.getByRole('button', { name: 'この視点へ', exact: true }).click();
    await namedMenu.locator('summary').click();
    const savingPart = page.waitForEvent('download'); await page.keyboard.press('Control+s');
    const partDownload = await savingPart, partPath = await partDownload.path();
    if (partPath === null) throw new Error('視点を含む部品を保存できませんでした');
    const partBytes = await readFile(partPath);
    await page.reload();
    const openButton = page.getByRole('button', { name: '開く', exact: true }); await expect(openButton).toBeVisible();
    const reopeningPart = page.waitForEvent('filechooser'); await openButton.click();
    const reopeningGeneration = await beginRecompute(page);
    await (await reopeningPart).setFiles({ name: '視点を含む部品.pcad', mimeType: 'application/zip', buffer: partBytes });
    await waitForRecompute(page, reopeningGeneration);
    await namedMenu.locator('summary').click();
    await namedMenu.getByLabel('視点を選ぶ', { exact: true }).selectOption({ label: '検査用の平面' });
    await namedMenu.getByRole('button', { name: 'この視点へ', exact: true }).click();
    await namedMenu.locator('summary').click();
    await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/u }).first().click();
    await page.getByRole('button', { name: 'この部品から図面を作成', exact: true }).click();
    await expect.poll(() => page.locator('.pcad-drawing-svg [data-owner-id="view-1"] path').count(), { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
    const settings = page.locator('.pcad-drawing-property-section[data-property-kind="sheet"]');
    await settings.getByLabel('図名', { exact: true }).fill('ひな形の製品図');
    await settings.getByLabel('文字の高さ（mm）', { exact: true }).fill('2.5');
    await settings.getByRole('button', { name: '用紙設定を適用', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="ひな形の製品図"]')).toHaveCount(1);
    await settings.getByLabel('図面ひな形の名前', { exact: true }).fill('社内A3標準');
    const downloading = page.waitForEvent('download');
    await settings.getByRole('button', { name: '図面ひな形として保存', exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('社内A3標準.pcadt');
    const path = await download.path(); if (path === null) throw new Error('ひな形の保存先がありません');
    page.once('dialog', (dialog) => { void dialog.accept(); });
    await chooseDrawingMenu(page, 'ファイル', '部品へ戻る');
    await expect(page.locator('canvas.pcad-viewport__canvas')).toHaveCount(1);
    await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/u }).first().click();
    const choosing = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '図面ひな形から作成', exact: true }).click();
    await (await choosing).setFiles({ name: '社内A3標準.pcadt', mimeType: 'application/zip', buffer: await readFile(path) });
    await expect(page.locator('.pcad-drawing-svg svg')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
    await expect(page.locator('.pcad-drawing-svg [data-owner-id^="view-"]')).toHaveCount(0);
    await expect(settings.getByLabel('図名', { exact: true })).toHaveValue('ひな形の製品図');
    await openDrawingProperties(page, 'view');
    const view = page.locator('.pcad-drawing-property-section[data-property-kind="view"]');
    await view.getByLabel('元の部品で保存した視点', { exact: true }).selectOption({ label: '検査用の平面' });
    await view.getByRole('button', { name: '投影図を追加', exact: true }).click();
    await expect.poll(() => page.locator('.pcad-drawing-svg [data-owner-id="view-1"] path').count(), { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [data-owner-id="view-1"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'やり直す', exact: true }).click();
    await expect.poll(() => page.locator('.pcad-drawing-svg [data-owner-id="view-1"] path').count(), { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath('drawing-template-view.png'), fullPage: true });
    expect(errors).toEqual([]);
  });

  test('箱の三面図→寸法→公差・はめあい→Undo→自動寸法→実字体SVG', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await drawingFromBox(page);
    // 垂直/水平のSVG線は矩形の幅/高さが0でもstrokeが見える。長さと実クリックで検査する。
    for (const id of ['view-1', 'view-2', 'view-3']) expect(await page.locator(`.pcad-drawing-svg [data-owner-id="${id}"] path`).first()
      .evaluate((element) => element instanceof SVGPathElement ? element.getTotalLength() : 0)).toBeGreaterThan(0);
    await clickFrontEdge(page); await page.keyboard.press('Enter');
    const form = page.getByRole('form', { name: '寸法の公差・はめあい' });
    await expect(form).toBeVisible(); await expect(form.locator('output')).toHaveText('20');
    await form.getByLabel('寸法値の前に付ける文字', { exact: true }).fill('4×');
    await form.getByLabel('寸法値の後に付ける文字', { exact: true }).fill(' 通し');
    await form.getByLabel('参考寸法として括弧を付ける', { exact: true }).check();
    await form.getByLabel('寸法線の位置（mm）', { exact: true }).fill('120');
    await form.getByLabel('寸法文字を自動で配置する', { exact: true }).uncheck();
    await form.getByLabel('寸法文字の横位置（mm）', { exact: true }).fill('115');
    await form.getByLabel('寸法文字の縦位置（mm）', { exact: true }).fill('125');
    await form.getByRole('button', { name: '決定', exact: true }).click();
    await expect(form.locator('output')).toHaveText('(4×20 通し)');
    await expect(page.locator('.pcad-drawing-svg [aria-label="(4×20 通し)"]')).toHaveCount(1);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    // 図面の文字自体はpointer-events:none。用紙が実文字の範囲で選択を処理する。
    const restoredText = await waitForTextBounds(page.locator('.pcad-drawing-svg [aria-label="20"]'));
    await page.mouse.click(restoredText.x + restoredText.width / 2, restoredText.y + restoredText.height / 2);
    await expect(form.getByLabel('寸法値の前に付ける文字', { exact: true })).toHaveValue('');
    await expect(form.getByLabel('寸法文字を自動で配置する', { exact: true })).toBeChecked();
    await form.getByRole('combobox', { name: '記入方法', exact: true }).selectOption('symmetric');
    await form.getByLabel('対称公差', { exact: true }).fill('0.1');
    await form.getByRole('button', { name: '決定', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="20±0.1"]')).toHaveCount(1);
    await form.getByRole('combobox', { name: '記入方法', exact: true }).selectOption('fit');
    await form.getByRole('button', { name: '決定', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="20H7"]')).toHaveCount(1);
    await expect(page.locator('.pcad-drawing-svg [aria-label="+0.021"]')).toHaveCount(1);
    // 決定ボタンに焦点が残っていても、Ctrl+Zは図面の履歴へ届く。
    await page.keyboard.press('Control+z');
    await expect(page.locator('.pcad-drawing-svg [aria-label="20±0.1"]')).toHaveCount(1);
    const text = page.locator('.pcad-drawing-svg [aria-label="20±0.1"]');
    const beforeDrag = await waitForTextBounds(text);
    await page.mouse.move(beforeDrag.x + beforeDrag.width / 2, beforeDrag.y + beforeDrag.height / 2);
    await page.mouse.down();
    await page.mouse.move(beforeDrag.x + beforeDrag.width / 2 + 15, beforeDrag.y + beforeDrag.height / 2 - 12, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await readTextBounds(text))?.x).toBeCloseTo(beforeDrag.x + 15, 0);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect.poll(async () => (await readTextBounds(text))?.x).toBeCloseTo(beforeDrag.x, 0);
    await chooseDrawingMenu(page, '寸法', '自動寸法');
    await expect(page.locator('.pcad-drawing-svg [aria-label="20"]')).toHaveCount(6);
    // 手動の公差文字との間に用紙上2mmを取り、別々の指示として読めるようにする。
    // 全7文字を同じ再描画の状態から読み、途中のDOM交換による混在も防ぐ。
    await expect.poll(() => page.locator('.pcad-drawing-svg').evaluate((element) => {
      const manual = element.querySelector('[aria-label="20±0.1"]')?.getBoundingClientRect();
      const automatic = Array.from(element.querySelectorAll('[aria-label="20"]'), (item) => item.getBoundingClientRect());
      if (manual === undefined || manual.width <= 0 || manual.height <= 0 || automatic.length !== 6
        || automatic.some((item) => item.width <= 0 || item.height <= 0)) return null;
      const svg = element.querySelector('svg'), matrix = svg?.getScreenCTM();
      if (matrix == null) return null;
      const gap = Math.hypot(matrix.a, matrix.b) * 1.99;
      return automatic.map((bounds) => bounds.x < manual.x + manual.width + gap && manual.x < bounds.x + bounds.width + gap
        && bounds.y < manual.y + manual.height + gap && manual.y < bounds.y + bounds.height + gap);
    }), { message: '手動1件と自動6件の実文字に紙上2mmの間隔がある' }).toEqual([false, false, false, false, false, false]);
    const downloadPromise = page.waitForEvent('download');
    await chooseDrawingMenu(page, 'ファイル', 'SVGで書き出す');
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.svg$/);
    const path = await download.path();
    if (path === null) throw new Error('SVGが保存されなかった');
    const svg = await readFile(path, 'utf8');
    expect(svg).toContain('width="420mm"'); expect(svg).not.toContain('<text'); expect(svg).toContain('20±0.1');
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('drawing-dimensions.png'), fullPage: true });
    const toolbar = await page.locator('.pcad-toolbar').boundingBox();
    expect(toolbar?.height).toBeLessThanOrEqual(100);
  });
  test('図面の面を選び、その場の入力で表面性状を配置できる', async ({ page }, testInfo) => {
    await drawingFromBox(page);
    const box = await page.locator('.pcad-drawing-svg [data-owner-id="view-1"]').evaluateAll((elements) => {
      const boxes = elements.map((element) => element.getBoundingClientRect());
      return { left: Math.min(...boxes.map((item) => item.left)), right: Math.max(...boxes.map((item) => item.right)),
        top: Math.min(...boxes.map((item) => item.top)), bottom: Math.max(...boxes.map((item) => item.bottom)) };
    });
    await page.mouse.click((box.left + box.right) / 2, (box.top + box.bottom) / 2);
    await chooseDrawingMenu(page, '記入', '注記');
    const form = page.getByRole('form', { name: '注記', exact: true });
    await expect(form).toBeVisible();
    await form.getByRole('button', { name: '決定', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="Ra 3.2"]')).toHaveCount(1);
    await form.getByLabel('粗さ（μm・式も入力可能）', { exact: true }).fill('8/5');
    await form.getByRole('combobox', { name: '粗さの種類', exact: true }).selectOption('Rz');
    await form.getByLabel('文字の高さ (mm)', { exact: true }).fill('5');
    await form.getByLabel('横の位置 (mm)', { exact: true }).fill('160');
    await form.getByRole('button', { name: '決定', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="Rz 1.6"]')).toHaveCount(1);
    await expect(page.locator('.pcad-drawing-svg [aria-label="Ra 3.2"]')).toHaveCount(0);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="Ra 3.2"]')).toHaveCount(1);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="Ra 3.2"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'やり直す', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="Ra 3.2"]')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('drawing-surface-finish.png'), fullPage: true });
  });
});

test.describe('P8 図面の出力と文字注記', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  async function addNote(page: Page): Promise<void> {
    await chooseDrawingMenu(page, '記入', '文字注記');
    const point = await page.locator('.pcad-drawing-svg svg').evaluate((element) => {
      if (!(element instanceof SVGSVGElement)) throw new Error('図面のSVGが無い');
      const matrix = element.getScreenCTM();
      if (matrix === null) throw new Error('用紙の位置が無い');
      const client = new DOMPoint(80, 77).matrixTransform(matrix);
      return { x: client.x, y: client.y };
    });
    await page.mouse.click(point.x, point.y);
    const form = page.getByRole('form', { name: '文字注記', exact: true });
    await expect(form).toBeVisible();
    await form.getByLabel('注記の文章', { exact: true }).fill('8 日 φ\n加工面は清掃する');
    await form.getByRole('button', { name: '決定', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="8 日 φ"]')).toHaveCount(1);
    await expect(page.locator('.pcad-drawing-svg [aria-label="加工面は清掃する"]')).toHaveCount(1);
    await form.getByRole('button', { name: '閉じる', exact: true }).click();
  }

  async function downloadFormat(page: Page, format: 'pdf' | 'svg' | 'dxf' | 'png' | 'jpg', dpi?: number) {
    await chooseDrawingMenu(page, 'ファイル', '図面を書き出す');
    const form = page.getByRole('form', { name: '図面を書き出す', exact: true });
    await form.getByLabel('ファイルの種類', { exact: true }).selectOption(format);
    if (dpi !== undefined) await form.getByLabel('画像の解像度', { exact: true }).selectOption(String(dpi));
    const pending = page.waitForEvent('download');
    await form.getByRole('button', { name: '書き出す', exact: true }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toMatch(new RegExp(`\\.${format}$`));
    const path = await download.path();
    if (path === null) throw new Error('書き出したファイルが無い');
    return { download, bytes: await readFile(path) };
  }

  test('図面ツリーの5つの束で選択・折りたたみ・対応表示ができる(P8-67)', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await drawingFromBox(page); await addNote(page);
    const tree = page.locator('.pcad-panel--left');
    const groups = tree.locator('.pcad-drawing-tree-group');
    await expect(groups).toHaveCount(5);
    await expect(tree.locator('.pcad-drawing-tree-sheet')).not.toContainText('landscape');
    await expect(page.getByTestId('drawing-status-scale')).toHaveText('縮尺 2:1');
    await expect(page.getByTestId('drawing-status-paper')).toContainText('A3');
    await expect(page.getByTestId('drawing-status-unresolved')).toHaveText('未解決 0');
    for (const name of ['投影図', '寸法', '注記', '表', 'レイヤー']) {
      await expect(groups.locator('summary').filter({ hasText: name })).toHaveCount(1);
    }
    // 見出しに追加した余白で右端の件数が左パネルの外へ押し出されない。
    expect(await tree.evaluate((element) => {
      const right = element.getBoundingClientRect().right;
      return Array.from(element.querySelectorAll('summary .pcad-tree__count'))
        .every((count) => count.getBoundingClientRect().right <= right);
    })).toBe(true);
    const noteRow = tree.getByRole('button', { name: '8 日 φ', exact: true });
    const noteText = page.locator('.pcad-drawing-svg [aria-label="8 日 φ"]');
    await noteRow.click();
    await expect(noteRow).toHaveAttribute('aria-pressed', 'true');
    const isNoteHighlighted = async (): Promise<boolean> => noteText.evaluate((element) => {
      const paths = element.matches('path') ? [element] : Array.from(element.querySelectorAll('path'));
      return paths.some((path) => getComputedStyle(path).fill === 'rgb(37, 99, 235)');
    });
    await expect.poll(isNoteHighlighted).toBe(true);
    const summary = groups.locator('summary').filter({ hasText: '注記' });
    await summary.focus(); await summary.press('Enter');
    await expect(noteRow).toBeHidden();
    // 折りたたみだけでは保存状態と対応表示を変えない。
    await expect.poll(isNoteHighlighted).toBe(true);
    await summary.press('Enter'); await expect(noteRow).toBeVisible();
    await expect(noteRow).toHaveAttribute('aria-pressed', 'true');
    await tree.locator('.pcad-drawing-tree-sheet').click();
    await expect(noteRow).toHaveAttribute('aria-pressed', 'false');
    const bounds = await waitForTextBounds(noteText);
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await expect(noteRow).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('form', { name: '文字注記', exact: true }).getByRole('button', { name: '閉じる', exact: true }).click();
    const layerGroup = groups.filter({ has: page.locator('summary', { hasText: 'レイヤー' }) });
    await layerGroup.getByRole('button', { name: '注記', exact: true }).click();
    await expect.poll(isNoteHighlighted).toBe(true);
    await expect(noteRow).toHaveAttribute('aria-pressed', 'false');
    await noteRow.click({ modifiers: ['Control'] });
    await expect(noteRow).toHaveAttribute('aria-pressed', 'true');
    await expect(layerGroup.getByRole('button', { name: '注記', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await tree.locator('.pcad-drawing-tree-sheet').click();
    await openDrawingProperties(page, 'table');
    const tables = page.locator('.pcad-drawing-table-editor');
    await tables.getByLabel('表と部品番号', { exact: true }).selectOption('revision');
    await tables.getByLabel(`1 ${drawingMessage('drawing.table.revision')}`, { exact: true }).fill('A');
    await tables.getByRole('button', { name: '表を配置', exact: true }).click();
    const tableRow = tree.getByRole('button', { name: '改訂欄 1', exact: true });
    await tableRow.click(); await expect(tableRow).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.locator('.pcad-drawing-svg [data-owner-id="table-1"] [stroke="#2563eb"]').count()).toBeGreaterThan(0);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(tableRow).toHaveCount(0);
    await expect(noteRow).toHaveCount(1);
    await page.getByRole('button', { name: 'やり直す', exact: true }).click();
    await expect(tableRow).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('drawing-tree-groups.png'), fullPage: true });
    expect(errors).toEqual([]);
  });

  test('レイヤーを作成し、表示・出力・削除をUndoで戻せる(P8-68-layer)', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await drawingFromBox(page); await addNote(page);
    const tree = page.locator('.pcad-panel--left');
    const group = tree.locator('.pcad-drawing-tree-group').filter({ has: page.locator('summary', { hasText: 'レイヤー' }) });
    await group.getByRole('button', { name: '注記', exact: true }).click();
    const form = page.getByRole('form', { name: drawingMessage('drawing.property.layer'), exact: true });
    const text = page.locator('.pcad-drawing-svg [aria-label="8 日 φ"]');
    await form.getByLabel('印刷・書き出しに含める', { exact: true }).uncheck();
    await form.getByRole('button', { name: '決定', exact: true }).click();
    await expect(text).toHaveCount(1);
    const { bytes } = await downloadFormat(page, 'svg');
    expect(bytes.toString('utf8')).not.toContain('8 日 φ');
    await form.getByLabel('画面に表示する', { exact: true }).uncheck();
    await form.getByRole('button', { name: '決定', exact: true }).click();
    await expect(text).toHaveCount(0);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(text).toHaveCount(1);
    await group.getByRole('button', { name: '注記', exact: true }).click();
    await form.getByRole('button', { name: 'レイヤーを削除', exact: true }).click();
    await expect(form).toContainText('1件を削除');
    await form.getByRole('button', { name: '含まれる要素と一緒に削除', exact: true }).click();
    await expect(text).toHaveCount(0);
    await expect(group.getByRole('button', { name: '注記', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(text).toHaveCount(1);
    await expect(group.getByRole('button', { name: '注記', exact: true })).toHaveCount(1);
    await chooseDrawingMenu(page, '見た目', drawingMessage('drawing.tool.layer'));
    await form.getByLabel('レイヤーの名前', { exact: true }).fill('検査用');
    await form.getByLabel('線の太さ（mm）', { exact: true }).fill('0');
    await form.getByRole('button', { name: 'レイヤーを追加', exact: true }).click();
    await expect(group.getByRole('button', { name: '検査用', exact: true })).toHaveCount(0);
    await expect(page.locator('.pcad-statusbar')).toContainText('0より大きい');
    await form.getByLabel('線の太さ（mm）', { exact: true }).fill('0.35');
    await form.getByRole('button', { name: 'レイヤーを追加', exact: true }).click();
    await expect(group.getByRole('button', { name: '検査用', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await form.getByRole('button', { name: 'レイヤーを1つ上へ', exact: true }).click();
    await expect(group.getByRole('button').nth(6)).toHaveText('検査用');
    await expect(page.locator('.pcad-drawing-property-section')).toHaveCount(6);
    await tree.getByRole('button', { name: '8 日 φ', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(page.getByRole('form', { name: '文字注記', exact: true })).toBeVisible();
    await page.getByLabel('選んだ要素のレイヤー', { exact: true }).selectOption('layer-8');
    await group.getByRole('button', { name: '検査用', exact: true }).click();
    await expect(form.getByLabel('レイヤーの名前', { exact: true })).toHaveValue('検査用');
    await expect(page.getByRole('form', { name: '文字注記', exact: true })).toHaveCount(0);
    await expect.poll(() => text.evaluate((element) => {
      const paths = element.matches('path') ? [element] : Array.from(element.querySelectorAll('path'));
      return paths.some((path) => getComputedStyle(path).fill === 'rgb(37, 99, 235)');
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('drawing-layer-settings.png'), fullPage: true });
    expect(errors).toEqual([]);
  });

  test('複数行の文字注記を編集・移動してもUndo一回ずつで戻る', async ({ page }, testInfo) => {
    await drawingFromBox(page); await addNote(page);
    const text = page.locator('.pcad-drawing-svg [aria-label="8 日 φ"]');
    const before = await waitForTextBounds(text);
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 20, before.y + before.height / 2 - 10, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await readTextBounds(text))?.x).toBeCloseTo(before.x + 20, 0);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect.poll(async () => (await readTextBounds(text))?.x).toBeCloseTo(before.x, 0);
    // Undoは選択を解除するので、画面上の注記を選び直して編集する。
    const restored = await waitForTextBounds(text);
    await page.mouse.click(restored.x + restored.width / 2, restored.y + restored.height / 2);
    const form = page.getByRole('form', { name: '文字注記', exact: true });
    await form.getByLabel('注記の文章', { exact: true }).fill('検査済み');
    await form.getByRole('button', { name: '決定', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="検査済み"]')).toHaveCount(1);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(text).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('drawing-note.png'), fullPage: true });
  });

  test('部品へ戻る際の破棄を断ると図面とUndoが残り、同意した時だけ閉じる（R03）', async ({ page }) => {
    await drawingFromBox(page); await addNote(page);
    const text = page.locator('.pcad-drawing-svg [aria-label="8 日 φ"]');
    const dialogOpened = page.waitForEvent('dialog');
    const clicked = chooseDrawingMenu(page, 'ファイル', '部品へ戻る');
    const dialog = await dialogOpened;
    expect(dialog.type()).toBe('confirm'); expect(dialog.message()).toContain('保存していない変更');
    await dialog.dismiss(); await clicked;
    await expect(text).toHaveCount(1);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(text).toHaveCount(0);
    const confirmed = page.waitForEvent('dialog');
    const returnClick = chooseDrawingMenu(page, 'ファイル', '部品へ戻る');
    await (await confirmed).accept(); await returnClick;
    await expect(page.locator('.pcad-drawing-svg')).toHaveCount(0);
    await expect(page.locator('canvas.pcad-viewport__canvas')).toBeVisible();
  });

  test('注記を含む同じ図面をPDF・SVG・R12 DXFへ書き出す', async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await drawingFromBox(page); await addNote(page);
    for (const format of ['pdf', 'svg', 'dxf'] as const) {
      const { bytes, download } = await downloadFormat(page, format);
      await download.saveAs(testInfo.outputPath(`drawing-output.${format}`));
      const content = bytes.toString('utf8');
      if (format === 'pdf') {
        expect(content.startsWith('%PDF-1.4')).toBe(true);
        expect(content).toMatch(/\/MediaBox\s*\[0 0 1190\.5512 841\.8898\]/u);
        expect(content).not.toContain('/Subtype /Image');
      } else if (format === 'svg') {
        expect(content).toContain('width="420mm"'); expect(content).toContain('8 日 φ'); expect(content).not.toContain('<text');
      } else {
        expect(content).toContain('AC1009'); expect(content).toContain('TEXT'); expect(content).toContain('\\U+65E5');
        await expect(page.locator('.pcad-statusbar')).toContainText('線の太さは保存されません');
      }
      console.log(`[実測] 図面${format}: ${bytes.length}バイト`);
    }
    await chooseDrawingMenu(page, 'ファイル', '図面を書き出す');
    await page.getByRole('form', { name: '図面を書き出す', exact: true }).getByLabel('ファイルの種類', { exact: true }).selectOption('pdf');
    await page.screenshot({ path: testInfo.outputPath('drawing-export-panel.png'), fullPage: true });
    expect(errors).toEqual([]);
  });

  test('図面の印刷ボタンが実寸の紙面を渡し、印刷後も図面とUndoを保つ', async ({ page, context }, testInfo) => {
    await drawingFromBox(page); await addNote(page);
    // window.printは置き換えず、ブラウザーの実際のbeforeprintで紙面を採取する。
    await page.evaluate(() => {
      window.addEventListener('beforeprint', () => {
        const image = document.querySelector('.pcad-drawing-print-sheet img');
        if (!(image instanceof HTMLImageElement)) return;
        const style = Array.from(document.querySelectorAll('style')).find((item) => item.textContent.includes('.pcad-drawing-print-sheet'));
        document.documentElement.dataset.printCss = style?.textContent ?? '';
        // Blob URLの読取は印刷中に開始する。アプリによる後始末を遅らせない。
        void fetch(image.src).then((response) => response.text()).then((svg) => {
          document.documentElement.dataset.printSvg = svg;
        });
      }, { once: true });
    });
    await chooseDrawingMenu(page, 'ファイル', '図面を印刷');
    await expect.poll(() => page.locator('html').getAttribute('data-print-svg')).toContain('8 日 φ');
    await expect(page.locator('.pcad-drawing-print-sheet')).toHaveCount(0);
    const output = await page.locator('html').evaluate((element) => ({ svg: element.dataset.printSvg ?? '', css: element.dataset.printCss ?? '' }));
    expect(output.css).toContain('@page { size: A3 landscape; margin: 0; }');
    expect(output.svg).toContain('width="420mm"'); expect(output.svg).not.toContain('<text');
    const printed = await context.newPage();
    try {
      await printed.evaluate(async ({ svg, css }) => {
        const style = document.createElement('style'); style.textContent = css; document.head.append(style);
        const sheet = document.createElement('section'); sheet.className = 'pcad-drawing-print-sheet';
        const image = document.createElement('img');
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        sheet.append(image); document.body.append(sheet); await image.decode();
      }, output);
      const bytes = await printed.pdf({ preferCSSPageSize: true, printBackground: true, path: testInfo.outputPath('drawing-browser-print.pdf') });
      expect(bytes.length).toBeGreaterThan(1000);
    } finally { await printed.close(); }
    await expect(page.locator('.pcad-drawing-svg [aria-label="8 日 φ"]')).toHaveCount(1);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="8 日 φ"]')).toHaveCount(0);
  });

  test('A3の実画像を600dpi PNGと150dpi JPEGで保存し、白い背景で開ける', async ({ page }, testInfo) => {
    await drawingFromBox(page); await addNote(page);
    for (const [format, dpi, width, height] of [['png', 600, 9921, 7016], ['jpg', 150, 2480, 1754]] as const) {
      const started = Date.now();
      const { bytes, download } = await downloadFormat(page, format, dpi);
      await download.saveAs(testInfo.outputPath(`drawing-${dpi}.${format}`));
      const decoded = await page.evaluate(async ({ base64, mime }) => {
        const data = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([data], { type: mime }));
        const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
        const context = canvas.getContext('2d'); if (context === null) throw new Error('画像の読取に失敗');
        try {
          context.drawImage(bitmap, 0, 0, 1, 1, 0, 0, 1, 1);
          return { width: bitmap.width, height: bitmap.height, corner: Array.from(context.getImageData(0, 0, 1, 1).data) };
        } finally { bitmap.close(); canvas.width = 0; canvas.height = 0; }
      }, { base64: bytes.toString('base64'), mime: format === 'png' ? 'image/png' : 'image/jpeg' });
      expect(decoded).toEqual({ width, height, corner: [255, 255, 255, 255] });
      expect(bytes.length).toBeGreaterThan(1000);
      console.log(`[実測] A3 ${dpi}dpi ${format}: ${decoded.width}×${decoded.height}, ${bytes.length}バイト, ${Date.now() - started}ms`);
    }
  });
});

test('P8 文字の輪郭を作図面へ置き、全ての辺をUndo一回で戻せる', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  const sketch = page.locator('.pcad-panel--left .pcad-tree__sections > li').filter({ hasText: 'スケッチ' });
  const rows = sketch.locator('.pcad-tree__children > li');
  await expect(rows).toHaveCount(0);
  await page.getByRole('group', { name: 'スケッチ' }).locator('.pcad-menu__trigger').first().click();
  await page.locator('.pcad-menu__panel[aria-label="作図"]').getByRole('button', { name: '文字をかく', exact: true }).click();
  await page.locator('canvas.pcad-viewport__canvas').click();
  const form = page.getByRole('form', { name: '文字をかく', exact: true });
  await expect(form).toBeVisible();
  await form.getByLabel('文字列', { exact: true }).fill('8日φ');
  await form.getByLabel('文字の高さ (mm)', { exact: true }).fill('12');
  await form.getByLabel('文字の角度 (°)', { exact: true }).fill('30');
  await form.getByRole('button', { name: '決定', exact: true }).click();
  await expect(form).toBeHidden();
  await expect.poll(() => rows.count()).toBeGreaterThan(10);
  const featureCount = await rows.count();
  await page.keyboard.press('Control+z'); await expect(rows).toHaveCount(0);
  await page.keyboard.press('Control+y'); await expect(rows).toHaveCount(featureCount);
  await page.screenshot({ path: testInfo.outputPath('sketch-text-outlines.png'), fullPage: true });
});
