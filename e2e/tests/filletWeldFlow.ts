/// <reference lib="dom" />
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { expect, test as baseTest, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readDocumentBundle } from '../../packages/io/src/index.js';
import { chooseToolMenuItem, installAssemblyFileGateway, resetAssemblyFileGateway } from './assemblyTestSupport.js';
import {
  clickWorldPointChecked, componentRows, disableFilePickers, expectVectorClose, fileAction, goHome, placeQueuedPart, resolvedPoses,
  statusBar, statusText, type ComponentPose,
} from './boltedJointTestSupport.js';
import { beginRecompute, waitForRecompute, waitForSettledRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import {
  cancelPopover, commitPopover, drawRectangle, extrudeFace, fillFields, makeFace, popoverTitle, sketchTool, type WorldPoint,
} from './solidCaptureSupport.js';
import { uiMessage } from './uiMessages.js';

/*
 * すみ肉溶接の画面検査(Web と デスクトップで同じ手順)。部品は部品の画面の実操作で作った 60×20×20 の角材 1 つで、
 * 製品の「保存」で落としたバイト列を組立へ 2 回置く(完成した組立や形を API で作って注入しない)。
 *
 *   底の角材: 原点(置いた時に固定)  x 0〜60, y 0〜20, z 0〜20
 *   立つ角材: (0, 14, 20)          x 0〜60, y 14〜34, z 20〜40
 *
 * ホーム視点は +X・−Y・+Z の側から見るので、立つ角材の −Y 側の面(y=14)、その下の辺(y=14, z=20)、底の角材の
 * 上面(z=20)を実際に押して選ぶ。1 つ目の面の外向きの法線 (0,−1,0) × 2 つ目 (0,0,1) = 溶接線の向き (−1,0,0)。
 * 辺の中点 (30,14,20)・長さ 60 から、溶接線の原点は (60,14,20)。脚は底の上面に 6(−Y へ)、立つ面に 8(+Z へ)。
 *
 * 断続のビード: 始点 4、長さ 10・18.5・7.25、間隔 6・9.75 → 区間の始点 4・20・48.25(手で求めた値)。
 *   合計の長さ 35.75、体積 6 × 8 / 2 × 35.75 = 858 mm³。
 *   ビード i の配置の位置 = (60 − 始点, 14, 20) = (56,14,20)・(40,14,20)・(11.75,14,20)。
 *   向きは列 x→(0,−1,0)、y→(0,0,1)、z→(−1,0,0) の回転 = 四元数 (½, −½, −½, ½)(符号は問わない)。
 * 部品表の質量(実カーネルの体積 × 密度、小数 2 桁): 角材 2 個 24000 mm³ × 2 × 7.85e-3 = 376.80 g(鋼)、
 *   ビード 24 × 長さ × 2.68e-3: 10 → 0.6432 → 0.64 g、18.5 → 1.18992 → 1.19 g、7.25 → 0.46632 → 0.47 g(アルミ)。
 */

export const BLOCK = { width: 60, depth: 20, height: 20 } as const;
export const STANDING_OFFSET = [0, 14, 20] as const;
const WELD_ORIGIN: WorldPoint = [60, 14, 20];
const STATIONS = [4, 20, 48.25] as const;
const LENGTHS = [10, 18.5, 7.25] as const;
const WELD_ROTATION = [0.5, -0.5, -0.5, 0.5] as const;

/** 選ぶ点(ワールド座標、ホーム視点で見える側)。 */
export const PICK = {
  /** 立つ角材の −Y 側の面の中ほど。 */
  standingFace: [30, 14, 30] as WorldPoint,
  /** 立つ角材の下の辺の中点(頂点から 30 mm 離れ、頂点に吸われない)。 */
  edge: [30, 14, 20] as WorldPoint,
  /** 底の角材の上面の、立つ角材より手前。 */
  baseTop: [30, 5, 20] as WorldPoint,
  /** 2 本目のビード(x 21.5〜40)の斜面上の点: (14 − 11)/6 + (24 − 20)/8 = 1。 */
  secondBeadSlope: [30.75, 11, 24] as WorldPoint,
} as const;

export const TITLE = 'すみ肉溶接';
export const EDIT_TITLE = 'すみ肉溶接を直す';
const GUIDE = {
  firstFace: '1 つ目の部品の、ビードが沿う平らな面を選んでください(例: 立板の側面)。',
  edge: '同じ部品の、2 つ目の部品に当たる直線の辺を選んでください。',
  // 円筒の当たりを足した時に製品の文言が変わり、写しが古くなった(2 つ目は平面か全周の円筒面)。製品の正本から読む。
  secondFace: uiMessage('assembly', 'assembly.filletWeld.pickSecondFace'),
} as const;
const READY = 'すみ肉溶接: 予告を確かめ、Enter か「溶接する」で溶接します。Esc でやめます。';

function step(count: number, next: string): string {
  return `すみ肉溶接 ${String(count)}/3: ${next} Esc でやめます。`;
}

function issue(reason: string): string {
  return `すみ肉溶接: ${reason}`;
}

export function weldDialog(page: Page, title = TITLE): Locator {
  return page.getByRole('dialog', { name: title, exact: true });
}

export function field(page: Page, testId: string, title = TITLE): Locator {
  return weldDialog(page, title).getByTestId(testId);
}

interface Watch {
  readonly errors: string[];
  readonly dialogs: string[];
}

function watch(page: Page): Watch {
  const errors: string[] = [];
  const dialogs: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  return { errors, dialogs };
}

/** 部品の画面で角材を作り、製品の「保存」で落とした .pcad のバイト列を返す(`createHoledPlatePartFile` と同じ手順)。 */
async function createBlockPartFile(page: Page, info: TestInfo, app?: ElectronApplication): Promise<Uint8Array> {
  await drawRectangle(page, ['0', '0'], [String(BLOCK.width), String(BLOCK.depth)]);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await extrudeFace(page, '面1', String(BLOCK.height));
  await waitForSettledRecompute(page);
  const bytes = new Uint8Array(await saveFlowFile(page, info.outputPath('weld-block.pcad'), app));
  await expect(statusText(page)).toHaveText('保存しました');
  expect(bytes.byteLength).toBeGreaterThan(0);
  return bytes;
}

/** 画面の操作だけで、角材 2 つを置いた組立を用意してホーム視点にする(受入の検査 filletWeldAcceptFlow.ts も使う)。 */
export async function blockAssembly(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  if (app === undefined) {
    await disableFilePickers(page);
    await page.goto('/');
  } else {
    expect(page.url()).toBe('app://pointercad/index.html');
  }
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  const part = await createBlockPartFile(page, info, app);
  const token = await beginRecompute(page);
  await chooseToolMenuItem(page, 'ファイルのほかの操作', '新しいアセンブリ');
  await waitForRecompute(page, token);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
  await installAssemblyFileGateway(page, { parts: [
    { fileName: '角材.pcad', bytes: part }, { fileName: '角材.pcad', bytes: part },
  ] });
  await placeQueuedPart(page, ['', '', '']);
  await placeQueuedPart(page, STANDING_OFFSET.map(String));
  await expect(componentRows(page)).toHaveCount(2);
  await expect(page.locator('.pcad-tree__badge').filter({ hasText: /^固定$/u })).toHaveCount(1);
  await goHome(page);
}

/** 溶接の窓を開き、面・辺・面を実際に押して選ぶ。各段で状態欄の何番目と次に選ぶものを確かめる。 */
export async function openAndPick(page: Page): Promise<void> {
  await chooseToolMenuItem(page, '組む', TITLE);
  await expect(weldDialog(page)).toBeVisible();
  await expect(statusText(page)).toHaveText(step(1, GUIDE.firstFace));
  await clickWorldPointChecked(page, PICK.standingFace);
  await expect(statusText(page)).toHaveText(step(2, GUIDE.edge));
  await clickWorldPointChecked(page, PICK.edge);
  await expect(statusText(page)).toHaveText(step(3, GUIDE.secondFace));
  await clickWorldPointChecked(page, PICK.baseTop);
  await expect(statusText(page)).not.toContainText('/3:');
  await expect(field(page, 'fillet-weld-prompt')).toHaveText('面と辺を選びました。脚長・区間・材質を入力してください。');
}

export interface WeldInput {
  readonly legOnSecond: string;
  readonly legOnFirst: string;
  readonly start: string;
  readonly lengths: string;
  readonly gaps: string;
  readonly material: string;
}

export const INPUT: WeldInput = { legOnSecond: '6', legOnFirst: '8', start: '4', lengths: '10, 18.5, 7.25', gaps: '6, 9.75', material: 'aluminum' };

export async function fillWeld(page: Page, input: WeldInput, title = TITLE): Promise<void> {
  await field(page, 'fillet-weld-leg-second', title).fill(input.legOnSecond);
  await field(page, 'fillet-weld-leg-first', title).fill(input.legOnFirst);
  await field(page, 'fillet-weld-mode', title).selectOption('intermittent');
  await field(page, 'fillet-weld-start', title).fill(input.start);
  await field(page, 'fillet-weld-lengths', title).fill(input.lengths);
  await field(page, 'fillet-weld-gaps', title).fill(input.gaps);
  await field(page, 'fillet-weld-material', title).selectOption(input.material);
}

/** 予告の体積の欄の見出し。円筒の当たりの弧の断面を足した時に文言が変わり写しが古くなったので、製品の正本から読む。 */
export const VOLUME_LABEL = uiMessage('assembly', 'assembly.filletWeld.nominalVolume');

/** 予告が溶接できる状態: 手で求めた脚長・ビードの数・合計の長さ・体積。 */
export async function expectReady(page: Page, total: string, volume: string, title = TITLE): Promise<void> {
  await expect(statusText(page)).toHaveText(READY);
  await expect(statusBar(page)).not.toHaveClass(/pcad-statusbar--error/u);
  await expect(field(page, 'fillet-weld-legs', title)).toHaveText('脚長(mm) 6 / 8');
  await expect(field(page, 'fillet-weld-segments', title)).toHaveText('ビードの数 3');
  await expect(field(page, 'fillet-weld-total', title)).toHaveText(`合計の長さ(mm) ${total}`);
  await expect(field(page, 'fillet-weld-volume', title)).toHaveText(`${VOLUME_LABEL} ${volume}`);
  await expect(field(page, 'fillet-weld-commit', title)).toBeEnabled();
}

async function expectRefused(page: Page, status: string): Promise<void> {
  await expect(statusText(page)).toHaveText(status);
  await expect(statusBar(page)).toHaveClass(/pcad-statusbar--error/u);
  await expect(field(page, 'fillet-weld-commit')).toBeDisabled();
}

/**
 * 合成イベントで変換中のキーと暗黙の送信を検査する(締結の画面検査と同じ規約)。実 OS の IME を操作した証拠では
 * ない。欄でもビューでも、変換中の Enter・Esc と変換確定のキー(keyCode 229・Process)は確定もやめもしない。
 */
async function syntheticCompositionKeys(page: Page, testId: string): Promise<void> {
  await field(page, testId).evaluate((input) => {
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'あ' }));
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', isComposing: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape', isComposing: true }));
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
    const form = input.closest('form');
    if (form === null) throw new Error('fillet weld form missing');
    form.requestSubmit();
    for (const properties of [
      { key: 'Enter', keyCode: 229 }, { key: 'Escape', keyCode: 229 }, { key: 'Process', keyCode: 0 },
    ]) {
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, isComposing: false, ...properties }));
      form.requestSubmit();
    }
  });
  const canvas = page.locator('canvas.pcad-viewport__canvas');
  await canvas.dispatchEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true });
  await canvas.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
  for (const properties of [
    { key: 'Enter', keyCode: 229 }, { key: 'Escape', keyCode: 229 }, { key: 'Process', keyCode: 0 },
  ]) await canvas.dispatchEvent('keydown', { isComposing: false, bubbles: true, cancelable: true, ...properties });
}

