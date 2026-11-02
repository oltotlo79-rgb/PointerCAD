/// <reference lib="dom" />
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readPcadFile } from '../../packages/io/src/index.js';
import { machiningOracleMath } from './machiningSurfaceOracle.js';
import { createMathBackend, executeFunctionCurveWorkRequest } from '../../packages/expression/src/math/publicWorker.js';
import { createFunctionCurveWorkEnvelope, decodeFunctionCurveWorkReply } from '../../packages/expression/src/math/publicContracts.js';
import { nextFeatureId, type PartDocument } from '../../packages/model/src/index.js';
import { recomputePart } from '../../packages/model/src/part/recomputePart.js';
import { createInspectableNativeKernelForNodeTests } from '../../packages/model/src/testing/createNativeKernelBridge.node.js';
import { drawRectangle, extrudeFace, makeFace } from './solidCaptureSupport.js';
import { chooseShapeTool, drawLine } from './sketchDrawCaptureSupport.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { functionPlotMessage } from './functionMessages.js';
import { saveFlowFile, openSaveFlowFile } from './saveResponsivenessFlow.js';
import { waitForStartupReady } from './startupHealth.js';

import type { CutPreview } from '../../packages/ui/src/viewport/createSolidLayer.js';

import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute, waitForSettledRecompute, type RecomputeToken } from './recompute.js';

/**
 * 切る面の材料(EX-04 W1)を、実際のブラウザで通しで確かめる。**ヘッドレスで実行する。**
 *
 * 既存の切断の検査(`p5-cut-mirror.spec.ts`:立体を選んで「切断」→ 作図面で切る)に、今回つないだ
 * 5 つの材料の操作を 1 件ずつ足したもの。ブラウザーは cut-plane-materials.spec.ts、Electron は
 * electron-cut-plane-materials.spec.ts の既存の起動(launchDesktop)から呼ぶ(faceOffsetFlow.ts と同じ形)。
 *
 * 1. スケッチの点 … 箱と「点1」(0, 0, 5)を選んで「切断」→ そのまま決定(点を通り Z 軸に垂直)。
 * 2. 座標の式 … 決め方「点と軸」、「点を座標で入れる」で 点の Z = `2*2`(点 (0, 0, 4))。
 * 3. XYZ 軸 … 決め方「Y 軸に垂直な面」、位置 = `-10/2`(y = −5)。
 * 4. 辺 … `2` で辺を選び、手前の縦の辺 (10, −10, ·) と「点2」(−10, 0, 0) で「辺を含む面(辺と点)」、両側を残す。
 * 5. 作業平面 … 作図面(XY)から 3 離した「作業平面1」を選び、決め方「選んだ作業平面」。
 *
 * 形は実物の Worker + OCCT が作り、体積は画面のプロパティから読む(作った結果を差し込まない)。
 * 箱は既定の 20×20×20(中心が原点、各軸 −10〜+10)。どの操作も、確かめた後に「元に戻す」1 回で
 * 切断(と座標の補助の基準点)が消えて箱へ戻ることを見てから次へ進む。
 *
 * EX-04 W2(予告と確定の一致): どの操作も、決定の前に予告が出ていることを検査専用の口
 * `window.pcadViewportCutPreview`(scene へ渡した最後の予告)から読み、予告の面が決め方の定義どおりで、
 * 決定後の体積が「予告の面で箱を切った残る側」の厳密な体積(多面体の切り取り)と一致することを確かめる。
 * 6. 傾きの式 … 「点と軸」で傾き = `15*2`(以前の予告は 0 度と読んだ)、「反対側を残す」で残す側だけが逆になる。
 * 7. 取消 … 予告が出ている状態から Esc と「取消」で閉じると予告が消え、切断は積まれない。
 *
 * 補助関数は p5-cut-mirror.spec.ts・faceOffsetFlow.ts・p5-primitive-pick.spec.ts と同じ作りで、
 * 共有ファイルを作らずここへ書き写す(各 spec の頭の注釈と同じ決まり)。選択子は role / aria / class で引く。
 */

/** 既定の箱の 1 辺(DEFAULT_BOX_SIZE_MM)。 */
const BOX_SIZE_MM = 20;
const BOX_VOLUME = BOX_SIZE_MM ** 3;
/** z に垂直な断面の面積(20 × 20)。高さ h の板の体積は h × これ。 */
const SLAB_AREA = BOX_SIZE_MM * BOX_SIZE_MM;
/** ja.json の propertyPanel.unitCubicMillimeter。 */
const VOLUME_UNIT = 'mm³';
/** 予告の面の許容差: 法線の角度(rad)と面からの距離(mm)。予告の値は double のまま届く。 */
const PREVIEW_TOLERANCE = 1e-9;
/** 決定後の体積と、予告の面で箱を切った体積の相対差の上限(単体の独立の照合と同じ)。 */
const VOLUME_RELATIVE_TOLERANCE = 1e-9;

/**
 * 検査専用の口(ViewportCanvas.tsx)が返す、scene へ渡した最後の切断の予告(EX-04 W2)。形はアプリの実物
 * (`createSolidLayer.ts` の `CutPreview`)を型だけ import して使う(recompute.ts と同じ。写しを作ると
 * アプリ側の変更に気付けず、同じ `Window` の口の宣言が食い違う TS2717 になる)。
 */
type CutPreviewReading = CutPreview;

declare global {
  interface Window {
    pcadViewportCutPreview?: () => CutPreview | null;
  }
}

function collectErrors(page: Page): readonly string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  return errors;
}

async function disableFilePickers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value: undefined,
      });
    }
  });
}

function sketchTool(page: Page, label: string): Locator {
  return page
    .getByRole('group', { name: 'スケッチ' })
    .getByRole('button', { name: label, exact: true });
}

function toolMenuTrigger(page: Page, menu: string): Locator {
  return page
    .locator('.pcad-toolbar')
    .getByRole('button', { name: new RegExp(`^${menu}`) })
    .first();
}

function toolMenuPanel(page: Page, menu: string): Locator {
  return page.locator('.pcad-toolbar').getByRole('group', { name: menu, exact: true });
}

async function openToolMenu(page: Page, menu: string): Promise<void> {
  if ((await toolMenuPanel(page, menu).count()) === 0) {
    await toolMenuTrigger(page, menu).click();
  }
  await expect(toolMenuPanel(page, menu)).toBeVisible();
}

