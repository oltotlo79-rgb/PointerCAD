/// <reference lib="dom" />
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { chooseToolMenuItem, openToolMenu, readAssemblyStats, toolMenuPanel, type AssemblyBrowserStats } from './assemblyTestSupport.js';
import { beginRecompute, waitForRecompute, waitForSettledRecompute } from './recompute.js';
import {
  cancelPopover, commitPopover, drawRectangle, extrudeFace, fillFields, makeFace, popover, popoverInputs, popoverTitle,
  selectionKindLabel, sketchTool, topFaceCenter, treeRow, type WorldPoint,
} from './solidCaptureSupport.js';
import { readViewportRenderStats } from './viewportRenderStats.js';
import { saveFlowFile } from './saveResponsivenessFlow.js';

/**
 * ボルト締結(追加要件6)の画面検査の補助。穴付きの板は部品の画面の実操作(長方形→面→押し出し→点→穴)で作り、
 * 製品の「保存」で落としたバイト列を組立の「部品を置く」へ渡す。完成した組立をAPIで作って注入しない。
 *
 * 板は 40×30×10。穴は上面の (20, 15) に φ9 の貫通穴(M8 の通し穴。NBK の表の 2 級 9.0)。
 */
export const PLATE = { width: 40, depth: 30, thickness: 10, holeX: 20, holeY: 15, holeDiameter: 9 } as const;

/** 2 つ目の板を置く位置(1 つ目は原点で、置いた時に自動で固定される)。 */
export const SECOND_PLATE_OFFSET = [0, -50, 0] as const;

export function statusText(page: Page): Locator {
  return page.locator('.pcad-statusbar__text');
}

export function statusBar(page: Page): Locator {
  return page.locator('footer.pcad-statusbar');
}

export function fileAction(page: Page, name: string): Locator {
  return page.getByRole('group', { name: 'ファイル' }).getByRole('button', { name, exact: true });
}

export function boltedJointDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: 'ボルトで締結' });
}

function treeSectionRows(page: Page, sectionName: string): Locator {
  const section = page.locator('.pcad-tree__sections > li').filter({
    has: page.locator('.pcad-tree__section .pcad-tree__label', { hasText: sectionName }),
  });
  return section.locator(':scope > .pcad-tree__children > li > .pcad-tree__row');
}

/** 木の「部品」の行の選択ボタン(`assembly.spec.ts` の同名補助と同じ探し方)。 */
export function componentRows(page: Page): Locator {
  return treeSectionRows(page, '部品').locator('.pcad-tree__select');
}

/** 木の「締結」の印。組の全部品(板 2 枚・ボルト・ナット)に付く。 */
export function fastenedBadges(page: Page): Locator {
  return treeSectionRows(page, '部品').locator('.pcad-tree__badge').filter({ hasText: /^締結$/u });
}

export async function selectComponent(page: Page, index: number): Promise<void> {
  const row = componentRows(page).nth(index);
  await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
}

export async function disableFilePickers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: undefined });
    }
  });
}

/**
 * 部品の画面で穴付きの板を作り、製品の「保存」(ファイル選択の口を消してあるのでダウンロード)で落とした
 * .pcad のバイト列を返す。手順は `holeCaptureFlow.ts`・`solid.spec.ts` の「穴」と同じで、直径と貫通だけ替える。
 */
export async function createHoledPlatePartFile(page: Page, info: TestInfo, app?: ElectronApplication): Promise<Uint8Array> {
  await drawRectangle(page, ['0', '0'], [String(PLATE.width), String(PLATE.depth)]);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await extrudeFace(page, '面1', String(PLATE.thickness));
  await waitForSettledRecompute(page);

  await sketchTool(page, '点').click();
  await expect(popoverTitle(page)).toHaveText('点を作る');
  await fillFields(page, [String(PLATE.holeX), String(PLATE.holeY), '0']);
  await commitPopover(page);
  await cancelPopover(page);
  await expect(treeRow(page, '点1')).toBeVisible();

  await openToolMenu(page, '加工');
  const holeButton = toolMenuPanel(page, '加工').getByRole('button', { name: '穴', exact: true });
  await holeButton.click({ force: true });
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  // 上面の中央(=穴の中心になる点の真上)を押してから点を足す。穴はまだ無いので上面に当たる。
  await clickWorldPointChecked(page, topFaceCenter(PLATE.thickness));
  await treeRow(page, '点1').click({ modifiers: ['Shift'] });
  await openToolMenu(page, '加工');
  await expect(holeButton).toBeEnabled();
  await holeButton.click();
  await expect(popoverTitle(page)).toHaveText('穴をあける');
  await popoverInputs(page).first().fill(String(PLATE.holeDiameter));
  await popover(page).getByRole('switch', { name: '貫通', exact: true }).click();
  const token = await beginRecompute(page);
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
  await waitForRecompute(page, token);
  await expect(treeRow(page, '穴1')).toBeVisible();

  const savedPath = info.outputPath('holed-plate.pcad');
  const bytes = new Uint8Array(await saveFlowFile(page, savedPath, app));
  await expect(statusText(page)).toHaveText('保存しました');
  expect(bytes.byteLength).toBeGreaterThan(0);
  return bytes;
}