async function clickHistory(page: Page, name: '元に戻す' | 'やり直す'): Promise<void> {
  const token = await beginRecompute(page);
  await page.getByRole('button', { name, exact: true }).click();
  await waitForRecompute(page, token);
}

function expectQuaternionUpToSign(actual: readonly number[], expected: readonly number[]): void {
  const sign = (actual[3] ?? 0) * (expected[3] ?? 0) < 0 ? -1 : 1;
  expectVectorClose(actual.map((value) => value * sign), expected);
}

/** 溶接の後の配置: 角材 2 つはそのまま、ビード 3 つは溶接線の上の手で求めた位置と向き。 */
function expectWeldedPoses(poses: readonly ComponentPose[], lengths: readonly number[]): void {
  expect(poses).toHaveLength(2 + lengths.length);
  expectVectorClose(poses[0]?.position ?? [], [0, 0, 0]);
  expectVectorClose(poses[1]?.position ?? [], [...STANDING_OFFSET]);
  STATIONS.forEach((station, index) => {
    const bead = poses[2 + index];
    expectVectorClose(bead?.position ?? [], [WELD_ORIGIN[0] - station, WELD_ORIGIN[1], WELD_ORIGIN[2]]);
    expectQuaternionUpToSign(bead?.rotation ?? [], WELD_ROTATION);
  });
}

