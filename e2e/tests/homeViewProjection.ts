import { normalizePoint } from './normalizePoint.testSupport.js';
import type { Page } from '@playwright/test';

/*
 * ホーム視点のままワールド座標を canvas の画素へ写して押す補助(P17)。
 * 7 つの spec に、コードが同じ写しで書いていた物を 1 か所へ寄せた。数式と定数は元の写しと同じ。
 * 同じ計算を measurementCaptureSupport.ts でも共有し、その他の写しは各ファイルに残す。
 */

export type WorldPoint = readonly [number, number, number];

/*
 * ホーム視点の見え方。数値は `packages/ui/src/viewport/cameraMath.ts` の `HOME_ORBIT` と
 * `VERTICAL_FIELD_OF_VIEW` そのままで、写し方は `createViewportScene.ts` の `worldToScreen`
 * (three.js の PerspectiveCamera + lookAt)と同じ。**これを使う検査では視点を一度も動かさない。**
 */
// 既定(ホーム)の視点の方位角は −45°(利用者の指示 2026-09-06)。カメラは (+X, −Y, +Z) にあり、前・上・右の 3 面が見える。
const HOME_AZIMUTH = -Math.PI / 4;
const HOME_ELEVATION = Math.atan(Math.SQRT1_2);
export const HOME_DISTANCE = 200;
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


/** カメラの位置(`cameraPosition(HOME_ORBIT)`)。注視点は原点。 */
const CAMERA_EYE: WorldPoint = [
  HOME_DISTANCE * Math.cos(HOME_ELEVATION) * Math.cos(HOME_AZIMUTH),
  HOME_DISTANCE * Math.cos(HOME_ELEVATION) * Math.sin(HOME_AZIMUTH),
  HOME_DISTANCE * Math.sin(HOME_ELEVATION),
];
const CAMERA_Z = normalizePoint(CAMERA_EYE);
const CAMERA_X = normalizePoint(crossPoints([0, 0, 1], CAMERA_Z));
const CAMERA_Y = crossPoints(CAMERA_Z, CAMERA_X);

/** ワールド座標を canvas の左上を原点とした画素へ写す(視点を動かさない検査専用)。 */
export function worldToCanvas(
  world: WorldPoint,
  widthPixels: number,
  heightPixels: number,
): readonly [number, number] {
  const view = subtractPoints(world, CAMERA_EYE);
  const depth = -dotPoints(view, CAMERA_Z);
  const scale = 1 / Math.tan(VERTICAL_FIELD_OF_VIEW / 2);
  const ndcX = (scale * dotPoints(view, CAMERA_X)) / (depth * (widthPixels / heightPixels));
  const ndcY = (scale * dotPoints(view, CAMERA_Y)) / depth;
  return [((ndcX + 1) / 2) * widthPixels, ((1 - ndcY) / 2) * heightPixels];
}

/** ビューポートの上で、ワールド座標の点が見えている場所を押す(FR-106)。 */
export async function clickWorldPoint(page: Page, world: WorldPoint): Promise<void> {
  const canvas = page.locator('canvas.pcad-viewport__canvas');
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error('ビューポートの canvas の位置と大きさが取れませんでした。');
  }
  const [x, y] = worldToCanvas(world, box.width, box.height);
  await page.mouse.click(box.x + x, box.y + y);
}
