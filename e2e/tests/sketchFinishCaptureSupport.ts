/// <reference lib="dom" />
import { expect, type Locator, type Page } from '@playwright/test';
import { waitForSettledRecompute } from './recompute.js';

/**
 * 「線の角を丸める・面取りする」(sketch-fillet.md)・「立体から線を取り込む」
 * (project-intersect.md)の撮影で共通に使う補助。`e2e/tests/sketch-extended.spec.ts`・
 * `e2e/tests/workplane-3d.spec.ts`(P4 の通し検査)にある同名の補助関数と同じ作りを
 * ここへ1か所にまとめたもの(2026-09-24 の統括の指示「撮影の流れどうしでは複製せず
 * 共有する」に合わせる)。それらの検査ファイル自身は変更しない。
 */

export function sketchTool(page: Page, label: string): Locator {
  return page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: label, exact: true });
}
export function popover(page: Page): Locator {
  return page.locator('.pcad-popover');
}
export function popoverTitle(page: Page): Locator {
  return page.locator('.pcad-popover__title');
}
export function popoverInputs(page: Page): Locator {
  return page.locator('.pcad-popover input.pcad-field__input');
}
export function featureTree(page: Page): Locator {
  return page.locator('.pcad-panel--left');
}
export function propertyPanel(page: Page): Locator {
  return page.locator('.pcad-panel--right');
}
export function treeRow(page: Page, name: string): Locator {
  return featureTree(page).getByRole('button', { name, exact: true });
}
export function statusText(page: Page): Locator {
  return page.locator('.pcad-statusbar__text');
}
export function planeBadge(page: Page): Locator {
  return page.locator('.pcad-statusbar__state', { hasText: '作図面' });
}
export function propertyValue(page: Page, key: string): Locator {
  return propertyPanel(page).locator('dt.pcad-properties__key', { hasText: key }).locator('xpath=following-sibling::dd[1]');
}

/** ポップアップの欄を埋める。null を渡した欄は既定値のままにする。 */
export async function fillFields(page: Page, sources: readonly (string | null)[]): Promise<void> {
  await expect(popover(page)).toBeVisible();
  const inputs = popoverInputs(page);
  for (const [index, source] of sources.entries()) {
    if (source !== null) await inputs.nth(index).fill(source);
  }
}
/** Enter で決定する。欄を持たない段は「決定」を押す。 */
export async function commitPopover(page: Page): Promise<void> {
  await expect(popover(page)).toBeVisible();
  if ((await popoverInputs(page).count()) > 0) {
    await popoverInputs(page).first().press('Enter');
    return;
  }
  await popover(page).getByRole('button', { name: '決定', exact: true }).click();
}
/** Esc で取消して閉じる。開いていなければ何もしない。 */
export async function cancelPopover(page: Page): Promise<void> {
  if ((await popover(page).count()) === 0) return;
  if ((await popoverInputs(page).count()) > 0) {
    await popoverInputs(page).first().press('Escape');
  } else {
    await page.locator('canvas.pcad-viewport__canvas').press('Escape');
  }
  await expect(popover(page)).toHaveCount(0);
}
/** 2 段目以降の座標の欄を「絶対」にする(既定は相対)。 */
export async function useAbsolute(page: Page): Promise<void> {
  await popover(page).getByRole('button', { name: '絶対', exact: true }).first().click();
}
/** 平置きの道具(線分・点等)を選ぶ。 */
export async function chooseSketchTool(page: Page, label: string): Promise<void> {
  await cancelPopover(page);
  await sketchTool(page, '選択').click();
  await sketchTool(page, label).click();
}
/** 「作図 ▾」の畳んだ一覧から道具を選ぶ。 */
export async function chooseShapeTool(page: Page, label: string): Promise<void> {
  await cancelPopover(page);
  await sketchTool(page, '選択').click();
  await page.getByRole('group', { name: 'スケッチ' }).locator('.pcad-menu__trigger').first().click();
  await page.locator('.pcad-menu__panel[aria-label="作図"]').getByRole('button', { name: label, exact: true }).click();
}
/** 「編集 ▾」の畳んだ一覧から道具を選ぶ(「フィレット」「面取り」「投影」「断面」)。 */
export async function chooseEditTool(page: Page, label: string): Promise<void> {
  await page.getByRole('group', { name: 'スケッチ' }).locator('.pcad-menu__trigger').nth(1).click();
  await page.locator('.pcad-menu__panel[aria-label="編集"]').getByRole('button', { name: label, exact: true }).click();
}
/** 作図面の畳んだ一覧から項目を選ぶ。 */
export async function choosePlaneMenuItem(page: Page, label: string): Promise<void> {
  await page.getByRole('group', { name: '作図面' }).locator('.pcad-menu__trigger').first().click();
  await page.locator('.pcad-menu__panel[aria-label="作図面"]').getByRole('button', { name: label, exact: true }).click();
}