export function bomRows(page: Page): Locator {
  return page.locator('.pcad-bom__table tbody tr.pcad-bom__row');
}

/**
 * 部品表は組立のプロパティ区画に常に描かれる(`AssemblyPropertyPanel` の `BomTable`、`steelBendFlow.ts` も押さずに読む)。
 * ツールバーの「部品表」は選択を ['bom'] に替えるので、ビードを選んだ状態を消さないよう押さない。
 */
async function showBom(page: Page): Promise<void> {
  await expect(page.locator('.pcad-bom__table')).toBeVisible();
}

/** 部品表: 角材 1 行(2 個・鋼)とビードの長さごとの行(アルミ)。質量は実カーネルの体積から。 */
async function expectBom(page: Page, beads: readonly (readonly [string, string])[]): Promise<void> {
  await showBom(page);
  await expect(bomRows(page)).toHaveCount(1 + beads.length);
  const blocks = bomRows(page).filter({ hasText: '376.80 g' });
  await expect(blocks).toHaveCount(1);
  await expect(blocks).toContainText('鋼(SS400)');
  await expect(blocks.locator('td').nth(2)).toHaveText('2');
  for (const [length, mass] of beads) {
    const row = bomRows(page).filter({ hasText: `すみ肉溶接 6×8 長さ${length}` });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(mass);
    await expect(row).toContainText('アルミ(A5052)');
  }
}

/** 保存したファイルを製品の読取りで開き、ビードの台本(脚長・区間・材質)を手で求めた値と比べる。 */
async function expectSavedBeads(path: string, lengths: readonly string[]): Promise<void> {
  const read = await readDocumentBundle(await readFile(path), 'assembly');
  if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('saved weld assembly did not decode');
  const beads = read.bundle.document.components.filter((component) =>
    component.source.kind === 'standardPart' && component.source.catalog === 'filletWeld');
  expect(beads).toHaveLength(lengths.length);
  beads.forEach((bead, index) => {
    if (bead.source.kind !== 'standardPart') throw new Error('bead source changed');
    expect(bead.source.size).toBe('6x8');
    expect(bead.source.options.length).toBe(lengths[index]);
    expect(bead.source.options.weldStation).toBe(String(STATIONS[index]));
    expect(bead.source.options.weldSegment).toBe(String(index));
    expect(Number(bead.source.options.contactLength)).toBeCloseTo(60, 9);
    expect(bead.materialId).toBe('aluminum');
  });
}