function menuTool(page: Page, menu: string, label: string): Locator {
  return toolMenuPanel(page, menu).getByRole('button', { name: label, exact: true });
}

/** 作図面の一覧(作業平面を作る入口。workplane-3d.spec.ts と同じ引き方)。 */
async function choosePlaneMenuItem(page: Page, label: string): Promise<void> {
  await page.getByRole('group', { name: '作図面' }).locator('.pcad-menu__trigger').first().click();
  await page
    .locator('.pcad-menu__panel[aria-label="作図面"]')
    .getByRole('button', { name: label, exact: true })
    .click();
}

function popover(page: Page): Locator {
  return page.locator('.pcad-popover');
}

function popoverTitle(page: Page): Locator {
  return page.locator('.pcad-popover__title');
}

function popoverInputs(page: Page): Locator {
  return page.locator('.pcad-popover input.pcad-field__input');
}

/** ポップアップの欄を見出しで引く(並びに頼らない)。 */
function popoverField(page: Page, label: string): Locator {
  return popover(page)
    .locator('.pcad-field')
    .filter({ has: page.locator('.pcad-field__label', { hasText: new RegExp(`^${label}$`) }) })
    .locator('input.pcad-field__input');
}

function popoverToggle(page: Page, label: string): Locator {
  return popover(page).getByRole('switch', { name: label, exact: true });
}

async function fillFields(page: Page, sources: readonly string[]): Promise<void> {
  await expect(popover(page)).toBeVisible();
  const inputs = popoverInputs(page);
  for (const [index, source] of sources.entries()) {
    await inputs.nth(index).fill(source);
  }
}

/** 欄が 0 個の段でも決められるよう、「決定」のボタンで決める(p5-cut-mirror.spec.ts と同じ)。 */
async function commitPopover(page: Page): Promise<void> {
  await popover(page).getByRole('button', { name: '決定', exact: true }).click();
  await expect(popover(page)).toHaveCount(0);
}

/** 続けてかく道具が開き直した入力欄を閉じる。開いていなければ何もしない(workplane-3d.spec.ts と同じ)。 */
async function cancelPopover(page: Page): Promise<void> {
  if ((await popover(page).count()) === 0) {
    return;
  }
  if ((await popoverInputs(page).count()) > 0) {
    await popoverInputs(page).first().press('Escape');
  } else {
    await page.locator('canvas.pcad-viewport__canvas').press('Escape');
  }
  await expect(popover(page)).toHaveCount(0);
}

/** 「切る面の決め方」を選ぶ(選択肢が多いので畳んだ一覧から選ぶ)。 */
async function chooseCutPlaneKind(page: Page, label: string): Promise<void> {
  const choice = popover(page)
    .locator('.pcad-popover__choice')
    .filter({ has: page.locator('.pcad-popover__choice-label', { hasText: /^切る面の決め方$/ }) });
  await choice.locator('.pcad-menu__trigger').click();
  await choice.getByRole('menuitem', { name: label, exact: true }).click();
  await expect(choice.locator('.pcad-menu__count')).toHaveText(label);
}

function featureTree(page: Page): Locator {
  return page.locator('.pcad-panel--left');
}

function propertyPanel(page: Page): Locator {
  return page.locator('.pcad-panel--right');
}

function selectionKindLabel(page: Page): Locator {
  return page.locator('.pcad-statusbar__state').first();
}

function treeSection(page: Page, title: string): Locator {
  return featureTree(page).locator('.pcad-tree__sections > li').filter({ hasText: title });
}

function treeRow(page: Page, name: string): Locator {
  return featureTree(page).getByRole('button', { name, exact: true });
}

function solidRow(page: Page, name: string): Locator {
  return treeSection(page, 'ソリッド').getByRole('button', { name, exact: true });
}

function propertyValue(page: Page, key: string): Locator {
  return propertyPanel(page)
    .locator('dt.pcad-properties__key', { hasText: key })
    .locator('xpath=following-sibling::dd[1]');
}

/** その行を選び、計算が終わるのを待ってから、体積がその値になるまで待つ(p5-cut-mirror.spec.ts と同じ)。 */
async function expectVolume(page: Page, rowName: string, volume: number, token?: RecomputeToken): Promise<void> {
  await solidRow(page, rowName).click();
  await waitForRecompute(page, token);
  await expect(propertyValue(page, '体積')).toHaveText(`${String(volume)} ${VOLUME_UNIT}`, {
    timeout: KERNEL_TIMEOUT_MS,
  });
}

async function volumeOf(page: Page, rowName: string): Promise<number> {
  await solidRow(page, rowName).click();
  await expect(propertyValue(page, '体積')).toHaveText(new RegExp(`${VOLUME_UNIT}$`), { timeout: KERNEL_TIMEOUT_MS });
  return Number.parseFloat(await propertyValue(page, '体積').innerText());
}

/** 「作る」の一覧から基本形状の箱を、既定の 20×20×20 のまま原点へ置く(p5-cut-mirror.spec.ts と同じ)。 */
async function placeBox(page: Page): Promise<void> {
  await openToolMenu(page, '作る');
  await menuTool(page, '作る', '箱').click();
  await expect(popoverTitle(page)).toHaveText('箱を置く');
  await expect(popoverInputs(page).nth(0)).toHaveValue(String(BOX_SIZE_MM));
  const token = await beginRecompute(page);
  await popoverInputs(page).first().press('Enter');
  await expect(popover(page)).toHaveCount(0);
  await expect(solidRow(page, '箱1')).toBeVisible();
  await expectVolume(page, '箱1', BOX_VOLUME, token);
}

/** 「点」の道具で 1 つだけ点を置く(faceOffsetFlow.ts の穴の中心と同じ手順)。座標はワールドの絶対座標。 */
async function drawPoint(page: Page, at: readonly [string, string, string]): Promise<void> {
  // 同じ道具をもう一度押すと解除されるので、選択へ戻してから「点」を押す。
  await sketchTool(page, '選択').click();
  await sketchTool(page, '点').click();
  await expect(popoverTitle(page)).toBeVisible();
  await fillFields(page, at);
  await popoverInputs(page).first().press('Enter');
  await cancelPopover(page);
}

/** 立体の行を選び、続けて Shift を押しながら材料の行を足す。 */
async function selectRows(page: Page, body: string, materials: readonly string[]): Promise<void> {
  await sketchTool(page, '選択').click();
  await solidRow(page, body).click();
  for (const name of materials) {
    await treeRow(page, name).click({ modifiers: ['Shift'] });
  }
}

