import { readFile, writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readPcadFile } from '../../packages/io/src/index.js';
import { chooseToolMenuItem, openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { diskFile, openTarget, saveTarget } from './electronAppFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { clickWorldPoint, commitPopover, popoverInputs, popoverTitle, selectionKindLabel } from './solidCaptureSupport.js';
import { surfaceFixture, twoSheetsFixture } from './surfaceFixture.js';
import { readViewportRenderStats } from './viewportRenderStats.js';
import { captureManualDetail } from './captureManualDetail.js';
import { field, fillUnique } from './machiningSurfaceFlow.js';

const SMOOTH = '断面の間をなめらかにする';
const GUIDE = '輪郭と案内線 / 半分にする案内線';
const NONE = 'なし（一定の断面）';
const right = (page: Page): Locator => page.locator('.pcad-panel--right');
const tree = (page: Page, name: string): Locator => page.locator('.pcad-panel--left').getByRole('button', { name, exact: true });
async function volume(page: Page): Promise<number> {
  const entry = right(page).locator('dt.pcad-properties__key').filter({ hasText: /^体積$/u }).locator('xpath=following-sibling::dd[1]');
  return Number(((await entry.getAttribute('title')) ?? (await entry.textContent()))?.replaceAll(',', '').match(/[\d.]+/u)?.[0] ?? NaN);
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

/** 体積が期待の値に、表示の丸めの内(相対 1e-3)で合うまで待つ。 */
async function expectVolume(page: Page, expected: number): Promise<void> {
  await expect.poll(async () => Math.abs(await volume(page) / expected - 1)).toBeLessThan(1e-3);
}

/**
 * M-07: スイープのねじれ・終わりの大きさ・肉厚。案内線の例と同じ半径 5 の円の断面・高さ 100 の経路で作る。
 * 欄の名前は numericInput.json の field.sweepTwist・field.sweepEndScale・field.wallThickness、
 * 「曲がりに合わせて回す」が止まる事は numericInput.ts の numericToggleEnabled、数秒の案内は SweepOptionsHints.tsx の role="note"。
 * 右の欄で既定の値(1)へ戻すと欄が消える事は sweepShapePropertyUpdates.ts の setSweepShapeField。
 */
export async function sweepShapeFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  const popover = page.locator('.pcad-popover');
  // 開く前の待ちは、同じファイルの thickenSurfaceFlow と同じ(開くの釦と、再計算の数の口がそろってから開く)。
  await expect(page.getByRole('button', { name: '開く', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof window.pcadRecomputeStats)).toBe('function');
  await open(page, info, 'sweep-shape-input.pcad', surfaceFixture('sweep'), app);
  await tree(page, '円の断面').click(); await tree(page, '高さ100の経路').click({ modifiers: ['Shift'] });
  await chooseToolMenuItem(page, '作る', 'スイープ');
  const frenet = popover.getByRole('switch', { name: '曲がりに合わせて回す', exact: true });
  await expect(frenet).toBeEnabled();
  await expect(field(page, popover, 'ねじれ')).toHaveValue('0');
  await expect(field(page, popover, '壁の厚さ')).toHaveValue('0');
  await fillUnique(field(page, popover, '終わりの大きさ'), '1', '0.5');
  await expect(frenet).toBeDisabled();
  await expect(popover.getByRole('note').filter({ hasText: '数秒かかることがあります' })).toBeVisible();
  await change(page, () => popover.getByRole('button', { name: '決定', exact: true }).click());
  // 半径 5 から 2.5 へ一様に細くなる円錐台。
  await expectVolume(page, Math.PI * 100 * (25 + 12.5 + 6.25) / 3);
  // 右の欄で、終わりの大きさを既定(1)へ戻し、壁の厚さ 1 の管にする。
  await change(page, () => fillUnique(field(page, right(page), '終わりの大きさ'), '0.5', '1'));
  await change(page, () => fillUnique(field(page, right(page), '壁の厚さ'), '0', '1'));
  await expectVolume(page, Math.PI * (25 - 16) * 100);
  const saved = readPcadFile(await save(page, info, 'sweep-shape-saved.pcad', app));
  expect(saved.ok).toBe(true); if (!saved.ok) throw new Error(saved.error.message);
  expect(saved.document.schemaVersion).toBe(24);
  const sweep = saved.document.solids.find((feature) => feature.kind === 'sweep');
  expect(sweep).toMatchObject({ kind: 'sweep', wallThickness: { source: '1' } });
  expect(sweep).not.toHaveProperty('endScale');
  expect(sweep).not.toHaveProperty('twistDegrees');
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
  await captureManualDetail(page, info, { name: 'loft-spline-input', dialog: popover, fixture: { source: 'loft' }, script: new URL(import.meta.url) });
  await change(page, () => popover.getByRole('button', { name: '決定', exact: true }).click());
  await expect.poll(() => volume(page)).toBeGreaterThan(0); const ordinary = await volume(page);
  await change(page, () => right(page).getByRole('switch', { name: SMOOTH, exact: true }).click());
  await expect.poll(async () => Math.abs(await volume(page) - ordinary)).toBeGreaterThan(1);
  const smoothed = await volume(page);
  await frameForCapture(page);
  await captureManualDetail(page, info, { name: 'loft-spline-smooth', dialog: right(page), fixture: { source: 'loft', smooth: true }, script: new URL(import.meta.url) });
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
  await captureManualDetail(page, info, { name: 'sweep-guide-input', dialog: popover, fixture: { source: 'sweep' }, script: new URL(import.meta.url) });
  await change(page, () => popover.getByRole('button', { name: '決定', exact: true }).click());
  const expected = Math.PI * 100 * (25 + 12.5 + 6.25) / 3;
  await expect.poll(() => volume(page)).toBeCloseTo(expected, 3);
  await frameForCapture(page);
  await captureManualDetail(page, info, { name: 'sweep-guide-result', dialog: right(page), fixture: { source: 'sweep', guide: true }, script: new URL(import.meta.url) });
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

/** 加工の一覧の道具を押す(選んだ物で押せる事を先に確かめる)。 */
async function machiningTool(page: Page, name: string): Promise<void> {
  await openToolMenu(page, '加工');
  const button = toolMenuPanel(page, '加工').getByRole('button', { name, exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(popoverTitle(page)).toHaveText(name);
}

/**
 * J-05a 厚み付け: 面だけのボディ(曲面1。30×20 の平らな面)を木で選び、加工の「厚み付け」で厚さ 1(法線側のまま)を付けると、
 * 体積 30×20×1 = 600 の立体になる(計算部で、法線側・反対側・両側とも 600 と測った)。保存して開き直しても同じ記録と体積。
 */
export async function thickenSurfaceFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('button', { name: '開く', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof window.pcadRecomputeStats)).toBe('function');
  await open(page, info, 'thicken-input.pcad', twoSheetsFixture());
  await tree(page, '曲面1').click();
  await machiningTool(page, '厚み付け');
  await expect(popoverInputs(page)).toHaveCount(1);
  await popoverInputs(page).nth(0).fill('1');
  await change(page, () => commitPopover(page));
  await expect(page.locator('.pcad-popover')).toHaveCount(0);
  await tree(page, '厚み付け1').click();
  await expect.poll(() => volume(page)).toBeCloseTo(600, 3);
  const bytes = await save(page, info, 'thicken-saved.pcad'), saved = readPcadFile(bytes);
  expect(saved.ok).toBe(true); if (!saved.ok) throw new Error(saved.error.message);
  expect(saved.document.solids.find(solid => solid.kind === 'thicken')).toMatchObject({
    name: '厚み付け1', targetFeatureId: 'sheet-0', thickness: { source: '1', value: 1 }, side: 'normal',
  });
  await open(page, info, 'thicken-reopened.pcad', bytes);
  await tree(page, '厚み付け1').click();
  await expect.poll(() => volume(page)).toBeCloseTo(600, 3);
}

const FLIP_B = '辺 B の向きを反転';

/**
 * J-05b 滑らかなつなぎ: 2 枚の面の上の辺を、選ぶものを辺にして A(曲面1、中点 (15, 0, 20))、B(曲面2、中点 (15, 30, 20))の順に
 * 3D で選び、重み 2+1 と 2*3・辺 B の向きの反転を入にして作る。性質欄で反転を切っても計算し直せ、保存して開き直しても同じ記録。
 * 2 本の辺は計算部で測り、反転が入でも切でもつなぎ面を作れる事を確かめた。視点はホーム視点のまま動かさない(clickWorldPoint の前提)。
 */
export async function blendSurfaceFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('button', { name: '開く', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof window.pcadRecomputeStats)).toBe('function');
  await open(page, info, 'blend-input.pcad', twoSheetsFixture());
  await tree(page, '曲面1').click();
  await page.keyboard.press('2');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 辺');
  await clickWorldPoint(page, [15, 0, 20]);
  await page.keyboard.down('Shift');
  await clickWorldPoint(page, [15, 30, 20]);
  await page.keyboard.up('Shift');
  await machiningTool(page, '滑らかなつなぎ');
  await expect(popoverInputs(page)).toHaveCount(2);
  await popoverInputs(page).nth(0).fill('2+1');
  await popoverInputs(page).nth(1).fill('2*3');
  const flip = page.locator('.pcad-popover').getByRole('switch', { name: FLIP_B, exact: true });
  await expect(flip).toHaveAttribute('aria-checked', 'false');
  await flip.click();
  await expect(flip).toHaveAttribute('aria-checked', 'true');
  await change(page, () => commitPopover(page));
  await expect(page.locator('.pcad-popover')).toHaveCount(0);
  await tree(page, '曲面3').click();
  await expect(right(page).getByRole('switch', { name: FLIP_B, exact: true })).toHaveAttribute('aria-checked', 'true');
  await change(page, () => right(page).getByRole('switch', { name: FLIP_B, exact: true }).click());
  await expect(right(page).getByRole('switch', { name: FLIP_B, exact: true })).toHaveAttribute('aria-checked', 'false');

  const bytes = await save(page, info, 'blend-saved.pcad'), saved = readPcadFile(bytes);
  expect(saved.ok).toBe(true); if (!saved.ok) throw new Error(saved.error.message);
  expect(saved.document.solids.find(solid => solid.id !== 'sheet-0' && solid.id !== 'sheet-1')).toMatchObject({
    kind: 'surface', name: '曲面3',
    operation: { kind: 'blend', a: { bodyFeatureId: 'sheet-0' }, b: { bodyFeatureId: 'sheet-1' },
      weightA: { source: '2+1', value: 3 }, weightB: { source: '2*3', value: 6 }, flipB: false },
  });
  await open(page, info, 'blend-reopened.pcad', bytes);
  await tree(page, '曲面3').click();
  await expect(right(page).getByRole('switch', { name: FLIP_B, exact: true })).toHaveAttribute('aria-checked', 'false');
}