/*
 * 斜めの当たり(内角 120°)。底は上と同じ角材(原点、x 0〜60, y 0〜20, z 0〜20)。もう 1 つは部品の画面の線分の道具で
 * 描いた平行四辺形(部品の座標で (0,0) → (−10, −10√3) → (10, −10√3) → (20, 0) → (0,0)、長方形と同じ反時計回り)を
 * 20 押し出した斜めの材で、(10, 0, 0) に置く(置く窓は位置だけで回転を持たないので、角度は部品の形で作る)。
 *
 *   斜めの材: x 0〜30・y −10√3〜0・z 0〜20。面 y=0 の x 10〜30 が角材の面 y=0 に当たる。
 *   右の斜めの面 (30,0)→(20,−10√3) の外向きの法線 a = (√3/2, −1/2, 0)、角材の面 y=0 の法線 b = (0,−1,0)。
 *   a·b = 1/2 → 内角 θ = acos(−1/2) = 120°。ホーム視点(+X・−Y・+Z の側)から両方の面が見える。
 *   座標系: x = a − (a·b)b を単位に = (1,0,0)、y = b = (0,−1,0)、z = x × y = (0,0,−1)。
 *   縦の辺 (30,0,0)〜(30,0,20) の中点 (30,0,10)・長さ 20 → 溶接線の原点 (30,0,20)。
 *
 * 断続のビード: 始点 1.5、長さ 4・6.5・3、間隔 2・2.25 → 区間の始点 1.5・7.5・16.25(16.25 + 3 = 19.25 ≤ 20)。
 *   断面 (0,0)・(6,0)・(8 cos 120°, 8 sin 120°) = (−4, 4√3)、面積 6 × 8 × sin 120° / 2 = 12√3。
 *   合計 13.5、体積 162√3 ≈ 280.5922 → 窓は小数 3 桁で 280.592。3 本目を 3.5 に直すと合計 14、168√3 ≈ 290.9845 → 290.985。
 *   ビード i の位置 = (30, 0, 20 − 始点) = (30,0,18.5)・(30,0,12.5)・(30,0,3.75)。向き: 局所 x→(1,0,0)、y→(0,−1,0)、
 *   z→(0,0,−1)(四元数の符号に依らないよう、軸を回して比べる)。
 *   組立の座標の断面: 角 (30,0)、角材の上の脚の先 (36,0)、斜めの面の上の脚の先 (26, −4√3)。
 * 部品表(実カーネルの体積 × 密度、小数 2 桁): 角材 24000 × 7.85e-3 = 188.40 g、斜めの材 200√3 × 20 = 4000√3 ≈ 6928.20 mm³
 *   × 7.85e-3 ≈ 54.386 → 54.39 g(鋼)。ビード 12√3 × 長さ × 2.68e-3: 4 → 0.2228 → 0.22 g、6.5 → 0.3621 → 0.36 g、
 *   3 → 0.1671 → 0.17 g、3.5 → 0.1950 → 0.19 g(アルミ)。
 */
const SQRT3 = Math.sqrt(3);
const SLANT_OFFSET = [10, 0, 0] as const;
const SLANT_STATIONS = [1.5, 7.5, 16.25] as const;
const SLANT_INPUT: WeldInput = { legOnSecond: '6', legOnFirst: '8', start: '1.5', lengths: '4, 6.5, 3', gaps: '2, 2.25', material: 'aluminum' };
const SLANT_AXES: readonly [WorldPoint, WorldPoint, WorldPoint] = [[1, 0, 0], [0, -1, 0], [0, 0, -1]];
const SLANT_ANGLE = '面の間の角度(°) 120';

/** 選ぶ点(ワールド座標、ホーム視点で見える側)。 */
const SLANT_PICK = {
  /** 斜めの面の、角から 12 離れた中ほど: (30,0) + 12 × (−1/2, −√3/2)。 */
  slantedFace: [24, -6 * SQRT3, 10] as WorldPoint,
  /** 斜めの材の縦の辺の中点(上下の頂点から 10 mm 離れ、頂点に吸われない)。 */
  edge: [30, 0, 10] as WorldPoint,
  /** 角材の面 y=0 の、ビードの足元(x 30〜36)より右。 */
  blockFace: [45, 0, 10] as WorldPoint,
  /** 2 本目のビード(z 6〜12.5)の斜面 (36,0)〜(26,−4√3) の中点。 */
  secondBeadSlope: [31, -2 * SQRT3, 9.25] as WorldPoint,
} as const;

/** 保存した「新規」へ切り替え、線分の道具で平行四辺形を描いて押し出し、製品の「保存」で落としたバイト列を返す。 */
async function createSlantedPartFile(page: Page, info: TestInfo, app?: ElectronApplication): Promise<Uint8Array> {
  await fileAction(page, '新規').click();
  await expect(page.locator('.pcad-panel--left')).toContainText('まだ何もありません。');
  await sketchTool(page, '線分').click();
  await expect(popoverTitle(page)).toHaveText('線分の始点');
  await fillFields(page, ['0', '0', '0']);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('線分の終点');
  // 終点の欄は前の点からの差(drawRectangle と同じ)。4 本目で始点へ戻る(√3 の項は同じ式なので打ち消し合う)。
  for (const [dx, dy] of [['-10', '-10*√3'], ['20', '0'], ['10', '10*√3'], ['-20', '0']] as const) {
    await fillFields(page, [dx, dy, '0']);
    await commitPopover(page);
  }
  await cancelPopover(page);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await extrudeFace(page, '面1', '20');
  await waitForSettledRecompute(page);
  const bytes = new Uint8Array(await saveFlowFile(page, info.outputPath('weld-slanted.pcad'), app));
  await expect(statusText(page)).toHaveText('保存しました');
  expect(bytes.byteLength).toBeGreaterThan(0);
  return bytes;
}