/** 「加工」の一覧から「切断」を押し、「切る面」の入力欄を開く。 */
async function openCut(page: Page): Promise<void> {
  await openToolMenu(page, '加工');
  const cut = menuTool(page, '加工', '切断');
  await expect(cut).toBeEnabled();
  await cut.click();
  await expect(popoverTitle(page)).toHaveText('切る面');
}

/** 元に戻す 1 回で、切断の行(と補助の基準点)が消えて箱が戻ることを確かめる。 */
async function undoCut(page: Page, rows: readonly string[], references: readonly string[] = []): Promise<void> {
  // 欄に焦点があるとキーが欄に入るので、道具を選び直して焦点を外す(faceOffsetFlow.ts の 7) と同じ)。
  await sketchTool(page, '選択').click();
  const token = await beginRecompute(page);
  await page.keyboard.press('Control+z');
  for (const row of rows) {
    await expect(solidRow(page, row)).toHaveCount(0);
  }
  for (const reference of references) {
    await expect(treeRow(page, reference)).toHaveCount(0);
  }
  await expectVolume(page, '箱1', BOX_VOLUME, token);
}

/* ホーム視点の写し(p5-primitive-pick.spec.ts と同じ数値・同じ組み立て。この検査も視点を動かさない)。 */
type WorldPoint = readonly [number, number, number];
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

async function clickWorldPoint(page: Page, world: WorldPoint): Promise<void> {
  const canvas = page.locator('canvas.pcad-viewport__canvas');
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error('ビューポートの canvas の位置と大きさが取れませんでした。');
  }
  const [x, y] = worldToCanvas(world, box.width, box.height);
  await page.mouse.click(box.x + x, box.y + y);
}

/* 予告の読み取りと、予告の面からの体積(EX-04 W2)。 */

/** いまの予告を読む。口が無ければ検査を落とし、予告が無ければ null。 */
async function readCutPreview(page: Page): Promise<CutPreviewReading | null> {
  return page.evaluate(() => {
    const read = window.pcadViewportCutPreview;
    if (read === undefined) {
      throw new Error('検査専用の口 pcadViewportCutPreview が見つかりません。');
    }
    return read();
  });
}

function angleBetween(a: WorldPoint, b: WorldPoint): number {
  return Math.atan2(Math.hypot(...crossPoints(a, b)), dotPoints(a, b));
}

/** 予告の面が、法線 `normal` の向き(`signed` が偽なら表裏は問わない)で `point` を通る面か。 */
function previewPlaneIs(preview: CutPreviewReading, normal: WorldPoint, point: WorldPoint, signed = true): boolean {
  const unit = normalizePoint(normal);
  const angle = angleBetween(preview.plane.normal, unit);
  return (signed ? angle : Math.min(angle, Math.PI - angle)) <= PREVIEW_TOLERANCE
    && Math.abs(dotPoints(unit, subtractPoints(preview.plane.origin, point))) <= PREVIEW_TOLERANCE;
}

/**
 * 予告が出て、`matches` を満たすまで待って読む(欄・つまみ・選択肢の変更が予告へ届くのを待つ)。
 * 満たさないまま時間切れなら、その時点の予告を添えて落とす。
 */
async function waitForCutPreview(page: Page, label: string,
  matches: (preview: CutPreviewReading) => boolean): Promise<CutPreviewReading> {
  await expect.poll(async () => {
    const preview = await readCutPreview(page);
    return preview !== null && matches(preview) ? 'ok' : JSON.stringify(preview);
  }, { message: `切断の予告: ${label}` }).toBe('ok');
  const preview = await readCutPreview(page);
  if (preview === null) {
    throw new Error(`切断の予告が出ていません: ${label}`);
  }
  return preview;
}

/** 決定・取消で入力欄が閉じたら、予告も消える。 */
async function expectNoCutPreview(page: Page): Promise<void> {
  await expect.poll(() => readCutPreview(page), { message: '切断の予告が消える' }).toBeNull();
}

/**
 * 箱(中心が原点、1 辺 BOX_SIZE_MM)を面で切り、残す側(法線の側 / 反対側)の体積を厳密に求める。
 * 6 面の四角を残す側で切り取り(面の上の頂点・交点は切り口の多角形へ集める)、切り口を足した凸多面体の
 * 体積を、内部の 1 点から各面への錐(面積 × 距離 / 3)の和で出す。製品のコードは使わない。
 */
function keptBoxVolume(origin: WorldPoint, normal: WorldPoint, keep: 'positive' | 'negative'): number {
  const half = BOX_SIZE_MM / 2;
  const epsilon = BOX_SIZE_MM * 1e-12;
  const sign = keep === 'positive' ? 1 : -1;
  const side = (point: WorldPoint): number => sign * dotPoints(normal, subtractPoints(point, origin));
  const corner = (axis: number, at: number, a: number, b: number): WorldPoint => {
    const point: [number, number, number] = [0, 0, 0];
    point[axis] = at;
    point[(axis + 1) % 3] = a;
    point[(axis + 2) % 3] = b;
    return point;
  };
  const polygons: WorldPoint[][] = [];
  const cap: WorldPoint[] = [];
  for (const axis of [0, 1, 2]) {
    for (const at of [-half, half]) {
      const face = [corner(axis, at, -half, -half), corner(axis, at, half, -half),
        corner(axis, at, half, half), corner(axis, at, -half, half)];
      const kept: WorldPoint[] = [];
      face.forEach((point, index) => {
        const next = face[(index + 1) % face.length];
        const here = side(point);
        const there = side(next);
        if (here >= -epsilon) kept.push(point);
        if (Math.abs(here) <= epsilon) cap.push(point);
        if ((here > epsilon && there < -epsilon) || (here < -epsilon && there > epsilon)) {
          const t = here / (here - there);
          const crossing: WorldPoint = [point[0] + t * (next[0] - point[0]), point[1] + t * (next[1] - point[1]),
            point[2] + t * (next[2] - point[2])];
          kept.push(crossing);
          cap.push(crossing);
        }
      });
      if (kept.length >= 3) polygons.push(kept);
    }
  }
  // 切り口: 同じ点(2 面が共有する交点・面の上の角)を 1 つにし、重心のまわりの角度の順に並べる。
  const unique = cap.filter((point, index) =>
    cap.findIndex((other) => Math.hypot(...subtractPoints(point, other)) <= epsilon) === index);
  if (unique.length >= 3) {
    const center = averagePoint(unique);
    const u = normalizePoint(subtractPoints(unique[0], center));
    const v = crossPoints(normalizePoint(normal), u);
    const angleOf = (point: WorldPoint): number => {
      const offset = subtractPoints(point, center);
      return Math.atan2(dotPoints(offset, v), dotPoints(offset, u));
    };
    polygons.push([...unique].sort((a, b) => angleOf(a) - angleOf(b)));
  }
  // 内部の 1 点(全頂点の平均)から各面への錐の体積の和。面の向きに依らないよう距離は絶対値で取る。
  const inside = averagePoint(polygons.flat());
  let volume = 0;
  for (const polygon of polygons) {
    let areaVector: WorldPoint = [0, 0, 0];
    for (let index = 1; index + 1 < polygon.length; index += 1) {
      const fan = crossPoints(subtractPoints(polygon[index], polygon[0]), subtractPoints(polygon[index + 1], polygon[0]));
      areaVector = [areaVector[0] + fan[0], areaVector[1] + fan[1], areaVector[2] + fan[2]];
    }
    const twiceArea = Math.hypot(...areaVector);
    if (twiceArea > 0) {
      const unit: WorldPoint = [areaVector[0] / twiceArea, areaVector[1] / twiceArea, areaVector[2] / twiceArea];
      volume += ((twiceArea / 2) * Math.abs(dotPoints(unit, subtractPoints(polygon[0], inside)))) / 3;
    }
  }
  return volume;
}

