/// <reference lib="dom" />
import { readFile } from 'node:fs/promises';

import { expect, test, type Page } from '@playwright/test';

import { readPcadFile } from '../../packages/io/src/index.js';
import { VIEW_CUBE_CAMERA_DISTANCE, VIEW_CUBE_FIELD_OF_VIEW } from '../../packages/ui/src/viewcube/viewCubeCamera.js';
import { installStartupDiagnostics, waitForStartupHealth } from './startupHealth.js';

test.use({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1.5 });

async function settleView(page: Page, previousRenders: number): Promise<void> {
  await expect.poll(() => page.evaluate(previous => {
    const stats = window.pcadViewportRenderStats?.();
    return stats !== undefined && stats.completedRenders > previous && performance.now() - stats.lastCompletedAtMs > 350;
  }, previousRenders), { timeout: 10_000, message: '視点の遷移が描画を完了して止まる' }).toBe(true);
}

async function renders(page: Page): Promise<number> {
  return page.evaluate(() => window.pcadViewportRenderStats?.().completedRenders ?? 0);
}

/** Independently project a known point on the original cube from the documented home view. */
async function homePoint(page: Page, point: readonly [number, number, number]): Promise<{ x: number; y: number }> {
  const bounds = await page.locator('canvas.pcad-viewcube').boundingBox();
  if (bounds === null) throw new Error('View cube is missing');
  const [x, y, z] = point;
  const depth = VIEW_CUBE_CAMERA_DISTANCE - (x - y + z) / Math.sqrt(3);
  const extent = depth * Math.tan(VIEW_CUBE_FIELD_OF_VIEW * Math.PI / 360);
  const horizontal = (x + y) * Math.SQRT1_2 / extent;
  const vertical = (-x + y + 2 * z) / Math.sqrt(6) / extent;
  return { x: bounds.x + (horizontal + 1) * bounds.width / 2, y: bounds.y + (1 - vertical) * bounds.height / 2 };
}

async function rememberView(page: Page, name: string): Promise<void> {
  const menu = page.locator('.pcad-named-views');
  await menu.locator('summary').click();
  await menu.getByRole('textbox', { name: '視点の名前', exact: true }).fill(name);
  await menu.getByRole('button', { name: '今の視点を保存', exact: true }).click();
  await expect(menu.getByRole('option', { name, exact: true })).toHaveCount(1);
  await menu.locator('summary').click();
}

test.beforeEach(async ({ page }) => {
  await installStartupDiagnostics(page);
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
});

test('ビューキューブの面・辺・角、ドラッグ、家とHomeキーで実際の視点が変わる', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await waitForStartupHealth(page, info);
  await rememberView(page, 'cube-home-initial');
  const expectedViews = [
    { name: 'cube-front', point: [0, -1, 0], direction: [0, -1, 0] },
    { name: 'cube-edge', point: [0, -0.94, 0.94], direction: [0, -Math.SQRT1_2, Math.SQRT1_2] },
    { name: 'cube-corner', point: [0.94, -0.94, 0.94], direction: [1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)] },
  ] as const;
  const cube = page.locator('canvas.pcad-viewcube');
  for (const { name, point } of expectedViews) {
    const beforeHome = await renders(page);
    await page.locator('.pcad-viewcube-home').click();
    await settleView(page, beforeHome);
    const target = await homePoint(page, point);
    await page.mouse.move(target.x, target.y);
    await cube.screenshot({ path: info.outputPath(`${name}-hover.png`), scale: 'device' });
    const before = await renders(page);
    await page.mouse.down();
    await expect(cube).toHaveAttribute('data-interaction', 'pressed');
    await cube.screenshot({ path: info.outputPath(`${name}-pressed.png`), scale: 'device' });
    await page.mouse.up();
    await expect(cube).not.toHaveAttribute('data-interaction', 'pressed');
    await expect(cube).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await settleView(page, before);
    await rememberView(page, name);
  }

  const center = await homePoint(page, [0.94, -0.94, 0.94]);
  await page.mouse.move(center.x, center.y);
  const beforeDrag = await renders(page);
  await page.mouse.down();
  await page.mouse.move(center.x + 30, center.y + 12, { steps: 3 });
  await expect(cube).toHaveAttribute('data-interaction', 'dragging');
  await page.mouse.up();
  await settleView(page, beforeDrag);
  await rememberView(page, 'cube-drag');
  const beforeKey = await renders(page);
  await page.locator('canvas.pcad-viewport__canvas').focus();
  await page.keyboard.press('Home');
  await settleView(page, beforeKey);
  await rememberView(page, 'cube-home-key');
  // Native keyboard activation of the new home button uses the same controller.
  await page.locator('.pcad-viewcube-home').focus();
  const beforeButton = await renders(page);
  await page.keyboard.press('Enter');
  await settleView(page, beforeButton);
  await rememberView(page, 'cube-home-button');

  const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
  const savedPath = await download.path();
  if (savedPath === null) throw new Error('Saved camera document missing');
  const saved = readPcadFile(new Uint8Array(await readFile(savedPath)));
  if (!saved.ok) throw new Error(saved.error.message);
  for (const { name, direction } of expectedViews) {
    const view = saved.document.namedViews.find(candidate => candidate.name === name);
    if (view === undefined) throw new Error(`Missing saved view: ${name}`);
    expect(view.target).toEqual([0, 0, 0]);
    expect(Math.hypot(...view.position)).toBeCloseTo(200, 7);
    for (let axis = 0; axis < 3; axis += 1) expect(view.position[axis] / 200).toBeCloseTo(direction[axis], 7);
  }
  const initial = saved.document.namedViews.find(view => view.name === 'cube-home-initial');
  expect(initial).toBeDefined();
  for (const name of ['cube-home-key', 'cube-home-button']) {
    const view = saved.document.namedViews.find(candidate => candidate.name === name);
    expect(view?.position).toEqual(initial?.position);
    expect(view?.target).toEqual(initial?.target);
  }
  expect(saved.document.namedViews.find(view => view.name === 'cube-drag')?.position).not.toEqual(initial?.position);
  expect(errors).toEqual([]);
});