/** 画面の操作だけで、角材と斜めの材を置いた組立を用意してホーム視点にする。 */
async function slantedAssembly(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  if (app === undefined) {
    await disableFilePickers(page);
    await page.goto('/');
  } else {
    expect(page.url()).toBe('app://pointercad/index.html');
  }
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  const block = await createBlockPartFile(page, info, app);
  const slanted = await createSlantedPartFile(page, info, app);
  const token = await beginRecompute(page);
  await chooseToolMenuItem(page, 'ファイルのほかの操作', '新しいアセンブリ');
  await waitForRecompute(page, token);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
  await installAssemblyFileGateway(page, { parts: [
    { fileName: '角材.pcad', bytes: block }, { fileName: '斜め材.pcad', bytes: slanted },
  ] });
  await placeQueuedPart(page, ['', '', '']);
  await placeQueuedPart(page, SLANT_OFFSET.map(String));
  await expect(componentRows(page)).toHaveCount(2);
  await goHome(page);
}

/** 四元数 [x, y, z, w] でベクトルを回す(v' = v + w t + q × t、t = 2 q × v)。 */
function rotateByQuaternion(rotation: readonly number[], vector: WorldPoint): WorldPoint {
  const [x = 0, y = 0, z = 0, w = 1] = rotation;
  const t: WorldPoint = [2 * (y * vector[2] - z * vector[1]), 2 * (z * vector[0] - x * vector[2]), 2 * (x * vector[1] - y * vector[0])];
  return [
    vector[0] + w * t[0] + (y * t[2] - z * t[1]),
    vector[1] + w * t[1] + (z * t[0] - x * t[2]),
    vector[2] + w * t[2] + (x * t[1] - y * t[0]),
  ];
}