/** 「部品を置く」の窓に位置を入れて Enter で置く(`assembly.spec.ts` の同名補助と同じ)。 */
export async function placeQueuedPart(page: Page, sources: readonly string[]): Promise<void> {
  await chooseToolMenuItem(page, '組む', '部品を置く');
  const dialog = page.getByRole('dialog', { name: '部品を置く位置' });
  await expect(dialog).toBeVisible();
  const fields = dialog.locator('input.pcad-field__input');
  for (let index = 0; index < sources.length; index += 1) {
    if (sources[index] !== '') await fields.nth(index).fill(sources[index]);
  }
  const token = await beginRecompute(page);
  await fields.first().press('Enter');
  await expect(dialog).toHaveCount(0);
  await waitForRecompute(page, token);
}

// ---------------------------------------------------------------------------
// ホーム視点の座標変換。値は `packages/ui/src/viewport/cameraMath.ts` の HOME_ORBIT と
// VERTICAL_FIELD_OF_VIEW(spec から packages/ui を import しないため写す)。式は
// `solidCaptureSupport.ts` の worldToCanvas と同じ。組立のビューも同じホーム視点を使う。
// ---------------------------------------------------------------------------

const HOME_AZIMUTH = -Math.PI / 4;
const HOME_ELEVATION = Math.atan(Math.SQRT1_2);
const HOME_DISTANCE = 200;
const VERTICAL_FIELD_OF_VIEW = (50 * Math.PI) / 180;

function sub(a: WorldPoint, b: WorldPoint): WorldPoint { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a: WorldPoint, b: WorldPoint): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: WorldPoint, b: WorldPoint): WorldPoint {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function unit(a: WorldPoint): WorldPoint {
  const length = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / length, a[1] / length, a[2] / length];
}
const EYE: WorldPoint = [
  HOME_DISTANCE * Math.cos(HOME_ELEVATION) * Math.cos(HOME_AZIMUTH),
  HOME_DISTANCE * Math.cos(HOME_ELEVATION) * Math.sin(HOME_AZIMUTH),
  HOME_DISTANCE * Math.sin(HOME_ELEVATION),
];
const CAMERA_Z = unit(EYE);
const CAMERA_X = unit(cross([0, 0, 1], CAMERA_Z));
const CAMERA_Y = cross(CAMERA_Z, CAMERA_X);

/** ワールド座標の点が見えているページ上の位置(ホーム視点)。 */
export async function homeViewPagePoint(page: Page, world: WorldPoint): Promise<readonly [number, number]> {
  const box = await page.locator('canvas.pcad-viewport__canvas').boundingBox();
  if (box === null) throw new Error('ビューポートのcanvasの位置と大きさが取れませんでした。');
  const view = sub(world, EYE);
  const depth = -dot(view, CAMERA_Z);
  const scale = 1 / Math.tan(VERTICAL_FIELD_OF_VIEW / 2);
  const ndcX = (scale * dot(view, CAMERA_X)) / (depth * (box.width / box.height));
  const ndcY = (scale * dot(view, CAMERA_Y)) / depth;
  return [box.x + ((ndcX + 1) / 2) * box.width, box.y + ((1 - ndcY) / 2) * box.height];
}

/**
 * ワールドの点を押す。押す前に、その画素の一番上の要素が canvas であること(締結の窓などが覆っていないこと)を
 * 確かめ、覆っていれば何を押しそうだったかを付けて落とす(押し違いを「選べなかった」と取り違えない)。
 */
