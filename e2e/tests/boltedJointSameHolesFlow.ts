/// <reference lib="dom" />
import { expect, test as baseTest, type ElectronApplication, type Page } from '@playwright/test';
import { resetAssemblyFileGateway } from './assemblyTestSupport.js';
import { clickHistory, commitButton, holeCounts, pickFourFaces, plateAssembly, wallPoint, type PlateSpec } from './boltedJointMultiFlow.js';
import { boltedJointDialog, componentRows, fastenedBadges, resolvedPoses, SECOND_PLATE_OFFSET, statusText } from './boltedJointTestSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { watch } from './runtimeErrors.js';
import type { WorldPoint } from './solidCaptureSupport.js';

/*
 * ボルト締結の当たり(J-02c)の画面検査。板は部品の画面の実操作で作って保存し、組立へ 2 回置く(boltedJointMultiFlow.ts と同じ。
 * 完成した組立を API で作って注入しない)。
 *
 * 板は 80×30×10 で、φ9 の貫通穴 4 つ((10, 15)・(30, 15)・(50, 15)・(70, 15))が 1 つの穴のフィーチャー。2 つ目の板(y=−50)は締結で
 * −Y 軸まわりに裏返り x が鏡に映る(boltedJointMultiFlow.ts の 1))ので、頭側の (10, 15) と組むのは相手側の板の部品の x=70 の穴(画面の
 * (70, −35))。穴の並びは鏡に対して左右同じなので、残りの穴は 1 つずつ同じ軸の相手を持つ。
 * 期待: 1 組目の 4 面を選ぶと、両方の板の残りの 3 穴ずつに当たりの輪(3D の破線の輪。検査の口 pcadViewportHoleHints で数を読む)が出て、
 * 「同じ穴を全部足す」に足した後の数(頭側 4・相手側 4)が出る。押すと穴の数が 4 と 4・提案が 4 組になり、輪は消える。1 回の確定で
 * ボルト・ナット 4 組(8 部品)が増え、元に戻す 1 回で板 2 枚と元の配置に戻る。
 * 登録は bolted-joint-same-holes.spec.ts(functional と firefox の対象)。
 */

type Vec3 = readonly [number, number, number];
type HoleXY = readonly [number, number];

const HEAD_HOLE: HoleXY = [10, 15];
const MIRROR_HOLE: HoleXY = [70, 15];
const ORIGIN: Vec3 = [0, 0, 0];
const FOUR_HOLE_PLATE: PlateSpec = { width: 80, depth: 30, thickness: 10, holes: [HEAD_HOLE, [30, 15], [50, 15], MIRROR_HOLE], diameter: 9 };
const READY_STATUS = 'ボルトで締結: 提案を確かめ、Enter か「締結する」で締結します。Esc でやめます。';
const SET_READY_STATUS = 'ボルトで締結: 4 組の提案を確かめ、Enter か「締結する」でまとめて締結します。Esc でやめます。';

declare global {
  interface Window {
    pcadViewportHoleHints?: () => number;
  }
}

/** 3D に出ている当たりの輪の数(検査の口が無い時は −1)。 */
async function holeHintCount(page: Page): Promise<number> {
  return page.evaluate(() => window.pcadViewportHoleHints?.() ?? -1);
}

/** 上面の、どの穴からも 12mm 以上離れた点(中央の奥)。 */
function topPoint(offset: Vec3): WorldPoint {
  return [offset[0] + 40, offset[1] + 27, offset[2] + FOUR_HOLE_PLATE.thickness];
}

export function registerBoltedJointSameHolesTests(test: typeof baseTest,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('同じ穴フィーチャーの穴の当たり(J-02c)', () => {
    test.use({ viewport: { width: 1440, height: 900 } });
    test.afterEach(async ({ page }) => { await resetAssemblyFileGateway(page); });

    test('1 組目を選ぶと残りの穴に輪が出て、全部足すで 4 組になり、確定で部品が増え、元に戻す 1 回で戻る', async ({ page }, info) => {
      const seen = watch(page);
      const spec = FOUR_HOLE_PLATE, second: Vec3 = SECOND_PLATE_OFFSET;
      await plateAssembly(page, info, appForPage(page), spec, null);
      const before = await resolvedPoses(page);

      // 1) 1 組目 (10, 15)↔画面の (70, −35) の 4 面。残りの 3 穴ずつ(両方の板で 6)に輪が出て、全部足した後の数を添えた釦が出る。
      await pickFourFaces(page, wallPoint(ORIGIN, HEAD_HOLE, spec.thickness), topPoint(ORIGIN),
        wallPoint(second, MIRROR_HOLE, spec.thickness), topPoint(second));
      await expect(statusText(page)).toHaveText(READY_STATUS);
      await expect(holeCounts(page)).toHaveText('締結する穴: 頭側 1 ・ 相手側 1');
      await expect.poll(() => holeHintCount(page)).toBe(6);
      const addAll = boltedJointDialog(page).getByTestId('bolted-joint-add-same-holes');
      await expect(addAll).toHaveText('同じ穴を全部足す（頭側 4・相手側 4）');

      // 2) 押すと 4 組の提案になり、当たりが無くなるので輪と釦が消える(断りの文は出ない)。
      await addAll.click();
      await expect(holeCounts(page)).toHaveText('締結する穴: 頭側 4 ・ 相手側 4');
      await expect(boltedJointDialog(page).getByTestId('bolted-joint-set-row')).toHaveCount(4);
      await expect(statusText(page)).toHaveText(SET_READY_STATUS);
      await expect.poll(() => holeHintCount(page)).toBe(0);
      await expect(addAll).toHaveCount(0);
      await expect(boltedJointDialog(page).getByTestId('bolted-joint-same-holes-issue')).toHaveCount(0);
      await expect(commitButton(page)).toBeEnabled();

      // 3) 1 回の確定でボルト・ナット 4 組(8 部品)が増え、10 部品を互いに固定する。元に戻す 1 回で板 2 枚と元の配置に戻る。
      const token = await beginRecompute(page);
      await commitButton(page).click();
      await expect(boltedJointDialog(page)).toHaveCount(0);
      await waitForRecompute(page, token);
      await expect(componentRows(page)).toHaveCount(10);
      await expect(fastenedBadges(page)).toHaveCount(10);
      await clickHistory(page, '元に戻す');
      await expect(componentRows(page)).toHaveCount(2);
      await expect(fastenedBadges(page)).toHaveCount(0);
      expect(await resolvedPoses(page)).toEqual(before);

      expect(seen.dialogs).toEqual([]);
      expect(seen.errors).toEqual([]);
    });
  });
}