/** 溶接の後の配置: 角材と斜めの材はそのまま、ビード 3 つは溶接線の上の手で求めた位置と軸の向き。 */
function expectSlantedPoses(poses: readonly ComponentPose[]): void {
  expect(poses).toHaveLength(2 + SLANT_STATIONS.length);
  expectVectorClose(poses[0]?.position ?? [], [0, 0, 0]);
  expectVectorClose(poses[1]?.position ?? [], [...SLANT_OFFSET]);
  SLANT_STATIONS.forEach((station, index) => {
    const bead = poses[2 + index];
    expectVectorClose(bead?.position ?? [], [30, 0, 20 - station]);
    const units: readonly WorldPoint[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    units.forEach((unit, axis) => expectVectorClose(rotateByQuaternion(bead?.rotation ?? [], unit), SLANT_AXES[axis] ?? [Number.NaN]));
  });
}

/** 部品表: 角材 1 行・斜めの材 1 行(各 1 個・鋼)とビードの長さごとの行(アルミ、名前に内角)。 */
async function expectSlantedBom(page: Page, beads: readonly (readonly [string, string])[]): Promise<void> {
  await showBom(page);
  await expect(bomRows(page)).toHaveCount(2 + beads.length);
  for (const mass of ['188.40 g', '54.39 g']) {
    const row = bomRows(page).filter({ hasText: mass });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('鋼(SS400)');
    await expect(row.locator('td').nth(2)).toHaveText('1');
  }
  for (const [length, mass] of beads) {
    const row = bomRows(page).filter({ hasText: `すみ肉溶接 6×8 120° 長さ${length}` });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(mass);
    await expect(row).toContainText('アルミ(A5052)');
  }
}

/** 保存したファイルを製品の読取りで開き、斜めのビードの台本(脚長・区間・内角・版・材質)を手で求めた値と比べる。 */
async function expectSavedSlantedBeads(path: string, lengths: readonly string[]): Promise<void> {
  const read = await readDocumentBundle(await readFile(path), 'assembly');
  if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('saved weld assembly did not decode');
  const beads = read.bundle.document.components.filter((component) =>
    component.source.kind === 'standardPart' && component.source.catalog === 'filletWeld');
  expect(beads).toHaveLength(lengths.length);
  beads.forEach((bead, index) => {
    if (bead.source.kind !== 'standardPart') throw new Error('bead source changed');
    expect(bead.source.size).toBe('6x8');
    expect(bead.source.generatorRevision).toBe('fillet-weld-2');
    expect(Number(bead.source.options.weldAngle)).toBeCloseTo(120, 9);
    expect(bead.source.options.length).toBe(lengths[index]);
    expect(bead.source.options.weldStation).toBe(String(SLANT_STATIONS[index]));
    expect(bead.source.options.weldSegment).toBe(String(index));
    expect(Number(bead.source.options.contactLength)).toBeCloseTo(20, 9);
    expect(bead.materialId).toBe('aluminum');
  });
}

/** 斜めのビードを選んで開いた「直す」窓が、保存した値(区間・材質・内角・寸法・体積)を出す。 */
async function expectSlantedEditValues(page: Page, lengths: string, total: string, volume: string): Promise<void> {
  await expect(weldDialog(page, EDIT_TITLE)).toBeVisible();
  await expect(field(page, 'fillet-weld-leg-second', EDIT_TITLE)).toHaveValue('6');
  await expect(field(page, 'fillet-weld-leg-first', EDIT_TITLE)).toHaveValue('8');
  await expect(field(page, 'fillet-weld-mode', EDIT_TITLE)).toHaveValue('intermittent');
  await expect(field(page, 'fillet-weld-start', EDIT_TITLE)).toHaveValue('1.5');
  await expect(field(page, 'fillet-weld-lengths', EDIT_TITLE)).toHaveValue(lengths);
  await expect(field(page, 'fillet-weld-gaps', EDIT_TITLE)).toHaveValue('2, 2.25');
  await expect(field(page, 'fillet-weld-material', EDIT_TITLE)).toHaveValue('aluminum');
  await expectReady(page, total, volume, EDIT_TITLE);
  await expect(field(page, 'fillet-weld-angle', EDIT_TITLE)).toHaveText(SLANT_ANGLE);
}

export function registerFilletWeldTests(
  test: typeof baseTest, appForPage: (page: Page) => ElectronApplication | undefined = () => undefined,
): void {
  test.describe('すみ肉溶接', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.afterEach(async ({ page }) => { await resetAssemblyFileGateway(page); });

  test('面・辺・面の選び方・状態欄の案内・入力の誤り・日本語入力中のキー・Esc では文書を変えない', async ({ page }, info) => {
    const seen = watch(page);
    await blockAssembly(page, info, appForPage(page));
    const before = await resolvedPoses(page);

    // 1) 道具を開くと 1/3。欄に焦点があり、変換でない Esc でやめる。文書は変わらない。
    await chooseToolMenuItem(page, '組む', TITLE);
    await expect(weldDialog(page)).toBeVisible();
    await expect(statusText(page)).toHaveText(step(1, GUIDE.firstFace));
    await field(page, 'fillet-weld-leg-second').press('Escape');
    await expect(weldDialog(page)).toHaveCount(0);
    await expect(componentRows(page)).toHaveCount(2);

    // 2) 1 つ目の面の後に別の部品(底)の辺を押しても数は進まない。同じ部品の辺で 3/3。2 つ目の面に同じ部品の面を
    //    押しても進まない。底の上面で選び終える。
    await chooseToolMenuItem(page, '組む', TITLE);
    await clickWorldPointChecked(page, PICK.standingFace);
    await expect(statusText(page)).toHaveText(step(2, GUIDE.edge));
    await clickWorldPointChecked(page, [30, 0, 20]);
    await expect(statusText(page)).toHaveText(step(2, GUIDE.edge));
    await clickWorldPointChecked(page, PICK.edge);
    await expect(statusText(page)).toHaveText(step(3, GUIDE.secondFace));
    await clickWorldPointChecked(page, PICK.standingFace);
    await expect(statusText(page)).toHaveText(step(3, GUIDE.secondFace));
    await clickWorldPointChecked(page, PICK.baseTop);
    await expect(field(page, 'fillet-weld-prompt')).toHaveText('面と辺を選びました。脚長・区間・材質を入力してください。');

    // 3) 入力の誤りは赤い状態欄と押せない「溶接する」。脚長が空 → 間隔の数違い → 重なり → はみ出し → 壊れた式 → 材質なし。
    await expectRefused(page, issue('2 つ目の面に沿う脚長を数か式で入力してください。'));
    await fillWeld(page, { ...INPUT, gaps: '6' });
    await expectRefused(page, issue('間隔はビードの長さより 1 つ少なく並べてください。'));
    await field(page, 'fillet-weld-gaps').fill('-1, 9.75');
    await expectRefused(page, issue('ビードどうしが重なっています。間隔を広げてください。'));
    await field(page, 'fillet-weld-gaps').fill(INPUT.gaps);
    await field(page, 'fillet-weld-lengths').fill('10, 18.5, 20');
    await expectRefused(page, issue('ビードが当たりの辺からはみ出します。始点か長さを短くしてください。'));
    await field(page, 'fillet-weld-lengths').fill('10, 1/, 7.25');
    await expectRefused(page, issue('ビードの長さを数か式で入力してください。'));
    await field(page, 'fillet-weld-lengths').fill(INPUT.lengths);
    await field(page, 'fillet-weld-material').selectOption('');
    await expectRefused(page, issue('材質を選んでください(溶加材の材質は仮定しません)。'));
    await field(page, 'fillet-weld-material').selectOption(INPUT.material);
    await expectReady(page, '35.75', '858');

    // 4) 変換中のキー(合成イベント)は確定もやめもしない。
    await syntheticCompositionKeys(page, 'fillet-weld-lengths');
    await expect(weldDialog(page)).toBeVisible();
    await expect(componentRows(page)).toHaveCount(2);
    await expectReady(page, '35.75', '858');

    // 5) 欄で変換でない Esc を押すとやめる。部品も配置も変わらない。
    await field(page, 'fillet-weld-lengths').press('Escape');
    await expect(weldDialog(page)).toHaveCount(0);
    await expect(componentRows(page)).toHaveCount(2);
    expect(await resolvedPoses(page)).toEqual(before);

    expect(seen.dialogs).toEqual([]);
    expect(seen.errors).toEqual([]);
  });

  test('欄の Enter で溶接し、ビードを選んで直し、1 回の Undo/Redo で戻せて、保存と開き直しで寸法・材質・形を保つ', async ({ page }, info) => {
    const seen = watch(page);
    const app = appForPage(page);
    await blockAssembly(page, info, app);
    const before = await resolvedPoses(page);
    await openAndPick(page);
    await fillWeld(page, INPUT);
    await expectReady(page, '35.75', '858');

    // 1) 変換を確定したキーの後でも、次の通常の Enter は 1 回だけ溶接する。ビード 3 つが足される。
    await syntheticCompositionKeys(page, 'fillet-weld-lengths');
    await expect(componentRows(page)).toHaveCount(2);
    let token = await beginRecompute(page);
    await field(page, 'fillet-weld-lengths').press('Enter');
    await expect(weldDialog(page)).toHaveCount(0);
    await waitForRecompute(page, token);
    await expect(componentRows(page)).toHaveCount(5);
    const welded = await resolvedPoses(page);
    expectWeldedPoses(welded, LENGTHS);
    await expectBom(page, [['10', '0.64 g'], ['18.5', '1.19 g'], ['7.25', '0.47 g']]);

    // 2) 2 本目のビードの斜面をビューで押して選ぶ(描いた形に当たる)。溶接の道具を選ぶと、その溶接の保存した
    //    値で「直す」窓が開く(選択を消してから始めると新しい空の溶接になる不具合の回帰)。
    await clickWorldPointChecked(page, PICK.secondBeadSlope);
    await expect(componentRows(page).nth(3)).toHaveAttribute('aria-pressed', 'true');
    await chooseToolMenuItem(page, '組む', TITLE);
    await expect(weldDialog(page, EDIT_TITLE)).toBeVisible();
    await expect(field(page, 'fillet-weld-leg-second', EDIT_TITLE)).toHaveValue('6');
    await expect(field(page, 'fillet-weld-leg-first', EDIT_TITLE)).toHaveValue('8');
    await expect(field(page, 'fillet-weld-mode', EDIT_TITLE)).toHaveValue('intermittent');
    await expect(field(page, 'fillet-weld-start', EDIT_TITLE)).toHaveValue('4');
    await expect(field(page, 'fillet-weld-lengths', EDIT_TITLE)).toHaveValue('10, 18.5, 7.25');
    await expect(field(page, 'fillet-weld-gaps', EDIT_TITLE)).toHaveValue('6, 9.75');
    await expect(field(page, 'fillet-weld-material', EDIT_TITLE)).toHaveValue('aluminum');
    await expectReady(page, '35.75', '858', EDIT_TITLE);

    // 3) 3 本目を 9 に延ばして(48.25 + 9 = 57.25 ≤ 60)「溶接する」を押す。合計 37.5、体積 900。
    await field(page, 'fillet-weld-lengths', EDIT_TITLE).fill('10, 18.5, 9');
    await expectReady(page, '37.5', '900', EDIT_TITLE);
    // 下端の時間軸(z-index 2、窓より後に描く)が出ていても、窓の「溶接する」の中心の一番上は押すボタン自身
    // (窓を締結の窓と同じ z-index 3 にした修正の回帰。重なれば押したつもりで時間軸を押す)。
    const commit = field(page, 'fillet-weld-commit', EDIT_TITLE);
    await expect(page.locator('.pcad-assembly-motion')).toBeVisible();
    await commit.scrollIntoViewIfNeeded();
    await expect.poll(() => commit.evaluate((button) => {
      const box = button.getBoundingClientRect();
      const target = button.ownerDocument.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return target !== null && button.contains(target);
    })).toBe(true);
    token = await beginRecompute(page);
    await commit.click();
    await expect(weldDialog(page, EDIT_TITLE)).toHaveCount(0);
    await waitForRecompute(page, token);
    await expect(componentRows(page)).toHaveCount(5);
    const edited = await resolvedPoses(page);
    expectWeldedPoses(edited, [10, 18.5, 9]);
    await expectBom(page, [['10', '0.64 g'], ['18.5', '1.19 g'], ['9', '0.58 g']]);

    // 4) 元に戻す 1 回で直す前、もう 1 回で溶接の前。やり直すで同じ順に戻る。
    await clickHistory(page, '元に戻す');
    expect(await resolvedPoses(page)).toEqual(welded);
    await expectBom(page, [['10', '0.64 g'], ['18.5', '1.19 g'], ['7.25', '0.47 g']]);
    await clickHistory(page, '元に戻す');
    await expect(componentRows(page)).toHaveCount(2);
    expect(await resolvedPoses(page)).toEqual(before);
    await clickHistory(page, 'やり直す');
    expect(await resolvedPoses(page)).toEqual(welded);
    await clickHistory(page, 'やり直す');
    expect(await resolvedPoses(page)).toEqual(edited);

    // 5) 保存して開き直す。台本(脚長・区間・材質)・配置・部品表の質量が同じで、ビードの形をビューで押して選べる。
    await resetAssemblyFileGateway(page);
    const savedPath = info.outputPath('fillet-weld.pcada');
    await saveFlowFile(page, savedPath, app);
    expect(statSync(savedPath).size).toBeGreaterThan(0);
    await expectSavedBeads(savedPath, ['10', '18.5', '9']);
    await openSaveFlowFile(page, savedPath, app);
    await expect(componentRows(page)).toHaveCount(5);
    const reopened = await resolvedPoses(page);
    reopened.forEach((pose, index) => {
      expectVectorClose(pose.position, edited[index]?.position ?? []);
      expectVectorClose(pose.rotation, edited[index]?.rotation ?? []);
    });
    await expectBom(page, [['10', '0.64 g'], ['18.5', '1.19 g'], ['9', '0.58 g']]);
    await goHome(page);
    await clickWorldPointChecked(page, PICK.secondBeadSlope);
    await expect(componentRows(page).nth(3)).toHaveAttribute('aria-pressed', 'true');
    await chooseToolMenuItem(page, '組む', TITLE);
    await expect(field(page, 'fillet-weld-lengths', EDIT_TITLE)).toHaveValue('10, 18.5, 9');
    await expect(field(page, 'fillet-weld-material', EDIT_TITLE)).toHaveValue('aluminum');
    await field(page, 'fillet-weld-lengths', EDIT_TITLE).press('Escape');
    await expect(weldDialog(page, EDIT_TITLE)).toHaveCount(0);
    await expect(componentRows(page)).toHaveCount(5);

    expect(seen.dialogs).toEqual([]);
    expect(seen.errors).toEqual([]);
  });

  test('内角 120° の斜めの当たり: 線分で描いた斜めの材へ溶接し、描いたビードを選んで直し、保存と開き直しで角度・寸法・体積を保つ', async ({ page }, info) => {
    const seen = watch(page);
    const app = appForPage(page);
    await slantedAssembly(page, info, app);

    // 1) 斜めの面・その縦の辺・角材の面 y=0 を実際に押して選ぶ。予告は内角 120°、合計 13.5、体積 162√3。
    await chooseToolMenuItem(page, '組む', TITLE);
    await expect(weldDialog(page)).toBeVisible();
    await expect(statusText(page)).toHaveText(step(1, GUIDE.firstFace));
    await clickWorldPointChecked(page, SLANT_PICK.slantedFace);
    await expect(statusText(page)).toHaveText(step(2, GUIDE.edge));
    await clickWorldPointChecked(page, SLANT_PICK.edge);
    await expect(statusText(page)).toHaveText(step(3, GUIDE.secondFace));
    await clickWorldPointChecked(page, SLANT_PICK.blockFace);
    await expect(statusText(page)).not.toContainText('/3:');
    await expect(field(page, 'fillet-weld-prompt')).toHaveText('面と辺を選びました。脚長・区間・材質を入力してください。');
    await fillWeld(page, SLANT_INPUT);
    await expectReady(page, '13.5', '280.592');
    await expect(field(page, 'fillet-weld-angle')).toHaveText(SLANT_ANGLE);

    // 2) 「溶接する」でビード 3 つが手で求めた位置・向きに足され、部品表の質量は実カーネルの体積から。
    let token = await beginRecompute(page);
    await field(page, 'fillet-weld-commit').click();
    await expect(weldDialog(page)).toHaveCount(0);
    await waitForRecompute(page, token);
    await expect(componentRows(page)).toHaveCount(5);
    expectSlantedPoses(await resolvedPoses(page));
    await expectSlantedBom(page, [['4', '0.22 g'], ['6.5', '0.36 g'], ['3', '0.17 g']]);

    // 3) 描いた 2 本目のビードの斜面をビューで押して選び、溶接の道具で保存した値の「直す」窓を開く。
    await clickWorldPointChecked(page, SLANT_PICK.secondBeadSlope);
    await expect(componentRows(page).nth(3)).toHaveAttribute('aria-pressed', 'true');
    await chooseToolMenuItem(page, '組む', TITLE);
    await expectSlantedEditValues(page, '4, 6.5, 3', '13.5', '280.592');

    // 4) 3 本目を 3.5 に延ばして(16.25 + 3.5 = 19.75 ≤ 20)「溶接する」。内角はそのまま、合計 14、体積 168√3。
    await field(page, 'fillet-weld-lengths', EDIT_TITLE).fill('4, 6.5, 3.5');
    await expectReady(page, '14', '290.985', EDIT_TITLE);
    await expect(field(page, 'fillet-weld-angle', EDIT_TITLE)).toHaveText(SLANT_ANGLE);
    token = await beginRecompute(page);
    await field(page, 'fillet-weld-commit', EDIT_TITLE).click();
    await expect(weldDialog(page, EDIT_TITLE)).toHaveCount(0);
    await waitForRecompute(page, token);
    await expect(componentRows(page)).toHaveCount(5);
    const edited = await resolvedPoses(page);
    expectSlantedPoses(edited);
    await expectSlantedBom(page, [['4', '0.22 g'], ['6.5', '0.36 g'], ['3.5', '0.19 g']]);

    // 5) 保存して開き直す。台本(内角・版・脚長・区間・材質)・配置・部品表が同じで、描いたビードを押して選び直せ、
    //    「直す」窓が内角と寸法・体積を出す。
    await resetAssemblyFileGateway(page);
    const savedPath = info.outputPath('fillet-weld-120.pcada');
    await saveFlowFile(page, savedPath, app);
    expect(statSync(savedPath).size).toBeGreaterThan(0);
    await expectSavedSlantedBeads(savedPath, ['4', '6.5', '3.5']);
    await openSaveFlowFile(page, savedPath, app);
    await expect(componentRows(page)).toHaveCount(5);
    const reopened = await resolvedPoses(page);
    expectSlantedPoses(reopened);
    reopened.forEach((pose, index) => {
      expectVectorClose(pose.position, edited[index]?.position ?? []);
      expectVectorClose(pose.rotation, edited[index]?.rotation ?? []);
    });
    await expectSlantedBom(page, [['4', '0.22 g'], ['6.5', '0.36 g'], ['3.5', '0.19 g']]);
    await goHome(page);
    await clickWorldPointChecked(page, SLANT_PICK.secondBeadSlope);
    await expect(componentRows(page).nth(3)).toHaveAttribute('aria-pressed', 'true');
    await chooseToolMenuItem(page, '組む', TITLE);
    await expectSlantedEditValues(page, '4, 6.5, 3.5', '14', '290.985');
    await field(page, 'fillet-weld-lengths', EDIT_TITLE).press('Escape');
    await expect(weldDialog(page, EDIT_TITLE)).toHaveCount(0);
    await expect(componentRows(page)).toHaveCount(5);

    expect(seen.dialogs).toEqual([]);
    expect(seen.errors).toEqual([]);
  });
});
}