export async function clickWorldPointChecked(page: Page, world: WorldPoint): Promise<void> {
  await waitForSettledRecompute(page);
  const [x, y] = await homeViewPagePoint(page, world);
  const hit = await page.evaluate(([px, py]) => {
    const element = document.elementFromPoint(px, py);
    return element instanceof HTMLCanvasElement && element.classList.contains('pcad-viewport__canvas')
      ? 'canvas' : element === null ? 'none' : `${element.tagName}.${element.className}`;
  }, [x, y] as const);
  expect(hit, `(${world.join(', ')}) を押す位置 (${x.toFixed(0)}, ${y.toFixed(0)}) が覆われています`).toBe('canvas');
  await page.mouse.click(x, y);
}

/** ホーム視点へ戻し、描き直しが 1 回終わるまで待つ。 */
export async function goHome(page: Page): Promise<void> {
  const before = await readViewportRenderStats(page);
  await page.getByRole('button', { name: 'ホーム視点', exact: true }).click();
  await expect.poll(async () => (await readViewportRenderStats(page)).completedRenders)
    .toBeGreaterThan(before.completedRenders);
}

/**
 * 板の穴の内側の面を押す点。穴の軸の上面の点を押すと、視線は穴の中を通って奥側の内壁(深さ約 2.3mm)に当たる
 * (仰角 35.3° では水平 2mm 進むごとに 1mm 下がり、半径 4.5mm の穴の奥の壁は厚さ 10mm の中にある)。
 */
export function holeWallPoint(offset: readonly [number, number, number], topZ: number = PLATE.thickness): WorldPoint {
  return [offset[0] + PLATE.holeX, offset[1] + PLATE.holeY, offset[2] + topZ];
}

/** 板の上面で、穴から 12mm 以上離れた点。 */
export function plateTopPoint(offset: readonly [number, number, number], topZ: number = PLATE.thickness): WorldPoint {
  return [offset[0] + 32, offset[1] + 22, offset[2] + topZ];
}

/** 締結の打ちかけの状態欄の文(`assembly.status.boltedJointStep` の実文を写す)。 */
export function stepStatus(count: number, next: string): string {
  return `ボルトで締結 ${String(count)}/4: ${next} Esc でやめます。`;
}

export const PICK_TEXT = {
  holeA: '1 つ目の部品の穴の内側の面を選んでください。',
  faceA: '1 つ目の部品の、相手に当てる平らな面を選んでください。',
  holeB: '2 つ目の部品の穴の内側の面を選んでください。',
  faceB: '2 つ目の部品の、相手に当てる平らな面を選んでください。',
} as const;

export const READY_STATUS = 'ボルトで締結: 提案を確かめ、Enter か「締結する」で締結します。Esc でやめます。';

/** 締結の窓を開き、4 面を順に選ぶ。各段で状態欄の何面目と次の面を確かめる。 */
export async function openAndPickFourFaces(page: Page): Promise<void> {
  await chooseToolMenuItem(page, '組む', 'ボルトで締結');
  await expect(boltedJointDialog(page)).toBeVisible();
  await expect(statusText(page)).toHaveText(stepStatus(1, PICK_TEXT.holeA));
  const second = SECOND_PLATE_OFFSET;
  const steps: readonly [WorldPoint, string | null][] = [
    [holeWallPoint([0, 0, 0]), stepStatus(2, PICK_TEXT.faceA)],
    [plateTopPoint([0, 0, 0]), stepStatus(3, PICK_TEXT.holeB)],
    [holeWallPoint(second), stepStatus(4, PICK_TEXT.faceB)],
    [plateTopPoint(second), null],
  ];
  for (const [point, expected] of steps) {
    await clickWorldPointChecked(page, point);
    if (expected !== null) await expect(statusText(page)).toHaveText(expected);
  }
  await expect(statusText(page)).not.toContainText('/4:');
}

export interface ComponentPose {
  readonly position: readonly number[];
  readonly rotation: readonly number[];
}

/** 解いた後の各部品の配置(読むだけ。検査の口 `pcadAssemblyStats`)。 */
export async function resolvedPoses(page: Page): Promise<readonly ComponentPose[]> {
  const stats: AssemblyBrowserStats = await readAssemblyStats(page);
  return stats.components.map((component) => {
    if (component.resolved === null) throw new Error(`${component.name} の配置が解けていません。`);
    return component.resolved;
  });
}

export function expectVectorClose(actual: readonly number[], expected: readonly number[], digits = 6): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index] ?? Number.NaN, digits));
}
