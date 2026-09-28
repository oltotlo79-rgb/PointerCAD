/// <reference lib="dom" />
import { expect, type Locator, type Page } from '@playwright/test';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { waitForSettledRecompute } from './recompute.js';

/**
 * 立体・スケッチ系の撮影の流れ（G2・G3系の各章）で共通に使う補助。
 *
 * 面・辺の選択とその場入力欄(ポップアップ)の操作は `e2e/tests/solid.spec.ts`(P3 加工
 * フィーチャーの検査)と同じ作りをここへ1か所にまとめたもの。`solid.spec.ts` 自身は変更
 * しない(ここは撮影専用の流れが使う複製で、solid.spec.tsのP1・P2由来の「共有ファイルを
 * 作らずファイルごとに書き写す」方針とは別に、2026-09-24 に統括の指示で撮影の流れどうし
 * では複製せず共有する方針へ切り替えた。後続の撮影組(G3-b・G3-c・G3-d、G2各組)も同じ
 * 板作り・3D選択が要るため、直しを1か所にまとめるのが目的)。
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
/** モデルブラウザ(左パネル)の要素の行。名前のボタンを押すとその要素を選ぶ。 */
export function treeRow(page: Page, name: string): Locator {
  return page.locator('.pcad-panel--left').getByRole('button', { name, exact: true });
}
/** 右のプロパティパネル。 */
export function propertyPanel(page: Page): Locator {
  return page.locator('.pcad-panel--right');
}
/** ステータスバーの「選ぶもの」の札(先頭)。`solid.spec.ts` の同名補助と同じ。 */
export function selectionKindLabel(page: Page): Locator {
  return page.locator('.pcad-statusbar__state').first();
}

/** ポップアップの欄を埋める。nullを渡した欄は既定値のままにする。 */
export async function fillFields(page: Page, sources: readonly (string | null)[]): Promise<void> {
  await expect(popover(page)).toBeVisible();
  const inputs = popoverInputs(page);
  for (const [index, source] of sources.entries()) {
    if (source !== null) await inputs.nth(index).fill(source);
  }
}
/** Enterで決定する。焦点は必ずポップアップの欄に置いてから押す。 */
export async function commitPopover(page: Page): Promise<void> {
  await popoverInputs(page).first().press('Enter');
}
/** Escで取消して閉じる。点の道具など、決定後も連続作図で開いたままの道具を閉じるのにも使う。 */
export async function cancelPopover(page: Page): Promise<void> {
  await popoverInputs(page).first().press('Escape');
  await expect(popover(page)).toHaveCount(0);
}

/** 閉じた長方形を線分4本でかく(`e2e/tests/solid.spec.ts` の同名補助と同じ手順)。 */
export async function drawRectangle(
  page: Page,
  origin: readonly [string, string],
  size: readonly [string, string],
): Promise<void> {
  await sketchTool(page, '線分').click();
  await expect(popoverTitle(page)).toHaveText('線分の始点');
  await fillFields(page, [origin[0], origin[1], '0']);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('線分の終点');
  await fillFields(page, [size[0], null, null]);
  await commitPopover(page);
  await fillFields(page, [null, size[1], null]);
  await commitPopover(page);
  await fillFields(page, [`-${size[0]}`, null, null]);
  await commitPopover(page);
  await fillFields(page, [null, `-${size[1]}`, null]);
  await commitPopover(page);
  await cancelPopover(page);
}
/** 線分を順に選んでから面の道具でEnterを押し、面を張る。 */
export async function makeFace(page: Page, lineNames: readonly string[]): Promise<void> {
  await treeRow(page, lineNames[0]).click();
  for (const name of lineNames.slice(1)) await treeRow(page, name).click({ modifiers: ['Shift'] });
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
// 3Dクリックの座標変換(ホーム視点・1440×900専用。`solid.spec.ts` のP3検査と同じ式)
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
/**
 * ビューポートの上で、ワールド座標の点が見えている場所を押す。既定(ホーム)視点・1440×900専用。
 *
 * 押し出し等の直後は再計算が終わるまで面・辺の位置が定まらないため、クリックの前に
 * `waitForSettledRecompute` で落ち着くのを待つ(w99a: 待たずに3Dで選ぶ台本が同じ所で
 * 落ちていた)。各台本が個別に置く `waitForRecompute` はここでは消さない。
 */
export async function clickWorldPoint(page: Page, world: WorldPoint): Promise<void> {
  await waitForSettledRecompute(page);
  const canvas = page.locator('canvas.pcad-viewport__canvas');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('ビューポートのcanvasの位置と大きさが取れませんでした。');
  const [x, y] = worldToCanvas(world, box.width, box.height);
  await page.mouse.click(box.x + x, box.y + y);
}
/** 40×30の板(厚みthicknessMm)の上面の中央。`drawRectangle(['0','0'],['40','30'])`と対。 */
export function topFaceCenter(thicknessMm: number): WorldPoint {
  return [20, 15, thicknessMm];
}