function averagePoint(points: readonly WorldPoint[]): WorldPoint {
  const mean = (axis: 0 | 1 | 2): number => points.reduce((sum, point) => sum + point[axis], 0) / points.length;
  return [mean(0), mean(1), mean(2)];
}

/**
 * 決定後の切断の体積(画面のプロパティ、有効数字 12 桁)が、予告の面で箱を切った残る側の厳密な体積と
 * 相対 1e-9 で一致すること(予告の面 = 確定の面)。読んだ体積を返す。
 */
async function expectVolumeFromPreview(page: Page, rowName: string, preview: CutPreviewReading,
  keep: 'positive' | 'negative'): Promise<number> {
  const actual = await volumeOf(page, rowName);
  const expected = keptBoxVolume(preview.plane.origin, preview.plane.normal, keep);
  expect(Math.abs(actual - expected) / expected, `${rowName}: 画面 ${String(actual)} / 予告の面から ${String(expected)}`)
    .toBeLessThanOrEqual(VOLUME_RELATIVE_TOLERANCE);
  return actual;
}

/**
 * 切る面の材料 5 つ(スケッチの点・座標の式・XYZ 軸・辺・作業平面)の切断を 1 件ずつ確かめる。
 * `entry` はブラウザーでは '/'(preview)、Electron では製品の入口 'app://pointercad/index.html'。
 */