test('ビューキューブの5テーマ・倍率150%・画素密度150%を比較撮影する', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await waitForStartupHealth(page, info);
  // The labels use the app font stack. Startup must not download the 4.5 MB drawing font
  // (p8-drawing counts every read of it to prove the drawing retries stop).
  expect(await page.evaluate(async () => {
    await document.fonts.ready;
    const cubeFaces: string[] = [];
    document.fonts.forEach(font => { if (font.family.includes('ViewCube')) cubeFaces.push(font.family); });
    const drawingFontReads = performance.getEntriesByType('resource').filter(entry => entry.name.includes('NotoSansJP-Regular.otf')).length;
    return { cubeFaces, drawingFontReads, status: document.fonts.status };
  })).toEqual({ cubeFaces: [], drawingFontReads: 0, status: 'loaded' });
  expect(await page.evaluate(() => devicePixelRatio)).toBe(1.5);
  const cube = page.locator('canvas.pcad-viewcube');
  for (const [theme, label] of [['dark', 'ダーク'], ['light', 'ライト'], ['darkModern', 'ダークモダン'], ['lightModern', 'ライトモダン'], ['modern', 'モダン']]) {
    await page.getByRole('button', { name: '設定', exact: true }).click();
    await page.getByRole('radio', { name: label, exact: true }).click();
    await page.getByRole('group', { name: '拡大率', exact: true }).getByRole('button', { name: '150%', exact: true }).click();
    await page.getByRole('button', { name: '設定', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect.poll(() => cube.evaluate((canvas: HTMLCanvasElement) => ({ css: [canvas.clientWidth, canvas.clientHeight], pixels: [canvas.width, canvas.height] }))).toEqual({ css: [216, 216], pixels: [324, 324] });
    await expect.poll(async () => {
      const bounds = await page.locator('.pcad-viewcube-control').boundingBox();
      if (bounds === null) return null;
      return {
        size: [bounds.width, bounds.height],
        aligned: [bounds.x, bounds.y, bounds.x * 1.5, bounds.y * 1.5].every(value => Math.abs(value - Math.round(value)) < 1e-6),
      };
    }).toEqual({ size: [216, 216], aligned: true });
    await page.mouse.move(10, 500);
    const screenshot = await page.locator('.pcad-viewcube-control').screenshot({ path: info.outputPath(`viewcube-${theme}-150.png`), scale: 'device' });
    expect([screenshot.readUInt32BE(16), screenshot.readUInt32BE(20)]).toEqual([324, 324]);
    await info.attach(`viewcube-${theme}-150`, { body: screenshot, contentType: 'image/png' });
    const edge = await homePoint(page, [0, -0.94, 0.94]);
    await page.mouse.move(edge.x, edge.y);
    await page.locator('.pcad-viewcube-control').screenshot({ path: info.outputPath(`viewcube-${theme}-edge-hover-150.png`), scale: 'device' });
  }
  expect(errors).toEqual([]);
});
