/// <reference lib="dom" />
import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';

type ClientBounds = Readonly<{ x: number; y: number; width: number; height: number }>;

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

async function drawingFromBox(page: Page): Promise<void> {
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

test.describe('P8 図面の実操作', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
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
    await page.getByRole('button', { name: '自動寸法', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="20"]')).toHaveCount(6);
    // 手動の公差文字を動かさずに、追加する自動寸法を実字体の囲みから避ける。
    // 全7文字を同じ再描画の状態から読み、途中のDOM交換による混在も防ぐ。
    await expect.poll(() => page.locator('.pcad-drawing-svg').evaluate((element) => {
      const manual = element.querySelector('[aria-label="20±0.1"]')?.getBoundingClientRect();
      const automatic = Array.from(element.querySelectorAll('[aria-label="20"]'), (item) => item.getBoundingClientRect());
      if (manual === undefined || manual.width <= 0 || manual.height <= 0 || automatic.length !== 6
        || automatic.some((item) => item.width <= 0 || item.height <= 0)) return null;
      return automatic.map((bounds) => bounds.x < manual.x + manual.width && manual.x < bounds.x + bounds.width
        && bounds.y < manual.y + manual.height && manual.y < bounds.y + bounds.height);
    }), { message: '手動1件と自動6件の実文字が重ならない' }).toEqual([false, false, false, false, false, false]);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'SVGで書き出す', exact: true }).click();
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
    await page.locator('summary').filter({ hasText: /^寸法・注記$/ }).click();
    await page.getByRole('group', { name: '寸法・注記', exact: true }).getByRole('button', { name: '注記', exact: true }).click();
    const form = page.getByRole('form', { name: '注記', exact: true });
    await expect(form).toBeVisible();
    await form.getByRole('button', { name: '決定', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="Ra 3.2"]')).toHaveCount(1);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="Ra 3.2"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'やり直す', exact: true }).click();
    await expect(page.locator('.pcad-drawing-svg [aria-label="Ra 3.2"]')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('drawing-surface-finish.png'), fullPage: true });
  });
});