export async function cutPlaneMaterialsFlow(page: Page, entry: string): Promise<void> {
  const errors = collectErrors(page);
  await disableFilePickers(page);
  // 押す場所を計算するので窓の大きさを固定する(p5-primitive-pick.spec.ts と同じ 1440×900)。
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(entry);
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

  // 0) 箱(−10〜+10)と、材料のスケッチの点 2 つ・作業平面 1 つ。
  await placeBox(page);
  await drawPoint(page, ['0', '0', '5']);
  await expect(treeRow(page, '点1')).toBeVisible();
  await drawPoint(page, ['-10', '0', '0']);
  await expect(treeRow(page, '点2')).toBeVisible();
  await choosePlaneMenuItem(page, '作業平面(オフセット)');
  await expect(popoverTitle(page)).toHaveText('面から離す');
  await fillFields(page, ['3']);
  await popoverInputs(page).first().press('Enter');
  await cancelPopover(page);
  await expect(treeRow(page, '作業平面1')).toBeVisible();

  // 1) スケッチの点: 箱と「点1」(0,0,5)を選んで切断 → 決め方は既定のまま(点を通り Z 軸に垂直)。z = 5〜10 が残る。
  //    決定の前に予告が出る(以前はスケッチの点では出なかった)。決定すると予告は消える。
  await selectRows(page, '箱1', ['点1']);
  await openCut(page);
  const sketchPreview = await waitForCutPreview(page, 'スケッチの点 (0,0,5)、Z 軸に垂直',
    (preview) => preview.keep === 'positive' && previewPlaneIs(preview, [0, 0, 1], [0, 0, 5]));
  const sketchToken = await beginRecompute(page);
  await commitPopover(page);
  await expectNoCutPreview(page);
  await expect(solidRow(page, '切断1')).toBeVisible();
  await expectVolume(page, '切断1', 5 * SLAB_AREA, sketchToken);
  await expectVolumeFromPreview(page, '切断1', sketchPreview, 'positive');
  await undoCut(page, ['切断1']);

  // 2) 座標の式: 「点と軸」+「点を座標で入れる」で 点の Z = 2*2。補助の基準点が 1 つでき、z = 4〜10 が残る。
  //    予告は打った式を決定と同じ評価器で読み、点 (0,0,4) を通る(予告の中では基準点を積まない)。
  await selectRows(page, '箱1', []);
  await openCut(page);
  await chooseCutPlaneKind(page, '点と軸');
  await popoverToggle(page, '点を座標で入れる').click();
  await expect(popoverField(page, '点の Z')).toHaveValue('0');
  await popoverField(page, '点の Z').fill('2*2');
  const coordinatePreview = await waitForCutPreview(page, '座標の点 (0,0,2*2)、Z 軸に垂直',
    (preview) => preview.keep === 'positive' && previewPlaneIs(preview, [0, 0, 1], [0, 0, 4]));
  await expect(treeRow(page, '基準点1')).toHaveCount(0);
  const coordinateToken = await beginRecompute(page);
  await commitPopover(page);
  await expectNoCutPreview(page);
  await expect(treeRow(page, '基準点1')).toBeVisible();
  await expectVolume(page, '切断1', 6 * SLAB_AREA, coordinateToken);
  await expectVolumeFromPreview(page, '切断1', coordinatePreview, 'positive');
  await undoCut(page, ['切断1'], ['基準点1']);

  // 3) XYZ 軸: 「Y 軸に垂直な面」の位置 = -10/2。y = −5〜10 が残る(15 × 20 × 20)。予告は y = −5、法線 +Y。
  await selectRows(page, '箱1', []);
  await openCut(page);
  await chooseCutPlaneKind(page, 'Y 軸に垂直な面');
  await expect(popoverField(page, '位置')).toHaveValue('0');
  await popoverField(page, '位置').fill('-10/2');
  const axisPreview = await waitForCutPreview(page, 'Y 軸に垂直な面・位置 -10/2',
    (preview) => preview.keep === 'positive' && previewPlaneIs(preview, [0, 1, 0], [0, -5, 0]));
  const axisToken = await beginRecompute(page);
  await commitPopover(page);
  await expectNoCutPreview(page);
  await expectVolume(page, '切断1', 15 * BOX_SIZE_MM * BOX_SIZE_MM, axisToken);
  await expectVolumeFromPreview(page, '切断1', axisPreview, 'positive');
  await undoCut(page, ['切断1'], ['基準点1']);

  // 4) 辺: `2` で辺を選び、手前の縦の辺 (10, −10, ·) を押す → 箱と「点2」(−10,0,0)を Shift で足す →
  //    「辺を含む面(辺と点)」で両側を残す。面 x + 2y + 10 = 0 で、角 (−10,−10) の側の三角柱 100 × 20 と残り。
  await waitForSettledRecompute(page);
  await sketchTool(page, '選択').click();
  await page.keyboard.press('2');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 辺');
  await clickWorldPoint(page, [10, -10, 0]);
  await solidRow(page, '箱1').click({ modifiers: ['Shift'] });
  await treeRow(page, '点2').click({ modifiers: ['Shift'] });
  await openCut(page);
  await chooseCutPlaneKind(page, '辺を含む面(辺と点)');
  await popoverToggle(page, '反対側も残す(2 つに分ける)').click();
  // 予告は x + 2y + 10 = 0(法線の表裏は辺の向きで決まる)。両側でも矢印は 1 つ目の切断の残す側(法線の側)。
  const edgePreview = await waitForCutPreview(page, '辺を含む面(辺と点2)・両側',
    (preview) => preview.keep === 'positive' && previewPlaneIs(preview, [1, 2, 0], [-10, 0, 0], false));
  const edgeToken = await beginRecompute(page);
  await commitPopover(page);
  await expectNoCutPreview(page);
  await expect(solidRow(page, '切断1')).toBeVisible();
  await expect(solidRow(page, '切断2')).toBeVisible();
  await waitForRecompute(page, edgeToken);
  const sides = [await volumeOf(page, '切断1'), await volumeOf(page, '切断2')].sort((a, b) => a - b);
  expect(sides).toEqual([100 * BOX_SIZE_MM, BOX_VOLUME - 100 * BOX_SIZE_MM]);
  // 1 つ目(法線の側)と 2 つ目(反対側)が、それぞれ予告の面で切った側の体積になる。
  await expectVolumeFromPreview(page, '切断1', edgePreview, 'positive');
  await expectVolumeFromPreview(page, '切断2', edgePreview, 'negative');
  await undoCut(page, ['切断1', '切断2']);
  await page.keyboard.press('4');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 立体');

  // 5) 作業平面: 箱と「作業平面1」(z = 3)を選び、「選んだ作業平面」。z = 3〜10 が残る。
  //    予告は作業平面そのもの(以前は基準の 3 面以外の作業平面では出なかった)。
  await selectRows(page, '箱1', ['作業平面1']);
  await openCut(page);
  await chooseCutPlaneKind(page, '選んだ作業平面');
  const planePreview = await waitForCutPreview(page, '作業平面1(z = 3)',
    (preview) => preview.keep === 'positive' && previewPlaneIs(preview, [0, 0, 1], [0, 0, 3]));
  const planeToken = await beginRecompute(page);
  await commitPopover(page);
  await expectNoCutPreview(page);
  await expectVolume(page, '切断1', 7 * SLAB_AREA, planeToken);
  await expectVolumeFromPreview(page, '切断1', planePreview, 'positive');
  await undoCut(page, ['切断1']);

  // 6) 傾きの式: 箱と「点1」(0,0,5)、「点と軸」で傾き = 15*2。予告は決定と同じ評価器で 30 度と読む
  //    (以前の予告は Number('15*2') を読めず 0 度の面を見せた)。「反対側を残す」で残す側だけが逆になり、
  //    面は変わらない。面は上の面も横切るので、残る体積は傾きで変わる(0 度なら 15 × 400 = 6000)。
  await selectRows(page, '箱1', ['点1']);
  await openCut(page);
  await chooseCutPlaneKind(page, '点と軸');
  await expect(popoverField(page, '傾き')).toHaveValue('0');
  await popoverField(page, '傾き').fill('15*2');
  const tiltedPreview = await waitForCutPreview(page, '点1 と Z 軸・傾き 15*2',
    (preview) => preview.keep === 'positive'
      && Math.abs(angleBetween(preview.plane.normal, [0, 0, 1]) - Math.PI / 6) <= PREVIEW_TOLERANCE
      && Math.hypot(...subtractPoints(preview.plane.origin, [0, 0, 5])) <= PREVIEW_TOLERANCE);
  await popoverToggle(page, '反対側を残す').click();
  const oppositePreview = await waitForCutPreview(page, '反対側を残す', (preview) => preview.keep === 'negative');
  expect(oppositePreview.plane).toEqual(tiltedPreview.plane);
  const tiltToken = await beginRecompute(page);
  await commitPopover(page);
  await expectNoCutPreview(page);
  await expect(solidRow(page, '切断1')).toBeVisible();
  await waitForRecompute(page, tiltToken);
  const tiltedVolume = await expectVolumeFromPreview(page, '切断1', oppositePreview, 'negative');
  expect(Math.abs(tiltedVolume - 15 * SLAB_AREA)).toBeGreaterThan(1);
  await undoCut(page, ['切断1']);

  // 7) 取消: 予告が出ている状態から、欄の Esc と「取消」のボタンで閉じる。どちらも予告が消え、
  //    切断は積まれない(箱の体積もそのまま)。
  await selectRows(page, '箱1', ['点1']);
  await openCut(page);
  await chooseCutPlaneKind(page, '点と軸');
  await waitForCutPreview(page, 'Esc の前', (preview) => previewPlaneIs(preview, [0, 0, 1], [0, 0, 5]));
  await popoverField(page, '傾き').press('Escape');
  await expect(popover(page)).toHaveCount(0);
  await expectNoCutPreview(page);
  await selectRows(page, '箱1', ['点1']);
  await openCut(page);
  await waitForCutPreview(page, '取消の前', (preview) => previewPlaneIs(preview, [0, 0, 1], [0, 0, 5]));
  await popover(page).getByRole('button', { name: '取消', exact: true }).click();
  await expect(popover(page)).toHaveCount(0);
  await expectNoCutPreview(page);
  await expect(solidRow(page, '切断1')).toHaveCount(0);
  await expectVolume(page, '箱1', BOX_VOLUME);

  expect(errors).toEqual([]);
}


