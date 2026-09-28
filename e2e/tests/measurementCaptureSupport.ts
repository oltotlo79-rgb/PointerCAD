/// <reference lib="dom" />
import { expect, type Locator, type Page } from '@playwright/test';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { commitPopover, popover, popoverInputs, popoverTitle, treeRow } from './solidCaptureSupport.js';
import { waitForRecompute, waitForSettledRecompute } from './recompute.js';

/**
 * 開いていればEscで閉じる(`primitives.spec.ts` の `closePopover` と同じ作り)。
 * `solidCaptureSupport.ts` の `cancelPopover` は必ず開いている前提で、箱のように
 * コミットすると自動で閉じる道具では使えない(2026-09-28 の実測でタイムアウトした)。
 */
export async function closePopoverIfOpen(page: Page): Promise<void> {
  if ((await popover(page).count()) > 0) {
    await popoverInputs(page).first().press('Escape');
  }
  await expect(popover(page)).toHaveCount(0);
}

/**
 * G3-d(測定・点検: select-subshape・measure・mass-properties・print-check)と
 * G7-a(履歴とビュー: timeline・selection・section-view)の撮影の流れで共通に使う補助。
 *
 * `solidCaptureSupport.ts`(w37b の未コミット分、編集禁止)は面・辺の3Dクリックに
 * Shift 修飾を持たないため、2点選ぶ測定(2026-09-28 追加)にはここへ書き写した版を使う。
 * 写した式・視点は `solidCaptureSupport.ts` および `e2e/tests/primitives.spec.ts` の
 * ワールド→画面変換(ホーム視点・1440×900専用)と同じ。
 */

export function menuTool(page: Page, menu: string, label: string): Locator {
  return toolMenuPanel(page, menu).getByRole('button', { name: label, exact: true });
}

export function propertyPanel(page: Page): Locator {
  return page.locator('.pcad-panel--right');
}

export function propertyValue(page: Page, key: string): Locator {
  return propertyPanel(page)
    .locator('dt.pcad-properties__key', { hasText: key })
    .locator('xpath=following-sibling::dd[1]');
}

/** プロパティの節(見出しで引く。`p6-view.spec.ts` と同じ作り)。 */
export function propertySection(page: Page, title: string): Locator {
  return propertyPanel(page)
    .locator('.pcad-section')
    .filter({ has: page.locator('.pcad-section__title', { hasText: new RegExp(`^${title}$`) }) });
}

export function treeSection(page: Page, title: string): Locator {
  return page.locator('.pcad-panel--left').locator('.pcad-tree__sections > li').filter({ hasText: title });
}

/** 立体の行のまるごと(名前のボタン・タイムラインのつまみ・「⋮」を含む枠)。 */
export function solidRowBox(page: Page, name: string): Locator {
  return treeSection(page, 'ソリッド').locator('.pcad-tree__row--child').filter({ hasText: name });
}

/** その行のタイムラインのつまみ(FR-507)。押すとその段までロールバックする。 */
export function timelineStop(page: Page, name: string): Locator {
  return solidRowBox(page, name).locator('.pcad-timeline__stop');
}

/** 「途中まで戻しています」の帯(タイムラインを動かしている間だけ出る)。 */
export function rollbackBanner(page: Page): Locator {
  return page.locator('.pcad-statusbar__rollback');
}

/** ステータスバーの選択フィルタの入切ボタン(頂点・辺・面・立体のいずれか)。 */
export function selectionFilterButton(page: Page, kindLabel: string): Locator {
  return page.locator('.pcad-statusbar').getByRole('button', { name: kindLabel, exact: true });
}

/** ステータスバー全体(下端の帯)。「選ぶもの」の札とフィルタの入切をまとめて撮る。 */
export function statusBar(page: Page): Locator {
  return page.locator('.pcad-statusbar');
}

/** 「見た目」→「測る」を押す。 */
export async function runMeasure(page: Page): Promise<void> {
  await openToolMenu(page, '見た目');
  await menuTool(page, '見た目', '測る').click();
}

// ---------------------------------------------------------------------------
// 3Dクリックの座標変換(ホーム視点・1440×900専用。`solidCaptureSupport.ts` と同じ式に
// Shift 修飾の可否を足したもの)。
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
export async function clickWorldPoint(page: Page, world: WorldPoint, shift = false): Promise<void> {
  await waitForSettledRecompute(page);
  const canvas = page.locator('canvas.pcad-viewport__canvas');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('ビューポートのcanvasの位置と大きさが取れませんでした。');
  const [x, y] = worldToCanvas(world, box.width, box.height);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.click(box.x + x, box.y + y);
  if (shift) await page.keyboard.up('Shift');
}

/** 20×20×20 の既定の箱(`createPartDocument.ts` の DEFAULT_BOX_SIZE_MM)。原点を中心に置かれる。 */
export const BOX_SIZE_MM = 20;
export const BOX_VOLUME_MM3 = BOX_SIZE_MM ** 3;
export const BOX_TOP_LEFT_CORNER: WorldPoint = [-BOX_SIZE_MM / 2, -BOX_SIZE_MM / 2, BOX_SIZE_MM / 2];
export const BOX_TOP_RIGHT_CORNER: WorldPoint = [BOX_SIZE_MM / 2, BOX_SIZE_MM / 2, BOX_SIZE_MM / 2];
export const BOX_TOP_FACE_CENTER: WorldPoint = [0, 0, BOX_SIZE_MM / 2];
export const BOX_FRONT_LEFT_VERTICAL_EDGE_MID: WorldPoint = [-BOX_SIZE_MM / 2, -BOX_SIZE_MM / 2, 0];

/** 「作る」の一覧から基本形状の箱を、既定の 20×20×20 のまま原点へ置いて選ぶ。 */
export async function placeAndSelectBox(page: Page): Promise<void> {
  await openToolMenu(page, '作る');
  await menuTool(page, '作る', '箱').click();
  await expect(popoverTitle(page)).toHaveText('箱を置く');
  await commitPopover(page);
  await closePopoverIfOpen(page);
  await waitForRecompute(page);
  await treeRow(page, '箱1').click();
}
