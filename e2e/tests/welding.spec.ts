/// <reference lib="dom" />
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { KERNEL_TIMEOUT_MS } from './recompute.js';
import { drawingFromBox, chooseDrawingMenu } from './drawingManufacturingFixture.js';
import { drawingMessage } from './drawingMessages.js';

test.describe('P9 溶接記号の実操作', () => {
  test('8種類・両側・式・断続・現場・全周・折れ矢を作り、編集Undo・保存と5形式出力でも指示が残る', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const original = Worker.prototype.postMessage;
      const methods: string[] = [];
      Object.defineProperty(window, 'pcadWorkerMethods', { configurable: true, get: () => [...methods] });
      Worker.prototype.postMessage = function (this: Worker, message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
        const path: unknown = typeof message === 'object' && message !== null ? Reflect.get(message, 'path') : undefined;
        methods.push(Array.isArray(path) && path.every((item: unknown) => typeof item === 'string') ? path.join('.') : 'unknown');
        Reflect.apply(original, this, options === undefined ? [message] : [message, options]);
      };
    });
    await drawingFromBox(page);
    const form = page.getByRole('form', { name: drawingMessage('drawing.weld.title'), exact: true });
    const field = (key: string) => form.getByLabel(drawingMessage(`drawing.weld.${key}`), { exact: true });
    const owner = (id: string) => page.locator(`.pcad-drawing-svg [data-owner-id="${id}"]`);
    const tree = page.locator('.pcad-panel--left'), sheet = page.locator('.pcad-drawing-sheet');
    const workerMethods = () => page.evaluate((): string[] => {
      const value: unknown = Reflect.get(window, 'pcadWorkerMethods');
      if (!Array.isArray(value) || !value.every((entry: unknown) => typeof entry === 'string')) throw new Error('Worker記録なし');
      return value as string[];
    });
    async function face(): Promise<void> {
      const point = await owner('view-1').locator('path').evaluateAll((paths) => {
        const boxes = paths.map((path) => path.getBoundingClientRect());
        const left = Math.min(...boxes.map((box) => box.left)), right = Math.max(...boxes.map((box) => box.right));
        const top = Math.min(...boxes.map((box) => box.top)), bottom = Math.max(...boxes.map((box) => box.bottom));
        return { x: left + (right - left) * 0.35, y: top + (bottom - top) * 0.4 };
      });
      await page.mouse.click(point.x, point.y);
    }
    const kinds = ['fillet', 'squareButt', 'vButt', 'bevelButt', 'uButt', 'jButt', 'spot', 'seam'];
    for (const [index, kind] of kinds.entries()) {
      await chooseDrawingMenu(page, drawingMessage('drawing.toolbar.annotations'), drawingMessage('drawing.weld.title'));
      await face(); await field('kind').selectOption(kind);
      await form.getByLabel(drawingMessage('drawing.note.x'), { exact: true }).fill(String(index % 2 === 0 ? 130 : 285));
      await form.getByLabel(drawingMessage('drawing.note.y'), { exact: true }).fill(String(250 - Math.floor(index / 2) * 50));
      if (kind === 'fillet') {
        await field('sizeKind').selectOption('throat'); await field('size.throat').fill('10/2');
        await field('length').fill('100'); await field('count').fill('4'); await field('pitch').fill('200');
        await field('fieldWeld').check(); await field('tail').fill('SMAW');
      } else if (kind === 'vButt') {
        await field('side').selectOption('both');
        const arrow = form.getByRole('group', { name: drawingMessage('drawing.weld.side.arrow'), exact: true });
        const opposite = form.getByRole('group', { name: drawingMessage('drawing.weld.side.opposite'), exact: true });
        await opposite.getByLabel(drawingMessage('drawing.weld.kind'), { exact: true }).selectOption('vButt');
        await arrow.getByLabel(drawingMessage('drawing.weld.size.penetration'), { exact: true }).fill('6');
        await arrow.getByLabel(drawingMessage('drawing.weld.grooveDepth'), { exact: true }).fill('4');
        await arrow.getByLabel(drawingMessage('drawing.weld.grooveAngle'), { exact: true }).fill('60');
      } else if (kind === 'bevelButt' || kind === 'jButt') {
        await field('bend').check(); await field('tail').fill(`WPS-${kind}`); await field('closedTail').check();
      } else if (kind === 'spot') {
        await field('side').selectOption('center'); await field('size.diameter').fill('6');
        await field('count').fill('3'); await field('pitch').fill('30');
      } else if (kind === 'seam') await field('allAround').check();
      await form.getByRole('button', { name: drawingMessage('drawing.action.apply'), exact: true }).click();
      await expect.poll(() => owner(`weld-${index + 1}`).locator('path').count()).toBeGreaterThan(0);
      await expect(tree.getByRole('button', { name: `${drawingMessage('drawing.weld.title')} ${index + 1}`, exact: true })).toBeVisible();
    }
    await expect(owner('weld-1').locator('[aria-label="a5"]')).toHaveCount(1);
    await expect(owner('weld-1').locator('[aria-label="100(4)-200"]')).toHaveCount(1);
    await expect(owner('weld-3').locator('[aria-label="4(6)"]')).toHaveCount(1);
    await expect(owner('weld-7').locator('[aria-label="(3)-30"]')).toHaveCount(1);
    await tree.getByRole('button', { name: `${drawingMessage('drawing.weld.title')} 1`, exact: true }).click();
    await field('pitch').fill('50'); await form.getByRole('button', { name: drawingMessage('drawing.action.apply'), exact: true }).click();
    await expect(page.locator('.pcad-statusbar')).toContainText('中心間隔');
    await expect(owner('weld-1').locator('[aria-label="100(4)-200"]')).toHaveCount(1);
    await field('pitch').fill('200'); await field('size.throat').fill('12/2');
    await form.getByRole('button', { name: drawingMessage('drawing.action.apply'), exact: true }).click();
    await expect(owner('weld-1').locator('[aria-label="a6"]')).toHaveCount(1);
    await sheet.focus(); await page.keyboard.press('Control+z'); await expect(owner('weld-1').locator('[aria-label="a5"]')).toHaveCount(1);
    await expect(page.locator('.pcad-statusbar')).not.toContainText('作り直しています');
    const before = await workerMethods();
    const bounds = await owner('weld-1').locator('[aria-label="a5"]').boundingBox(); if (bounds === null) throw new Error('溶接寸法なし');
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down();
    for (let index = 0; index < 100; index++) await page.mouse.move(bounds.x + bounds.width / 2 + index % 10, bounds.y + bounds.height / 2 + Math.floor(index / 10));
    expect(await workerMethods()).toEqual(before);
    await page.mouse.up();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator('.pcad-statusbar')).not.toContainText('作り直しています');
    const after = (await workerMethods()).slice(before.length);
    console.log(`[P9 注記移動] 100移動中0通信、確定後: ${JSON.stringify(after)}`);
    expect(after.filter((method) => method !== 'checkShapeAvailability')).toEqual([]);
    expect(after.length).toBeLessThanOrEqual(1);
    await sheet.focus(); await page.keyboard.press('Control+z');
    await tree.getByRole('button', { name: `${drawingMessage('drawing.weld.title')} 1`, exact: true }).click();
    await form.locator('strong').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('welding-eight-kinds.png'), fullPage: true });
    await sheet.focus(); const saving = page.waitForEvent('download'); await page.keyboard.press('Control+s');
    const savedPath = await (await saving).path(); if (savedPath === null) throw new Error('溶接図面なし'); const bytes = await readFile(savedPath);
    for (const format of ['svg', 'pdf', 'png', 'jpg', 'dxf']) {
      await chooseDrawingMenu(page, 'ファイル', '図面を書き出す');
      const output = page.getByRole('form', { name: '図面を書き出す', exact: true });
      await output.getByLabel('ファイルの種類', { exact: true }).selectOption(format);
      const downloading = page.waitForEvent('download'); await output.getByRole('button', { name: '書き出す', exact: true }).click();
      const download = await downloading; await download.saveAs(testInfo.outputPath(`welding.${format}`));
      const path = await download.path(); if (path === null) throw new Error(`${format}なし`);
      const data = await readFile(path); expect(data.byteLength).toBeGreaterThan(100);
      if (format === 'svg') { expect(data.toString('utf8')).toContain('aria-label="a5"'); expect(data.toString('utf8')).toContain('data-owner-id="weld-8"'); }
      else if (format === 'pdf') expect(data.subarray(0, 5).toString()).toBe('%PDF-');
      else if (format === 'png') expect(Array.from(data.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      else if (format === 'jpg') expect(Array.from(data.subarray(0, 3))).toEqual([255, 216, 255]);
      else expect(data.toString('utf8')).toContain('ENTITIES');
    }
    await page.reload(); const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '開く', exact: true }).click();
    await (await chooser).setFiles({ name: '溶接図.pcadd', mimeType: 'application/zip', buffer: bytes });
    await expect(owner('weld-8').locator('path').first()).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
    await tree.getByRole('button', { name: `${drawingMessage('drawing.weld.title')} 1`, exact: true }).click();
    await expect(field('size.throat')).toHaveValue('10/2'); await expect(field('pitch')).toHaveValue('200');
    await form.locator('strong').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('welding-restored.png'), fullPage: true });
    await field('size.throat').focus(); await page.keyboard.press('F1');
    const help = page.getByRole('dialog', { name: 'PointerCAD ヘルプ', exact: true });
    await expect(help.getByRole('article').getByRole('heading', { level: 1 })).toHaveText('溶接記号で施工する側・寸法・方法を伝える');
    const screenshot = help.getByRole('img', { name: '8種類の溶接記号を配置したPointerCADの実画面', exact: true });
    await expect(screenshot).toBeVisible(); await expect.poll(() => screenshot.evaluate((element) => element instanceof HTMLImageElement ? element.naturalWidth : 0)).toBe(1440);
    await page.screenshot({ path: testInfo.outputPath('welding-help.png'), fullPage: true });
    await page.keyboard.press('Escape'); await expect(field('size.throat')).toBeFocused(); expect(errors).toEqual([]);
  });
});