/** 寸法由来の6代表。既存の平面材料1件は再実行せず、この不足分を別grepで選べる。 */
export const CUT_LIFECYCLE_CASES = ['plane', 'circle', 'arc', 'ellipse', 'ellipseArc', 'formula'] as const;
type CutLifecycleCase = typeof CUT_LIFECYCLE_CASES[number];

async function cutSavedPart(page: Page, info: TestInfo, name: string, app?: ElectronApplication): Promise<PartDocument> {
  const saved = readPcadFile(await saveFlowFile(page, info.outputPath(`${name}.pcad`), app));
  if (!saved.ok) throw new Error(saved.error.message);
  return saved.document;
}

/** UIで作った保存文書を既存の実native検査口へ渡す。形を差し込まず、期待体積は独立式だけ。 */
async function cutNativeVolume(part: PartDocument, expected: number, info: TestInfo, approximate: boolean): Promise<void> {
  // 開始/例外終了を直ちにstdoutへ残す。未到達の段階を0秒として記録しない。
  const startedAt = performance.now();
  const mark = (stage: string, outcome?: 'returned' | 'threw'): void => {
    const atMs = performance.now();
    console.log('[cut-lifecycle-native-phase]', JSON.stringify({
      stage, outcome, expected, timeOrigin: performance.timeOrigin, atMs,
      elapsedMs: atMs - startedAt,
    }));
  };
  // 引数の値、NODE_OPTIONS本文、個人の絶対パスは出さない。実loaderの可視範囲を明示する。
  const visibleFlags = new Set(['--require', '--import', '--loader', '--experimental-loader',
    '--conditions', '--enable-source-maps', '--input-type', '--eval', '--inspect', '--inspect-brk']);
  const loaderPattern = /(?:^|\/)(playwright\/lib\/(?:transform|common)\/[^/]+\.js|opencascade\.js\/dist\/node\.js)$/u;
  const loaderModules = typeof require === 'function'
    ? Object.keys(require.cache).flatMap(file => {
      const match = file.replaceAll('\\', '/').match(loaderPattern);
      return match === null ? [] : [match[1]];
    }).sort()
    : null;
  const nodeOptions = process.env.NODE_OPTIONS;
  console.log('[cut-lifecycle-native-runtime]', JSON.stringify({
    nodeVersion: process.version,
    execArgv: process.execArgv.slice(0, 16).map(arg => {
      const flag = arg.split('=')[0];
      return visibleFlags.has(flag) ? { flag, valueRedacted: arg.includes('=') } : { redacted: true };
    }),
    execArgvTruncated: process.execArgv.length > 16,
    nodeOptionsPresent: nodeOptions !== undefined,
    nodeOptionsLoaderFlags: nodeOptions?.slice(0, 2048).match(/--(?:require|import|loader|experimental-loader)(?==|\s|$)/gu)?.slice(0, 16) ?? [],
    requireCacheAvailable: loaderModules !== null,
    loaderModules: loaderModules?.slice(0, 16) ?? null,
    loaderModulesTruncated: loaderModules === null ? null : loaderModules.length > 16,
    loaderVisibility: 'require.cache only; ESM loader registry and pre-test transform time are not observed',
  }));
  const observeAsync = async <T>(stage: string, task: () => Promise<T>): Promise<T> => {
    mark(`${stage}-start`);
    let outcome: 'returned' | 'threw' = 'threw';
    try {
      const value = await task();
      outcome = 'returned';
      return value;
    } finally { mark(`${stage}-end`, outcome); }
  };
  const observeSync = <T>(stage: string, task: () => T): T => {
    mark(`${stage}-start`);
    let outcome: 'returned' | 'threw' = 'threw';
    try {
      const value = task();
      outcome = 'returned';
      return value;
    } finally { mark(`${stage}-end`, outcome); }
  };
  const native = await observeAsync('initialize', () => createInspectableNativeKernelForNodeTests());
  try {
    const keys = new Map<string, string>();
    const functionBackend = createMathBackend();
    const result = await observeAsync('recompute', () => recomputePart(part, native.bridge, {
      math: machiningOracleMath(part),
      functions: { curves: { evaluate: request => {
        const reply = decodeFunctionCurveWorkReply(
          executeFunctionCurveWorkRequest(createFunctionCurveWorkEnvelope(1, request), functionBackend), request);
        return Promise.resolve({ status: 'result', identity: reply.identity, result: reply.result });
      } } },
      onResolved: resolved => { for (const step of resolved.steps) keys.set(step.featureId, step.key); },
    }));
    expect(result.errors).toEqual([]);
    expect(result.cancelled).toBe(false);
    expect(result.bodies).toHaveLength(1);
    const key = keys.get(result.bodies[0].featureId);
    if (key === undefined) throw new Error('切断の実nativeキーがありません');
    const measured = observeSync('measure', () => native.inspectShape(key).measure());
    await info.attach('cut-lifecycle-native', { body: JSON.stringify({ expected, measured }), contentType: 'application/json' });
    expect(measured.validity).toMatchObject({ valid: true, solidCount: 1, closed: true });
    expect(measured.volume).toBeGreaterThan(0);
    if (approximate) expect(Math.abs(measured.volume - expected)).toBeLessThanOrEqual(0.1);
    else expect(Math.abs(measured.volume - expected) / expected).toBeLessThanOrEqual(1e-9);
  } finally { observeSync('dispose', () => native.dispose()); }
}

