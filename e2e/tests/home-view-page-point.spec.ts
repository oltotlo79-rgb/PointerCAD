import { expect, test, type Page } from '@playwright/test';
import { homeViewPagePoint } from './boltedJointTestSupport.js';
import type { WorldPoint } from './homeViewProjection.js';

/*
 * P17: boltedJointTestSupport.ts の homeViewPagePoint は、共通の homeViewProjection.ts の worldToCanvas に
 * canvas の幅と高さを渡し、ページ上の canvas の位置(box.x, box.y)だけを足す。期待値は委譲する前の手書きの射影
 * (boltedJointTestSupport.ts の SHA-256 a5436b7942889d2148860cc6f5507f4e7efbcfa5dd02a11be52c92c1bcdfbb58)で
 * 計算した値で、近似ではなく Object.is で同じ値であることを確かめる。画面は合成の canvas だけで、アプリは開かない。
 */
type CanvasBox = readonly [x: number, y: number, width: number, height: number];
const CASES: readonly { readonly world: WorldPoint; readonly box: CanvasBox; readonly expected: readonly [number, number] }[] = [
  { world: [0, 0, 0], box: [25, 35, 1000, 600], expected: [525, 335] },
  { world: [20, 15, 10], box: [25, 35, 1000, 600], expected: [608.2140309937695, 314.40986720231143] },
  { world: [-21, 30, 0], box: [0, 0, 1280, 720], expected: [661.4130792475785, 289.94386661598] },
];

async function showCanvas(page: Page, box: CanvasBox, hidden: boolean): Promise<void> {
  const [x, y, width, height] = box;
  await page.setContent('<style>html,body{margin:0;padding:0}</style><canvas class="pcad-viewport__canvas" style="position:fixed;'
    + `left:${String(x)}px;top:${String(y)}px;width:${String(width)}px;height:${String(height)}px;`
    + (hidden ? 'display:none;' : '') + '"></canvas>');
}

for (const { world, box, expected } of CASES) {
  test(`ホーム視点の (${world.join(', ')}) を canvas ${box.join(', ')} のページ上の位置へ写す`, async ({ page }) => {
    await showCanvas(page, box, false);
    expect(await page.locator('canvas.pcad-viewport__canvas').boundingBox())
      .toEqual({ x: box[0], y: box[1], width: box[2], height: box[3] });
    const actual = await homeViewPagePoint(page, world);
    expect(actual).toEqual(expected);
    expect(actual.map((value, index) => Object.is(value, expected[index]))).toEqual([true, true]);
  });
}

test('canvas の位置と大きさが取れない時は、射影せずに落とす', async ({ page }) => {
  await showCanvas(page, [0, 0, 1280, 720], true);
  await expect(homeViewPagePoint(page, [0, 0, 0])).rejects.toThrow('ビューポートのcanvasの位置と大きさが取れませんでした。');
});
