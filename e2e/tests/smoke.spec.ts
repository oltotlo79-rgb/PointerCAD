/// <reference lib="dom" />
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { readPcadFile } from '../../packages/io/src/index.js';
import { installStartupDiagnostics, waitForStartupHealth } from './startupHealth.js';

test.beforeEach(async({page})=>{await installStartupDiagnostics(page);});

test('Web 版が起動し、空のスケッチの案内が出る', async ({ page }, info) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(error.message);
  });

  await page.goto('/');

  await waitForStartupHealth(page,info);

  await expect(page).toHaveTitle('PointerCAD');

  // 画面が隔離状態で動いている(FR-1003)。
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);

  const viewport = page.locator('canvas.pcad-viewport__canvas');
  await expect(viewport).toBeVisible();

  const size = await viewport.boundingBox();
  expect(size?.width ?? 0).toBeGreaterThan(100);
  expect(size?.height ?? 0).toBeGreaterThan(100);

  // 起動直後はまだ何もかいていないので、最初の一歩の案内が出る(NFR-UX-6、§0.a-0.2)。
  // 幾何カーネル(Worker + OCCT)を通る経路は、面を張るタスク23 の sketch.spec.ts が受け持つ。
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

  // ビューキューブも常時表示されている(FR-103)。
  await expect(page.locator('canvas.pcad-viewcube')).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test('3D表示の初期化に失敗しても作図と保存が残り、再試行で同じ文書を表示する', async ({ page }, info) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'showSaveFilePicker', { configurable: true, value: undefined });
    sessionStorage.setItem('pcad-test-block-webgl', '1');
    HTMLCanvasElement.prototype.getContext = new Proxy(HTMLCanvasElement.prototype.getContext, {
      apply(target, receiver, args) {
        if (String(args[0]).startsWith('webgl') && sessionStorage.getItem('pcad-test-block-webgl') === '1') return null;
        return Reflect.apply(target, receiver, args);
      },
    });
  });
  await page.goto('/');
  const retry = page.getByRole('button', { name: '3D 表示を再試行', exact: true });
  await expect(retry).toBeVisible();
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeVisible();
  const input = page.locator('#pcad-command-line-input');
  for (const value of ['PO', '12,34']) {
    await input.fill(value); await input.press('Enter');
  }
  await page.keyboard.press('Escape');
  const point = page.locator('.pcad-panel--left').getByRole('button', { name: '点1', exact: true });
  await expect(point).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.getByRole('button', { name: '保存', exact: true }).click(),
  ]);
  expect(await download.failure()).toBeNull();
  const savedPath = info.outputPath('retained-after-webgl-failure.pcad');
  await download.saveAs(savedPath);
  const saved = await readPcadFile(new Uint8Array(await readFile(savedPath)));
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error('描画失敗後の保存ファイルが不正です');
  expect(saved.document.sketches.flatMap(sketch => sketch.features).map(feature => feature.name)).toEqual(['点1']);
  await page.evaluate(() => { sessionStorage.removeItem('pcad-test-block-webgl'); });
  await retry.click();
  await waitForStartupHealth(page, info);
  await expect(point).toBeVisible();
  await expect(retry).toHaveCount(0);
});

test('OS標準書体と同梱日本語書体でツールバーの全操作が1280pxから一段に収まる', async ({ page }, info) => {
  await page.goto('/');
  await waitForStartupHealth(page, info);
  for (const font of ['system', 'bundled']) {
    if (font === 'bundled') await page.evaluate(async () => {
      const style = document.createElement('style');
      style.textContent = '@font-face { font-family: "PointerCAD Layout Test"; src: url(/fonts/NotoSansJP-Regular.otf); }';
      document.head.append(style);
      await document.fonts.load('13px "PointerCAD Layout Test"');
      document.documentElement.style.setProperty('--pcad-font', '"PointerCAD Layout Test", sans-serif');
    });
    for (const width of [1440, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const metrics = await page.locator('.pcad-toolbar').evaluate((bar) => ({
        height: bar.getBoundingClientRect().height,
        overflow: bar.scrollWidth - bar.clientWidth,
        children: Array.from(bar.children).map((child) => ({
          name: child.getAttribute('aria-label') ?? child.className,
          width: child.getBoundingClientRect().width,
          height: child.getBoundingClientRect().height,
        })),
      }));
      console.log(`[書体別ツールバー] ${font}/${width}: ${JSON.stringify(metrics)}`);
      await page.screenshot({ path: info.outputPath(`toolbar-${font}-${width}.png`) });
      expect(metrics.height).toBeLessThanOrEqual(70);
      expect(metrics.overflow).toBeLessThanOrEqual(1);
    }
  }
});