async function cutCurve(page: Page, kind: Exclude<CutLifecycleCase, 'plane'>, info: TestInfo,
  profileIds: string[], app?: ElectronApplication): Promise<void> {
  if (kind === 'formula') {
    await chooseToolMenuItem(page, '作図', functionPlotMessage('menuTitle'));
    const dialog = page.locator('.pcad-function-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Y =', exact: true }).fill('X^2/10+1');
    for (const [axis, min, max] of [['X', '0', '10'], ['Y', '0', '12'], ['Z', '0', '1']] as const) {
      await dialog.getByRole('textbox', { name: `${axis} ${functionPlotMessage('minimum')}`, exact: true }).fill(min);
      await dialog.getByRole('textbox', { name: `${axis} ${functionPlotMessage('maximum')}`, exact: true }).fill(max);
    }
    await dialog.getByRole('button', { name: functionPlotMessage('preview'), exact: true }).click();
    await expect(dialog.getByRole('button', { name: functionPlotMessage('apply'), exact: true })).toBeEnabled({ timeout: 60_000 });
    await dialog.getByRole('button', { name: functionPlotMessage('apply'), exact: true }).click();
    await expect(dialog).toHaveCount(0);
    // 数式の適用と交点分割は補助点や素材の分割線も作る。「新ID全部」は輪郭ではない。
    let source = await cutSavedPart(page, info, 'formula-profile-source', app);
    const curves = source.sketches.flatMap(sketch => sketch.features).filter(feature => feature.kind === 'functionCurve');
    expect(curves).toHaveLength(1);
    profileIds.push(curves[0].id);
    const sides = [
      { from: ['10', '11'], to: ['10', '0'] },
      { from: ['10', '0'], to: ['0', '0'] },
      { from: ['0', '0'], to: ['0', '1'] },
    ] as const;
    for (const [index, side] of sides.entries()) {
      expect(source.sketches).toHaveLength(1);
      // 同じ公開producerの次IDを操作前に固定。交点分割で後から増える線を拾わない。
      const expectedId = nextFeatureId(source.sketches[0], 'line');
      await drawLine(page, side.from, side.to);
      source = await cutSavedPart(page, info, `formula-profile-side-${index + 1}`, app);
      const made = source.sketches[0].features.find(feature => feature.id === expectedId);
      if (made?.kind !== 'line') throw new Error('実入力で作った閉じ線がありません');
      profileIds.push(made.id);
    }
    return;
  }
  if (kind === 'circle' || kind === 'arc') {
    if (kind === 'circle') await chooseShapeTool(page, '円');
    else { await sketchTool(page, '選択').click(); await sketchTool(page, '円弧').click(); }
    await fillFields(page, ['10', '10', '0']);
    await popoverInputs(page).first().press('Enter');
    await fillFields(page, kind === 'circle' ? ['3'] : ['3', '0', '180']);
    await popoverInputs(page).first().press('Enter');
    await cancelPopover(page);
    if (kind === 'arc') await drawLine(page, ['7', '10'], ['13', '10']);
    return;
  }
  await chooseShapeTool(page, '楕円');
  await fillFields(page, ['10', '10', '0']); await popoverInputs(page).first().press('Enter');
  await fillFields(page, ['4', '2']); await popoverInputs(page).first().press('Enter');
  await fillFields(page, ['0']);
  if (kind === 'ellipseArc') await popoverToggle(page, '一部だけ(楕円弧)').click();
  await popoverInputs(page).first().press('Enter');
  if (kind === 'ellipseArc') {
    await fillFields(page, ['0', '180']); await popoverInputs(page).first().press('Enter');
  }
  await cancelPopover(page);
  if (kind === 'ellipseArc') await drawLine(page, ['6', '10'], ['14', '10']);
}

