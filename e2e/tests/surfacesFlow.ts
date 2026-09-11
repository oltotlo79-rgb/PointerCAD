import { readFile, writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readPcadFile } from '../../packages/io/src/index.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { diskFile, openTarget, saveTarget } from './electronAppFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { surfaceFixture } from './surfaceFixture.js';
import { readViewportRenderStats } from './viewportRenderStats.js';

const SMOOTH = '断面の間をなめらかにする';
const GUIDE = '輪郭と案内線 / 半分にする案内線';
const NONE = 'なし（一定の断面）';
const right = (page: Page): Locator => page.locator('.pcad-panel--right');
const tree = (page: Page, name: string): Locator => page.locator('.pcad-panel--left').getByRole('button', { name, exact: true });
async function volume(page: Page): Promise<number> {
  const entry = right(page).locator('dt.pcad-properties__key').filter({ hasText: /^体積$/u }).locator('xpath=following-sibling::dd[1]');
  return Number((await entry.textContent())?.replaceAll(',', '').match(/[\d.]+/u)?.[0] ?? NaN);
}
async function frameForCapture(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'ホーム視点', exact: true }).click();
  const canvas = page.locator('canvas.pcad-viewport__canvas'), box = await canvas.boundingBox();
  if (box === null) throw new Error('ビューポートが見つからない');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await readViewportRenderStats(page);
  await page.mouse.wheel(0, 400);
  await expect.poll(async () => (await readViewportRenderStats(page)).completedRenders).toBeGreaterThan(before.completedRenders);
}
async function open(page: Page, info: TestInfo, name: string, bytes: Uint8Array, app?: ElectronApplication): Promise<void> {
  const path = info.outputPath(name); await writeFile(path, bytes);
  if (app !== undefined) await openTarget(app, path);
  const opening = app === undefined ? page.waitForEvent('filechooser') : undefined;
  const token = await beginRecompute(page);
  await page.getByRole('button', { name: '開く', exact: true }).click();
  if (opening !== undefined) await (await opening).setFiles(path);
  await waitForRecompute(page, token);
}
async function save(page: Page, info: TestInfo, name: string, app?: ElectronApplication): Promise<Uint8Array> {
  const path = info.outputPath(name);
  if (app !== undefined) await saveTarget(app, path);
  const download = app === undefined ? page.waitForEvent('download') : undefined;
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+Shift+s');
  if (download !== undefined) { await (await download).saveAs(path); return readFile(path); }
  return diskFile(path);
}
async function help(page: Page, title: string, text: string, info: TestInfo, imageName: string): Promise<void> {
  await page.keyboard.press('F1');
  const dialog = page.getByRole('dialog', { name: 'PointerCAD ヘルプ', exact: true });
  const article = dialog.getByRole('article', { name: 'ヘルプ本文', exact: true });
  await expect(article.getByRole('heading', { level: 1 })).toHaveText(title);
  await expect(article).toContainText(text);
  expect(await article.locator('img').count()).toBeGreaterThanOrEqual(2);
  for (const image of await article.locator('img').all()) {
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true);
  }
  await article.evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath(imageName) });
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
}
async function change(page: Page, action: () => Promise<unknown>): Promise<void> {
  const token = await beginRecompute(page); await action(); await waitForRecompute(page, token);
}
async function guideChoice(page: Page, from: string, to: string): Promise<void> {
  await right(page).getByRole('button', { name: from, exact: true }).click();
  await change(page, () => right(page).getByRole('menuitem', { name: to, exact: true }).click());
}

