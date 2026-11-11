import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { canvasCaptureFlow } from './canvasCaptureFlow.js';
import { canvasAssetLifetimeFlow, prepareCanvasCold, verifyCanvasCold, type CanvasColdReceipt } from './canvasAssetLifetimeFlow.js';
import { canvasStateFlow } from './canvasStateFlow.js';
import { canvasPerspectiveFlow } from './canvasPerspectiveFlow.js';

test('下絵の状態・濃さ途中入力・再試行を狭い画面とキーボードで操作し、保存再開する', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await canvasStateFlow(page, info);
  expect(errors).toEqual([]);
});

test('下絵の削除と追加を Undo/Redo し、保存再開と同じ画像番号の部品切替でも画像を保つ', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await canvasAssetLifetimeFlow(page, info);
  expect(errors).toEqual([]);
});

test('P12 下絵を敷く章の画面を撮る', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await canvasCaptureFlow(page, info);
  expect(errors).toEqual([]);
});

test('下絵の四隅補正を3独立格子の内部9点で実表示し、元画像と保存再開・解除Undoを保つ', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await canvasPerspectiveFlow(page, info);
  expect(errors).toEqual([]);
});

/** Manual processes inherit the registered project's renderer/graphics/context and action limits. */
async function withColdContext<T>(browser: Browser, info: TestInfo, phase: string, run: (page: Page) => Promise<T>): Promise<T> {
  const use = info.project.use;
  const context = await browser.newContext({ baseURL: use.baseURL, viewport: use.viewport, userAgent: use.userAgent,
    deviceScaleFactor: use.deviceScaleFactor, isMobile: use.isMobile, hasTouch: use.hasTouch,
    locale: use.locale, colorScheme: use.colorScheme, acceptDownloads: use.acceptDownloads });
  const errors: string[] = [];
  let page: Page | undefined;
  try {
    context.setDefaultTimeout(use.actionTimeout ?? 0); context.setDefaultNavigationTimeout(use.navigationTimeout ?? 0);
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    // The test runner owns tracing for every context, including these manually launched browsers.
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    });
    await page.goto('/'); const result = await run(page); expect(errors).toEqual([]); return result;
  } catch (error) {
    await info.attach('cold-pageerrors-' + phase, { body: JSON.stringify(errors), contentType: 'application/json' });
    if (page !== undefined && !page.isClosed()) await page.screenshot({ path: info.outputPath('cold-' + phase + '-failure.png') });
    throw error;
  } finally {
    // Closing lets Playwright collect the trace chunk before releasing the context.
    await context.close();
  }
}

// Separate cases keep old-process Undo and each cold state independent within the unchanged timeout.
for (const state of ['deleted', 'visible', 'off'] as const) test(`V103 R20 下絵 ${state} を保存し実browser終了・新processでPNG/ZIP/文書を保つ`, async ({ playwright, browserName }, info) => {
  const use = info.project.use;
  const launch = () => playwright[browserName].launch({ ...use.launchOptions,
    ...(use.headless === undefined ? {} : { headless: use.headless }), ...(use.channel === undefined ? {} : { channel: use.channel }) });
  const first = await launch();
  let receipt: CanvasColdReceipt;
  try { receipt = await withColdContext(first, info, state + '-old', page => prepareCanvasCold(page, info, state)); }
  finally { await first.close(); }
  expect(first.isConnected()).toBe(false);
  const fresh = await launch();
  try { await withColdContext(fresh, info, state + '-fresh', page => verifyCanvasCold(page, info, receipt)); }
  finally { await fresh.close(); }
});