// ---------------------------------------------------------------------------
// 立体づくり(project-intersect.md の撮影で使う)。`solidCaptureSupport.ts` の
// 同名の関数と同じ作り。
// ---------------------------------------------------------------------------

function toolMenuTrigger(page: Page, menu: string): Locator {
  return page.locator('.pcad-toolbar').getByRole('button', { name: new RegExp(`^${menu}`) }).first();
}
function toolMenuPanel(page: Page, menu: string): Locator {
  return page.locator('.pcad-toolbar').getByRole('group', { name: menu, exact: true });
}
export async function openToolMenu(page: Page, menu: string): Promise<void> {
  if ((await toolMenuPanel(page, menu).count()) === 0) await toolMenuTrigger(page, menu).click();
  await expect(toolMenuPanel(page, menu)).toBeVisible();
}
/** 矩形を1つかく(対角の2点を世界座標(X,Y)で入れる。Zは0)。 */
export async function drawRectangle(page: Page, corner1: readonly [string, string], corner2: readonly [string, string]): Promise<void> {
  await chooseShapeTool(page, '矩形');
  await expect(popoverTitle(page)).toHaveText('矩形の 1 つ目の角');
  await fillFields(page, [corner1[0], corner1[1]]);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('矩形の 2 つ目の角');
  await fillFields(page, [corner2[0], corner2[1]]);
  await commitPopover(page);
  await cancelPopover(page);
}
/** 要素を順に選んでから面の道具で Enter を押し、面を張る。 */
export async function makeFace(page: Page, elementNames: readonly string[]): Promise<void> {
  await treeRow(page, elementNames[0]).click();
  for (const name of elementNames.slice(1)) await treeRow(page, name).click({ modifiers: ['Shift'] });
  await sketchTool(page, '面').click();
  await page.locator('canvas.pcad-viewport__canvas').press('Enter');
}
/** 面を1枚選んで押し出す。 */
export async function extrudeFace(page: Page, faceName: string, distance: string): Promise<void> {
  await treeRow(page, faceName).click();
  await openToolMenu(page, '作る');
  await toolMenuPanel(page, '作る').getByRole('button', { name: '押し出し', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('押し出す');
  await fillFields(page, [distance]);
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
}

// ---------------------------------------------------------------------------
// 3Dクリックの座標変換(ホーム視点・1440×900専用。`solidCaptureSupport.ts` と同じ式)
// ---------------------------------------------------------------------------

export type WorldPoint = readonly [number, number, number];

const HOME_AZIMUTH = -Math.PI / 4;
const HOME_ELEVATION = Math.atan(Math.SQRT1_2);
const HOME_DISTANCE = 200;
const VERTICAL_FIELD_OF_VIEW = (50 * Math.PI) / 180;

function subtractPoints(a: WorldPoint, b: WorldPoint): WorldPoint {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dotPoints(a: WorldPoint, b: WorldPoint): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function crossPoints(a: WorldPoint, b: WorldPoint): WorldPoint {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalizePoint(a: WorldPoint): WorldPoint {
  const length = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / length, a[1] / length, a[2] / length];
}
const CAMERA_EYE: WorldPoint = [
  HOME_DISTANCE * Math.cos(HOME_ELEVATION) * Math.cos(HOME_AZIMUTH),
  HOME_DISTANCE * Math.cos(HOME_ELEVATION) * Math.sin(HOME_AZIMUTH),
  HOME_DISTANCE * Math.sin(HOME_ELEVATION),
];
const CAMERA_Z = normalizePoint(CAMERA_EYE);
const CAMERA_X = normalizePoint(crossPoints([0, 0, 1], CAMERA_Z));
const CAMERA_Y = crossPoints(CAMERA_Z, CAMERA_X);

function worldToCanvas(world: WorldPoint, widthPixels: number, heightPixels: number): readonly [number, number] {
  const view = subtractPoints(world, CAMERA_EYE);
  const depth = -dotPoints(view, CAMERA_Z);
  const scale = 1 / Math.tan(VERTICAL_FIELD_OF_VIEW / 2);
  const ndcX = (scale * dotPoints(view, CAMERA_X)) / (depth * (widthPixels / heightPixels));
  const ndcY = (scale * dotPoints(view, CAMERA_Y)) / depth;
  return [((ndcX + 1) / 2) * widthPixels, ((1 - ndcY) / 2) * heightPixels];
}
/** ビューポートの上で、ワールド座標の点が見えている場所を押す。既定(ホーム)視点・1440×900専用。 */
export async function clickWorldPoint(page: Page, world: WorldPoint): Promise<void> {
  await waitForSettledRecompute(page);
  const canvas = page.locator('canvas.pcad-viewport__canvas');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('ビューポートのcanvasの位置と大きさが取れませんでした。');
  const [x, y] = worldToCanvas(world, box.width, box.height);
  await page.mouse.click(box.x + x, box.y + y);
}