export async function surfacesFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('button', { name: '開く', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof window.pcadRecomputeStats)).toBe('function');
  await open(page, info, 'loft-input.pcad', surfaceFixture('loft'), app);
  await frameForCapture(page);
  await tree(page, '輪郭0').click();
  for (const z of [20, 60, 100]) await tree(page, `輪郭${z}`).click({ modifiers: ['Shift'] });
  await chooseToolMenuItem(page, '作る', 'ロフト');
  const popover = page.locator('.pcad-popover');
  await expect(popover.getByRole('switch', { name: SMOOTH, exact: true })).toHaveAttribute('aria-checked', 'false');
  await page.screenshot({ path: info.outputPath('loft-spline-input.png') });
  await change(page, () => popover.getByRole('button', { name: '決定', exact: true }).click());
  await expect.poll(() => volume(page)).toBeGreaterThan(0); const ordinary = await volume(page);
  await change(page, () => right(page).getByRole('switch', { name: SMOOTH, exact: true }).click());
  await expect.poll(async () => Math.abs(await volume(page) - ordinary)).toBeGreaterThan(1);
  const smoothed = await volume(page);
  await frameForCapture(page);
  await page.screenshot({ path: info.outputPath('loft-spline-smooth.png') });
  const loftBytes = await save(page, info, 'loft-saved.pcad', app), loft = readPcadFile(loftBytes);
  expect(loft.ok).toBe(true); if (!loft.ok) throw new Error(loft.error.message);
  expect(loft.document.solids[0]).toMatchObject({ kind: 'loft', smooth: true, sections: Array.from({ length: 4 }, () => ({ kind: 'sketchCurves' })) });
  await open(page, info, 'loft-reopened.pcad', loftBytes, app); await tree(page, 'ロフト1').click();
  await expect(right(page).getByRole('switch', { name: SMOOTH, exact: true })).toHaveAttribute('aria-checked', 'true');
  expect(await volume(page)).toBe(smoothed);
  await change(page, () => right(page).getByRole('switch', { name: SMOOTH, exact: true }).click());
  expect(await volume(page)).toBe(ordinary);
  await page.locator('canvas.pcad-viewport__canvas').focus();
  await change(page, () => page.keyboard.press('Control+z'));
  await tree(page, 'ロフト1').click(); expect(await volume(page)).toBe(smoothed);
  await right(page).getByRole('switch', { name: SMOOTH, exact: true }).focus();
  await help(page, '面と面をつなぐ・ロフト', SMOOTH, info, 'loft-help.png');
  await save(page, info, 'loft-final.pcad', app);

  await open(page, info, 'sweep-input.pcad', surfaceFixture('sweep'), app);
  await frameForCapture(page);
  await tree(page, '円の断面').click(); await tree(page, '高さ100の経路').click({ modifiers: ['Shift'] });
  await chooseToolMenuItem(page, '作る', 'スイープ');
  const frenet = popover.getByRole('switch', { name: '曲がりに合わせて回す', exact: true });
  await expect(frenet).toHaveAttribute('aria-checked', 'false');
  await frenet.click();
  await expect(frenet).toHaveAttribute('aria-checked', 'true');
  await popover.getByRole('button', { name: NONE, exact: true }).click();
  await popover.getByRole('menuitem', { name: GUIDE, exact: true }).click();
  await expect(popover.getByRole('switch', { name: '曲がりに合わせて回す', exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('sweep-guide-input.png') });
  await change(page, () => popover.getByRole('button', { name: '決定', exact: true }).click());
  const expected = Math.PI * 100 * (25 + 12.5 + 6.25) / 3;
  await expect.poll(() => volume(page)).toBeCloseTo(expected, 3);
  await frameForCapture(page);
  await page.screenshot({ path: info.outputPath('sweep-guide-result.png') });
  await guideChoice(page, GUIDE, NONE); await expect.poll(() => volume(page)).toBeCloseTo(Math.PI * 25 * 100, 3);
  await expect(right(page).getByRole('switch', { name: '曲がりに合わせて回す', exact: true })).toHaveAttribute('aria-checked', 'true');
  await guideChoice(page, NONE, GUIDE); await expect.poll(() => volume(page)).toBeCloseTo(expected, 3);
  const bytes = await save(page, info, 'sweep-saved.pcad', app), swept = readPcadFile(bytes);
  expect(swept.ok).toBe(true); if (!swept.ok) throw new Error(swept.error.message);
  expect(swept.document.solids[0]).toMatchObject({ kind: 'sweep', guide: { curveIds: ['guide'] }, path: { curveIds: ['path'] } });
  await open(page, info, 'sweep-reopened.pcad', bytes, app); await tree(page, 'スイープ1').click();
  await expect.poll(() => volume(page)).toBeCloseTo(expected, 3);
  await guideChoice(page, GUIDE, NONE); await expect.poll(() => volume(page)).toBeCloseTo(Math.PI * 25 * 100, 3);
  await guideChoice(page, NONE, GUIDE);
  await right(page).getByRole('button', { name: GUIDE, exact: true }).focus();
  await help(page, '立体の形を変える・並べる', '案内線（省略できます）', info, 'sweep-guide-help.png');
}