/** 通常UIだけで作成・取消・確定・1UndoRedo・保存再開まで通す。 */
export async function cutLifecycleFlow(page: Page, info: TestInfo, kind: CutLifecycleCase,
  app?: ElectronApplication): Promise<void> {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  if (app === undefined) { await disableFilePickers(page); await page.goto('/'); }
  await waitForStartupReady(page);
  await drawRectangle(page, ['0', '0'], ['20', '20']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await extrudeFace(page, '面1', '10');
  await expectVolume(page, '押し出し1', 4000);
  const base = await cutSavedPart(page, info, `${kind}-base`, app);
  const baseIds = new Set(base.sketches.flatMap(sketch => sketch.features.map(feature => feature.id)));
  if (kind !== 'plane') {
    const profileIds: string[] = [];
    await cutCurve(page, kind, info, profileIds, app);
    const drawn = await cutSavedPart(page, info, `${kind}-curves`, app);
    let boundaries = drawn.sketches.flatMap(sketch => sketch.features).filter(feature => !baseIds.has(feature.id));
    if (kind === 'formula') {
      expect(profileIds).toHaveLength(4);
      expect(new Set(profileIds).size).toBe(4);
      boundaries = profileIds.map(id => {
        const feature = drawn.sketches[0].features.find(candidate => candidate.id === id);
        if (feature === undefined) throw new Error('閉輪郭の実入力IDが保存文書にありません');
        return feature;
      });
      expect(boundaries.map(feature => feature.kind)).toEqual(['functionCurve', 'line', 'line', 'line']);
    }
    // 現cutProfileOfは選択したfaceを必要とする。生のarc/ellipseを開いた刃へ誤配送しない。
    await makeFace(page, boundaries.map(feature => feature.name));
  }
  await waitForRecompute(page);
  const before = await cutSavedPart(page, info, `${kind}-before`, app);
  const profileFaces = before.sketches.flatMap(sketch => sketch.features)
    .filter(feature => feature.kind === 'face' && !baseIds.has(feature.id));
  expect(profileFaces).toHaveLength(kind === 'plane' ? 0 : 1);
  const select = async (): Promise<void> => {
    await sketchTool(page, '選択').click(); await solidRow(page, '押し出し1').click();
    for (const face of profileFaces) await treeRow(page, face.name).click({ modifiers: ['Shift'] });
    await openCut(page);
    await chooseCutPlaneKind(page, kind === 'plane' ? 'Z 軸に垂直な面' : '選んだ面・曲線・閉じた輪郭で切る');
    if (kind === 'plane') await popoverField(page, '位置').fill('4');
  };
  for (const cancel of ['escape', 'button'] as const) {
    await select();
    if (kind === 'plane') await waitForCutPreview(page, '平面取消の前', preview => previewPlaneIs(preview, [0, 0, 1], [0, 0, 4]));
    if (cancel === 'escape') await page.locator('canvas.pcad-viewport__canvas').press('Escape');
    else await popover(page).getByRole('button', { name: '取消', exact: true }).click();
    await expect(popover(page)).toHaveCount(0); await expectNoCutPreview(page);
    expect(await cutSavedPart(page, info, `${kind}-cancel-${cancel}`, app)).toEqual(before);
  }
  // 取消による履歴増分0。直前の実作図/押し出しを1Undoし、1Redoで完全復元する。
  let token = await beginRecompute(page); await page.keyboard.press('Control+z'); await waitForRecompute(page, token);
  const undoneCancel = await cutSavedPart(page, info, `${kind}-cancel-undo`, app);
  expect(undoneCancel).not.toEqual(before);
  token = await beginRecompute(page); await page.keyboard.press('Control+y'); await waitForRecompute(page, token);
  expect(await cutSavedPart(page, info, `${kind}-cancel-redo`, app)).toEqual(before);
  await select(); token = await beginRecompute(page); await commitPopover(page); await waitForRecompute(page, token);
  const committed = await cutSavedPart(page, info, `${kind}-committed`, app);
  expect(committed.id).toBe(before.id);
  expect(committed.solids.slice(0, before.solids.length)).toEqual(before.solids);
  const added = committed.solids.slice(before.solids.length);
  expect(added.map(feature => feature.kind)).toEqual(kind === 'plane' ? ['cut'] : ['extrude', 'boolean']);
  const area = kind === 'circle' ? 9 * Math.PI : kind === 'arc' ? 9 * Math.PI / 2
    : kind === 'ellipse' ? 8 * Math.PI : kind === 'ellipseArc' ? 4 * Math.PI : 130 / 3;
  const expected = kind === 'plane' ? 20 * 20 * 6 : 4000 - 10 * area;
  const visible = committed.solids.at(-1);
  if (visible === undefined) throw new Error('画面の切断結果がありません');
  const displayed = await volumeOf(page, visible.name);
  if (kind === 'formula') expect(Math.abs(displayed - expected)).toBeLessThanOrEqual(0.1);
  else expect(Math.abs(displayed - expected) / expected).toBeLessThanOrEqual(1e-9);
  await cutNativeVolume(committed, expected, info, kind === 'formula');
  token = await beginRecompute(page); await page.keyboard.press('Control+z'); await waitForRecompute(page, token);
  expect(await cutSavedPart(page, info, `${kind}-one-undo`, app)).toEqual(before);
  token = await beginRecompute(page); await page.keyboard.press('Control+y'); await waitForRecompute(page, token);
  expect(await cutSavedPart(page, info, `${kind}-redo`, app)).toEqual(committed);
  await openSaveFlowFile(page, info.outputPath(`${kind}-committed.pcad`), app);
  const reopened = await cutSavedPart(page, info, `${kind}-reopened`, app);
  expect(reopened).toEqual(committed);
  await cutNativeVolume(reopened, expected, info, kind === 'formula');
  const resultFeature = committed.solids.at(-1);
  if (resultFeature === undefined) throw new Error('保存した切断結果がありません');
  await solidRow(page, resultFeature.name).click();
  token = await beginRecompute(page);
  await propertyPanel(page).getByRole('switch', {
    name: kind === 'plane' ? '反対側を残す' : '輪郭の内側を残す', exact: true,
  }).click();
  await waitForRecompute(page, token);
  const edited = await cutSavedPart(page, info, `${kind}-edited`, app);
  expect(edited.sketches).toEqual(committed.sketches);
  expect(edited.solids.map(feature => feature.id)).toEqual(committed.solids.map(feature => feature.id));
  await cutNativeVolume(edited, 4000 - expected, info, kind === 'formula');
  token = await beginRecompute(page); await page.keyboard.press('Control+z'); await waitForRecompute(page, token);
  expect(await cutSavedPart(page, info, `${kind}-edit-undo`, app)).toEqual(committed);
  token = await beginRecompute(page); await page.keyboard.press('Control+y'); await waitForRecompute(page, token);
  expect(await cutSavedPart(page, info, `${kind}-edit-redo`, app)).toEqual(edited);
  await openSaveFlowFile(page, info.outputPath(`${kind}-edited.pcad`), app);
  expect(await cutSavedPart(page, info, `${kind}-edit-reopened`, app)).toEqual(edited);
  if (kind === 'formula') {
    const curve = edited.sketches.flatMap(sketch => sketch.features).find(feature => feature.kind === 'functionCurve');
    if (curve?.kind !== 'functionCurve') throw new Error('切断に使った元の関数がありません');
    await treeRow(page, curve.name).click();
    await page.getByRole('button', { name: functionPlotMessage('edit'), exact: true }).click();
    const dialog = page.locator('.pcad-function-dialog');
    await expect(dialog.getByRole('textbox', { name: 'Y =', exact: true })).toHaveValue('X^2/10+1');
    // 両端を保つ独立な式変更。加算面積∫[0,10]X(10-X)/100 dX=5/3、全面積45。
    await dialog.getByRole('textbox', { name: 'Y =', exact: true }).fill('X^2/10+1+X*(10-X)/100');
    await dialog.getByRole('button', { name: functionPlotMessage('preview'), exact: true }).click();
    await expect(dialog.getByRole('button', { name: functionPlotMessage('apply'), exact: true })).toBeEnabled({ timeout: 60_000 });
    token = await beginRecompute(page);
    await dialog.getByRole('button', { name: functionPlotMessage('apply'), exact: true }).click();
    await expect(dialog).toHaveCount(0); await waitForRecompute(page, token);
    const formulaEdited = await cutSavedPart(page, info, 'formula-source-edited', app);
    expect(formulaEdited.solids).toEqual(edited.solids);
    await cutNativeVolume(formulaEdited, 45 * 10, info, true);
    token = await beginRecompute(page); await page.keyboard.press('Control+z'); await waitForRecompute(page, token);
    expect(await cutSavedPart(page, info, 'formula-source-undo', app)).toEqual(edited);
    token = await beginRecompute(page); await page.keyboard.press('Control+y'); await waitForRecompute(page, token);
    expect(await cutSavedPart(page, info, 'formula-source-redo', app)).toEqual(formulaEdited);
    await openSaveFlowFile(page, info.outputPath('formula-source-edited.pcad'), app);
    expect(await cutSavedPart(page, info, 'formula-source-reopened', app)).toEqual(formulaEdited);
    await treeRow(page, curve.name).click();
    await page.getByRole('button', { name: functionPlotMessage('edit'), exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: 'Y =', exact: true })).toHaveValue('X^2/10+1+X*(10-X)/100');
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  }
  expect(errors).toEqual([]);
}
