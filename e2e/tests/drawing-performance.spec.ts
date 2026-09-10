/// <reference lib="dom" />
import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { createBox } from './drawingManufacturingFixture.js';
import { drawingPerformanceFixture } from './drawingPerformanceFixture.js';
import { KERNEL_TIMEOUT_MS } from './recompute.js';

declare global {
  interface Window {
    __drawingPerformance: { openedAt: number; fontAt: number; drawingAt: number; active: boolean; moveAt: number | null;
      renderingMs: number[]; coordinatesMs: number[]; fragmentMs: number[] };
  }
}

test('P8 100フィーチャー・三面図・50寸法を5秒以内で開き、字体1秒・寸法ドラッグ16msを満たす', async ({ page }, testInfo) => {
  const fixture = await drawingPerformanceFixture();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    const trace: Window['__drawingPerformance'] = { openedAt: 0, fontAt: 0, drawingAt: 0, active: false, moveAt: null,
      renderingMs: [], coordinatesMs: [], fragmentMs: [] };
    window.__drawingPerformance = trace;
    const screenMatrix = SVGGraphicsElement.prototype.getScreenCTM;
    SVGGraphicsElement.prototype.getScreenCTM = function () {
      const start = performance.now(), result = screenMatrix.call(this);
      if (trace.active) trace.coordinatesMs.push(performance.now() - start);
      return result;
    };
    const fragment = Range.prototype.createContextualFragment;
    Range.prototype.createContextualFragment = function (text) {
      const start = performance.now(), result = fragment.call(this, text);
      if (trace.active) trace.fragmentMs.push(performance.now() - start);
      return result;
    };
    document.addEventListener('change', (event) => {
      if (event.target instanceof HTMLInputElement && event.target.type === 'file' && event.target.files?.[0]?.name.endsWith('.pcadd')) trace.openedAt = performance.now();
    }, { capture: true });
    document.addEventListener('pointermove', (event) => {
      if (trace.active && event.buttons === 1 && event.target instanceof Element && event.target.closest('.pcad-drawing-sheet') !== null) trace.moveAt = performance.now();
    }, { capture: true });
    document.addEventListener('DOMContentLoaded', () => {
      const observe = new MutationObserver((mutations) => {
        const svg = document.querySelector('.pcad-drawing-svg');
        if (trace.openedAt === 0 || svg === null) return;
        if (trace.fontAt === 0 && svg.querySelector('[aria-label="図名"] path') !== null) {
          trace.fontAt = -1; requestAnimationFrame(() => requestAnimationFrame(() => { trace.fontAt = performance.now(); }));
        }
        if (trace.drawingAt === 0 && ['view-1', 'view-2', 'view-3'].every((id) => svg.querySelector(`[data-owner-id="${id}"] path`) !== null)
          && svg.querySelectorAll('[data-owner-id^="perf-dim-"] [aria-label="20"]').length === 50) {
          trace.drawingAt = -1; requestAnimationFrame(() => requestAnimationFrame(() => { trace.drawingAt = performance.now(); }));
        }
        if (trace.moveAt !== null && mutations.some((item) => item.target === svg || svg.contains(item.target))) {
          trace.renderingMs.push(performance.now() - trace.moveAt); trace.moveAt = null;
        }
      });
      observe.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    }, { once: true });
  });
  // WASM準備は別の起動条件。箱を実UIで作って準備を終え、図面を開く操作から測る。
  await createBox(page); page.on('dialog', (dialog) => { void dialog.accept(); });
  const opening = page.waitForEvent('filechooser'); await page.keyboard.press('Control+o');
  await (await opening).setFiles({ name: '100フィーチャー.pcadd', mimeType: 'application/zip', buffer: Buffer.from(fixture) });
  await expect.poll(() => page.evaluate(() => window.__drawingPerformance.drawingAt), { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(0);
  const loading = await page.evaluate(() => {
    const trace = window.__drawingPerformance;
    const font = performance.getEntriesByType('resource').filter((entry) => entry instanceof PerformanceResourceTiming && entry.initiatorType === 'fetch'
      && entry.name.includes('NotoSansJP-Regular.otf'))[0];
    if (font === undefined || trace.fontAt <= 0) throw new Error('字体の初回描画時刻なし');
    return { openingMs: trace.drawingAt - trace.openedAt, fontMs: trace.fontAt - font.startTime, bytes: 0 };
  });
  loading.bytes = fixture.byteLength;
  console.log(`[実測] 100フィーチャー/三面図/50寸法: ${JSON.stringify(loading)}`);
  expect(loading.openingMs).toBeLessThanOrEqual(5000); expect(loading.fontMs).toBeLessThanOrEqual(1000);
  await expect(page.locator('.pcad-statusbar')).not.toContainText('作り直しています');
  const dimension = page.locator('.pcad-drawing-svg [data-owner-id="perf-dim-0"] [aria-label="20"]');
  const bounds = await dimension.boundingBox(); if (bounds === null) throw new Error('ドラッグする寸法の文字なし');
  const before = await dimension.getAttribute('transform'), x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const stableProjection = await page.locator('.pcad-drawing-svg [data-owner-id="view-1"] path').first().elementHandle();
  if (stableProjection === null) throw new Error('保持する投影線なし');
  await page.evaluate(() => { window.__drawingPerformance.active = true; });
  for (let i = 1; i <= 40; i++) {
    await page.mouse.move(x + i / 2, y + i / 2);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
  await expect(dimension).not.toHaveAttribute('transform', before ?? '');
  expect(await stableProjection.evaluate((node) => node.isConnected)).toBe(true);
  const renderingMs = await page.evaluate(() => { window.__drawingPerformance.active = false; return window.__drawingPerformance.renderingMs; });
  await page.mouse.up();
  const stages = await page.evaluate(() => ({ coordinatesMs: window.__drawingPerformance.coordinatesMs, fragmentMs: window.__drawingPerformance.fragmentMs }));
  const measurements = { ...loading, frames: renderingMs.length, maxRenderingMs: Math.max(...renderingMs), renderingMs, ...stages };
  await writeFile(testInfo.outputPath('drawing-performance.json'), JSON.stringify(measurements, null, 2));
  await page.screenshot({ path: testInfo.outputPath('drawing-100-features.png'), fullPage: true });
  console.log(`[実測] 図面ドラッグ: ${measurements.frames}回、最大${measurements.maxRenderingMs.toFixed(3)}ms`);
  expect(renderingMs.length).toBeGreaterThanOrEqual(35); expect(measurements.maxRenderingMs).toBeLessThanOrEqual(16);
  await page.keyboard.press('Control+z'); await expect(dimension).toHaveAttribute('transform', before ?? '');
  // Escでの中止はプレビューを残さず、保存文書・履歴にも移動を残さない。
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 12, y + 12);
  await expect(dimension).not.toHaveAttribute('transform', before ?? '');
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(dimension).toHaveAttribute('transform', before ?? '');
  const second = page.locator('.pcad-drawing-svg [data-owner-id="perf-dim-1"] [aria-label="20"]');
  const third = page.locator('.pcad-drawing-svg [data-owner-id="perf-dim-2"] [aria-label="20"]');
  const secondBefore = await second.getAttribute('transform'), thirdBefore = await third.getAttribute('transform');
  // Escは選択も解除するので、複数選択の起点を通常クリックで選び直す。
  await page.mouse.click(x, y);
  const secondBounds = await second.boundingBox(); if (secondBounds === null) throw new Error('追加選択する寸法の文字なし');
  // 輪郭文字の字間はSVGの背景へ当たるため、実矩形の座標を使って通常のポインターを送る。
  await page.keyboard.down('Shift');
  await page.mouse.click(secondBounds.x + secondBounds.width / 2, secondBounds.y + secondBounds.height / 2);
  await page.keyboard.up('Shift');
  await expect(page.locator('.pcad-drawing-tree-dimension[aria-pressed="true"]')).toHaveCount(2);
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 10, y + 10);
  await expect(dimension).not.toHaveAttribute('transform', before ?? '');
  await expect(second).not.toHaveAttribute('transform', secondBefore ?? '');
  await expect(third).toHaveAttribute('transform', thirdBefore ?? '');
  await page.mouse.up(); await page.keyboard.press('Control+z');
  await expect(dimension).toHaveAttribute('transform', before ?? '');
  await expect(second).toHaveAttribute('transform', secondBefore ?? '');
  // 図は輪郭線で移動し、関連する50寸法も同じ画面差分で追従する。
  await expect(page.locator('.pcad-statusbar')).not.toContainText('作り直しています');
  await page.getByRole('button', { name: '平面図', exact: true }).click();
  const viewEdge = page.locator('.pcad-drawing-svg [data-view-id="view-2"] path').last();
  const edgePoint = await viewEdge.evaluate((node) => {
    if (!(node instanceof SVGPathElement)) throw new Error('図の実輪郭なし');
    const at = node.getPointAtLength(node.getTotalLength() / 2), matrix = node.getScreenCTM();
    if (matrix === null) throw new Error('図の紙面座標なし');
    const screen = new DOMPoint(at.x, at.y).matrixTransform(matrix); return { x: screen.x, y: screen.y };
  });
  const dimensionBeforeView = await dimension.boundingBox();
  if (dimensionBeforeView === null) throw new Error('図と一緒に動く寸法なし');
  await page.mouse.move(edgePoint.x, edgePoint.y); await page.mouse.down();
  const otherView = await page.locator('.pcad-drawing-svg [data-view-id="view-3"] path').first().elementHandle();
  if (otherView === null) throw new Error('保持する別の図なし');
  await page.evaluate(() => { const trace = window.__drawingPerformance; trace.renderingMs = []; trace.moveAt = null; trace.active = true; });
  for (let i = 1; i <= 40; i++) {
    await page.mouse.move(edgePoint.x + i / 2, edgePoint.y + i / 2);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
  const viewRenderingMs = await page.evaluate(() => { window.__drawingPerformance.active = false; return window.__drawingPerformance.renderingMs; });
  const movedDimension = await dimension.boundingBox(); if (movedDimension === null) throw new Error('移動中の寸法なし');
  expect(movedDimension.x - dimensionBeforeView.x).toBeCloseTo(20, 1);
  expect(movedDimension.y - dimensionBeforeView.y).toBeCloseTo(20, 1);
  expect(await otherView.evaluate((node) => node.isConnected)).toBe(true);
  await page.mouse.up();
  await expect(page.locator('.pcad-statusbar')).not.toContainText('作り直しています');
  await expect.poll(async () => (await dimension.boundingBox())?.x).toBeCloseTo(dimensionBeforeView.x + 20, 1);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await dimension.boundingBox())?.x).toBeCloseTo(dimensionBeforeView.x, 1);
  await expect.poll(async () => (await dimension.boundingBox())?.y).toBeCloseTo(dimensionBeforeView.y, 1);
  const viewMeasurements = { frames: viewRenderingMs.length, maxRenderingMs: Math.max(...viewRenderingMs), renderingMs: viewRenderingMs };
  await writeFile(testInfo.outputPath('drawing-view-drag-performance.json'), JSON.stringify(viewMeasurements, null, 2));
  console.log(`[実測] 図と50寸法のドラッグ: ${viewMeasurements.frames}回、最大${viewMeasurements.maxRenderingMs.toFixed(3)}ms`);
  expect(viewMeasurements.frames).toBeGreaterThanOrEqual(35); expect(viewMeasurements.maxRenderingMs).toBeLessThanOrEqual(16);
});
