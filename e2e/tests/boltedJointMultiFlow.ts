/// <reference lib="dom" />
import { statSync } from 'node:fs';
import { watch } from './runtimeErrors.js';
import { expect, test as baseTest, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import {
  chooseToolMenuItem, installAssemblyFileGateway, openToolMenu, readAssemblyStats, resetAssemblyFileGateway, toolMenuPanel,
} from './assemblyTestSupport.js';
import {
  boltedJointDialog, clickWorldPointChecked, componentRows, disableFilePickers, expectVectorClose, fastenedBadges, goHome,
  PICK_TEXT, placeQueuedPart, resolvedPoses, SECOND_PLATE_OFFSET, statusBar, statusText, stepStatus,
} from './boltedJointTestSupport.js';
import { beginRecompute, waitForRecompute, waitForSettledRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import {
  cancelPopover, commitPopover, drawRectangle, extrudeFace, fillFields, makeFace, popover, popoverInputs, popoverTitle,
  propertyPanel, selectionKindLabel, sketchTool, treeRow, type WorldPoint,
} from './solidCaptureSupport.js';

/*
 * ボルト締結をまとめて行う画面検査(J-02 P4)。板は部品の画面の実操作で作って保存し、組立へ 2 回置く
 * (boltedJointFlow.ts と同じ。完成した組立を API で作って注入しない)。
 *
 * 1) 穴 2 つの板(60×30×10、φ9 の貫通穴が (15, 15) と (45, 15) の 1 つの穴のフィーチャー)を 2 枚。
 *    2 つ目の板(y=−50)は締結で −Y 軸まわりに裏返る(boltedJointFlow.ts の実測 [0, −1, 0, 0])ので、x が
 *    鏡に映る: 頭側の (15, 15) と組むのは、相手側の板の部品の x=45 の穴(画面の (45, −35))。
 *    1 組目を鏡の相手でない穴と組むと、2 組目の頭側の穴に同じ軸の相手が無く(自動の対応付けが断る)、断りの行に「穴の組 2」とその組の穴が出る。2 組目からの穴の組み合わせは押した順に依らない(単体 pairBoltedJointHoles.test.ts)。
 * 2) ざぐりの穴(φ9 の貫通、入口 φ14・深さ 5)の板の上面を当てる面に選ぶと、入口が当てる面の側にあるので断る
 *    (入口の向きの照合が実アプリで働く確かめ。頭側の外の面は、ホーム視点から押せない下面なので、通る締結は
 *    model の単体 entryBoltedJointCommand.test.ts が受け持つ)。
 * 3) 締結の後の部品の取り込み直し(J-02 P8)。φ9 の穴 1 つの板を、穴を φ11 に直した板・さらに厚みを 12 に直した板として
 *    部品の画面で保存し直し(同じ部品文書なのでフィーチャーの id はそのまま)、「元の部品を取り込み直す」で 2 枚とも替える
 *    (同じ中身の板 2 枚は 1 つの元部品を共有する)。φ11 は作り直しで M10 になり、元に戻す 1 回で M8 に戻る。厚みが
 *    変わると当てる面が食い込むので、直す窓が理由を出して断る(板を動かして作り直すのは第 3 の版の P8b)。
 * 登録は bolted-joint.spec.ts と electron-bolted-joint.spec.ts(新しい spec を作ると Firefox の対象の正規表現と名簿を
 * 変えることになるため、今ある 2 本に足した)。
 */

const TWO_HOLE_PLATE = { width: 60, depth: 30, thickness: 10, holes: [[15, 15], [45, 15]] as const, diameter: 9 } as const;
const COUNTERBORE_PLATE = { width: 40, depth: 30, thickness: 10, holes: [[20, 15]] as const, diameter: 9 } as const;
const COUNTERBORE = { diameter: 14, depth: 5 } as const;

export interface PlateSpec {
  readonly width: number;
  readonly depth: number;
  readonly thickness: number;
  readonly holes: readonly (readonly [number, number])[];
  readonly diameter: number;
}

/** 穴の軸の上面の点(視線は穴の中を通って奥の内壁に当たる。boltedJointTestSupport.ts の holeWallPoint と同じ考え)。 */
export function wallPoint(offset: readonly [number, number, number], hole: readonly [number, number], topZ: number): WorldPoint {
  return [offset[0] + hole[0], offset[1] + hole[1], offset[2] + topZ];
}

/** 上面で、どの穴からも 12mm 以上離れた点(穴 2 つの板は中央の奥、ざぐりの板は boltedJointTestSupport.ts と同じ)。 */
function topPoint(offset: readonly [number, number, number], spec: PlateSpec): WorldPoint {
  const [x, y] = spec.width === 60 ? [30, 27] : [32, 22];
  return [offset[0] + x, offset[1] + y, offset[2] + spec.thickness];
}

/*
 * ざぐりの穴の下穴の壁を押す点。ホーム視点の視線は水平 2mm ごとに 1mm 下がり、カメラの側 (+X, −Y) から奥へ進む。
 * 軸からカメラの側へ d 寄せた上面の点から入ると、ざぐり(半径 7・深さ 5)の床の高さで軸から 10 − d、下穴の
 * 半径 4.5 の内に入るには 5.5 < d、ざぐりの手前の壁に当たらないには d < 7。間の 6.25 を使う。
 */
const BORE_WALL_IN_COUNTERBORE = 6.25 / Math.SQRT2;
function counterboreWallPoint(offset: readonly [number, number, number]): WorldPoint {
  const [x, y] = COUNTERBORE_PLATE.holes[0];
  return [offset[0] + x + BORE_WALL_IN_COUNTERBORE, offset[1] + y - BORE_WALL_IN_COUNTERBORE, offset[2] + COUNTERBORE_PLATE.thickness];
}

/** 部品の画面で板を作り(長方形→面→押し出し→点→穴)、製品の「保存」で落とした .pcad のバイト列を返す。 */
async function createPlatePartFile(page: Page, info: TestInfo, app: ElectronApplication | undefined, spec: PlateSpec,
  counterbore: typeof COUNTERBORE | null): Promise<Uint8Array> {
  await drawRectangle(page, ['0', '0'], [String(spec.width), String(spec.depth)]);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await extrudeFace(page, '面1', String(spec.thickness));
  await waitForSettledRecompute(page);
  // 点の道具は決定の後も窓が開いたまま続けて入力できる(道具の釦を押し直すと切り替わって閉じる)。全部の点を決めてから閉じる。
  await sketchTool(page, '点').click();
  await expect(popoverTitle(page)).toHaveText('点を作る');
  for (const [index, [x, y]] of spec.holes.entries()) {
    await fillFields(page, [String(x), String(y), '0']);
    await commitPopover(page);
    await expect(treeRow(page, `点${String(index + 1)}`)).toBeVisible();
  }
  await cancelPopover(page);
  await openToolMenu(page, '加工');
  const holeButton = toolMenuPanel(page, '加工').getByRole('button', { name: '穴', exact: true });
  await holeButton.click({ force: true });
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  // 上面の、まだ穴の無い点を押してから、穴の中心の点を全部足す(1 つの穴のフィーチャーに中心が並ぶ)。
  await clickWorldPointChecked(page, [spec.width / 2, spec.depth / 2, spec.thickness]);
  for (const index of spec.holes.keys()) await treeRow(page, `点${String(index + 1)}`).click({ modifiers: ['Shift'] });
  await openToolMenu(page, '加工');
  await expect(holeButton).toBeEnabled();
  await holeButton.click();
  await expect(popoverTitle(page)).toHaveText('穴をあける');
  await popoverInputs(page).first().fill(String(spec.diameter));
  await popover(page).getByRole('switch', { name: '貫通', exact: true }).click();
  if (counterbore !== null) {
    await popover(page).getByRole('group', { name: '入口', exact: true }).getByRole('button', { name: 'ざぐり', exact: true }).click();
    await popover(page).getByLabel('ざぐりの径', { exact: true }).fill(String(counterbore.diameter));
    await popover(page).getByLabel('ざぐりの深さ', { exact: true }).fill(String(counterbore.depth));
  }
  const token = await beginRecompute(page);
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
  await waitForRecompute(page, token);
  await expect(treeRow(page, '穴1')).toBeVisible();
  const bytes = new Uint8Array(await saveFlowFile(page, info.outputPath('plate.pcad'), app));
  await expect(statusText(page)).toHaveText('保存しました');
  expect(bytes.byteLength).toBeGreaterThan(0);
  return bytes;
}

/** 空の部品の画面から始める(ブラウザーはファイルの選択の窓を止めてから開く。Electron は起動した窓のまま)。 */
async function startFromEmptyPart(page: Page, app: ElectronApplication | undefined): Promise<void> {
  if (app === undefined) {
    await disableFilePickers(page);
    await page.goto('/');
  } else {
    expect(page.url()).toBe('app://pointercad/index.html');
  }
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
}

/** 画面の操作だけで、同じ板を 2 枚置いた組立を用意してホーム視点にする(boltedJointFlow.ts の holedPlateAssembly と同じ流れ)。 */
export async function plateAssembly(page: Page, info: TestInfo, app: ElectronApplication | undefined, spec: PlateSpec,
  counterbore: typeof COUNTERBORE | null): Promise<void> {
  await startFromEmptyPart(page, app);
  await assembleTwoPlates(page, await createPlatePartFile(page, info, app, spec, counterbore));
}

/** 新しい組立に、同じ板のファイルを原点と相手側の位置へ 1 枚ずつ置き、ホーム視点にする。 */
async function assembleTwoPlates(page: Page, part: Uint8Array): Promise<void> {
  const token = await beginRecompute(page);
  await chooseToolMenuItem(page, 'ファイルのほかの操作', '新しいアセンブリ');
  await waitForRecompute(page, token);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
  await installAssemblyFileGateway(page, { parts: [{ fileName: '板.pcad', bytes: part }, { fileName: '板.pcad', bytes: part }] });
  await placeQueuedPart(page, ['', '', '']);
  await placeQueuedPart(page, SECOND_PLATE_OFFSET.map(String));
  await expect(componentRows(page)).toHaveCount(2);
  await goHome(page);
}

/** Shift を押したまま、ワールドの点を押す(覆われていないかの確かめは clickWorldPointChecked のまま)。 */
async function shiftClickWorldPoint(page: Page, world: WorldPoint): Promise<void> {
  await page.keyboard.down('Shift');
  try { await clickWorldPointChecked(page, world); } finally { await page.keyboard.up('Shift'); }
}

/** 締結の窓を開き、穴A・当てる面A・穴B・当てる面B を順に選ぶ(各段の状態欄も確かめる)。 */
export async function pickFourFaces(page: Page, holeA: WorldPoint, faceA: WorldPoint, holeB: WorldPoint, faceB: WorldPoint): Promise<void> {
  await chooseToolMenuItem(page, '組む', 'ボルトで締結');
  await expect(boltedJointDialog(page)).toBeVisible();
  const steps: readonly [WorldPoint, string | null][] = [[holeA, stepStatus(2, PICK_TEXT.faceA)], [faceA, stepStatus(3, PICK_TEXT.holeB)],
    [holeB, stepStatus(4, PICK_TEXT.faceB)], [faceB, null]];
  for (const [point, expected] of steps) {
    await clickWorldPointChecked(page, point);
    if (expected !== null) await expect(statusText(page)).toHaveText(expected);
  }
  await expect(statusText(page)).not.toContainText('/4:');
}

export function holeCounts(page: Page): Locator {
  return boltedJointDialog(page).getByTestId('bolted-joint-hole-counts');
}

export function commitButton(page: Page): Locator {
  return boltedJointDialog(page).getByTestId('bolted-joint-commit');
}

export async function clickHistory(page: Page, name: '元に戻す' | 'やり直す'): Promise<void> {
  const token = await beginRecompute(page);
  await page.getByRole('button', { name, exact: true }).click();
  await waitForRecompute(page, token);
}

const ONE_HOLE_PLATE = { width: 40, depth: 30, thickness: 10, holes: [[20, 15]] as const, diameter: 9 } as const;
const EDIT_DIALOG = 'ボルトの締結を直す';
const REBUILD_NOTICE = '部品が替わり、作り直しを待つ締結が 1 件あります。記録した指定で、ボルト・ナット・座金を入れ替えます。';
const FACES_OVERLAP = '当てる面どうしが食い込んでいます。';

/** 右のプロパティの欄(見出しが label と一致する欄の入力。ex18-sew-bracket.spec.ts の同名補助と同じ探し方)。 */
function propertyField(page: Page, label: string): Locator {
  return propertyPanel(page).locator('.pcad-field')
    .filter({ has: page.locator('.pcad-field__label', { hasText: new RegExp(`^${label}$`, 'u') }) })
    .locator('input.pcad-field__input');
}

interface PlateEdit {
  readonly row: string;
  readonly label: string;
  readonly from: string;
  readonly to: string;
  readonly fileName: string;
}

/** 部品の画面に開いたままの板の欄を 1 つ直し、別の名前で保存した .pcad を返す(フィーチャーの id はそのまま)。 */
async function savePlateVariant(page: Page, info: TestInfo, app: ElectronApplication | undefined, edit: PlateEdit): Promise<Uint8Array> {
  await treeRow(page, edit.row).click();
  await expect(propertyField(page, edit.label)).toHaveValue(edit.from);
  const token = await beginRecompute(page);
  await propertyField(page, edit.label).fill(edit.to);
  // 欄から焦点を外して確定する(木の行を押す。ex18-sew-bracket.spec.ts と同じ)。
  await treeRow(page, edit.row).click();
  await waitForRecompute(page, token);
  await expect(propertyField(page, edit.label)).toHaveValue(edit.to);
  const bytes = new Uint8Array(await saveFlowFile(page, info.outputPath(edit.fileName), app));
  await expect(statusText(page)).toHaveText('保存しました');
  return bytes;
}

/** φ9 の穴 1 つの板(組立に置く元)と、穴を φ11 に・厚みを 12 に直した板(差し替える先)を作り、元の板 2 枚の組立にする。 */
async function rebuildPlateAssembly(page: Page, info: TestInfo, app: ElectronApplication | undefined): Promise<{
  readonly wider: Uint8Array; readonly thicker: Uint8Array;
}> {
  await startFromEmptyPart(page, app);
  const part = await createPlatePartFile(page, info, app, ONE_HOLE_PLATE, null);
  const wider = await savePlateVariant(page, info, app, { row: '穴1', label: '直径', from: '9', to: '11', fileName: 'plate-hole-11.pcad' });
  const thicker = await savePlateVariant(page, info, app,
    { row: '押し出し1', label: '距離', from: '10', to: '12', fileName: 'plate-hole-11-thickness-12.pcad' });
  await assembleTwoPlates(page, part);
  return { wider, thicker };
}

function rebuildPanel(page: Page): Locator {
  return page.getByTestId('bolted-joint-rebuild');
}

/** 「締結する」を押し、窓が閉じて計算が終わるまで待つ。 */
async function commitAndWait(page: Page, dialog: Locator): Promise<void> {
  const token = await beginRecompute(page);
  await dialog.getByTestId('bolted-joint-commit').click();
  await expect(dialog).toHaveCount(0);
  await waitForRecompute(page, token);
}

/**
 * 部品の木の 1 行目の「⋮」から「元の部品を取り込み直す」で、ファイル口に入れた板を読む(cylinderSubshapeColdFlow.ts と
 * 同じ操作)。同じ元部品を使う板 2 枚がまとめて替わる。
 */
async function refreshPlates(page: Page, bytes: Uint8Array): Promise<void> {
  const [first, second] = (await readAssemblyStats(page)).components;
  expect(first?.sourceRef).toBe(second?.sourceRef);
  await installAssemblyFileGateway(page, { parts: [{ fileName: '板.pcad', bytes }] });
  const section = page.locator('.pcad-tree__sections > li').filter({
    has: page.locator('.pcad-tree__section .pcad-tree__label', { hasText: /^部品$/u }),
  });
  await section.locator(':scope > .pcad-tree__children > li > .pcad-tree__row .pcad-tree__more').first().click();
  const action = page.locator('.pcad-tree__menu').getByRole('menuitem', { name: '元の部品を取り込み直す', exact: true });
  await expect(action).toHaveAttribute('aria-disabled', 'false');
  const token = await beginRecompute(page);
  await action.click();
  await waitForRecompute(page, token);
}

/** 足した部品(部品の木の 3 行目から。ボルト・ナット)の名前と出どころ。どちらにも呼び(M8 など)が入る。 */
async function hardwareText(page: Page): Promise<string> {
  const stats = await readAssemblyStats(page);
  return stats.components.slice(2).map((component) => `${component.name} ${component.sourceRef}`).join(' / ');
}

const M8_ONLY = /^(?!.*M10).*M8(?!\d)/u;
const M10_ONLY = /^(?!.*M8(?!\d)).*M10/u;

const SET_READY_STATUS = 'ボルトで締結: 2 組の提案を確かめ、Enter か「締結する」でまとめて締結します。Esc でやめます。';
const SECOND_PLATE = { position: [60, 0, 20], rotation: [0, -1, 0, 0] } as const;

/** 締結の後: 板A そのまま、板B は裏返って (60, 0, 20)、ボルトの首下は穴ごとに z=0、ナットの座面は z=20。 */
async function expectTwoJointPoses(page: Page): Promise<void> {
  const poses = await resolvedPoses(page);
  expect(poses).toHaveLength(6);
  const [plateA, plateB, ...hardware] = poses;
  expectVectorClose(plateA?.position ?? [], [0, 0, 0]);
  expectVectorClose(plateB?.position ?? [], SECOND_PLATE.position);
  expectVectorClose((plateB?.rotation ?? []).map(Math.abs), SECOND_PLATE.rotation.map(Math.abs));
  // 足した部品は組ごとに ボルト・ナット の順。組の順は押した順(頭側の (15, 15) が 1 組目)。
  const expected = [[15, 15, 0], [15, 15, 20], [45, 15, 0], [45, 15, 20]];
  hardware.forEach((pose, index) => expectVectorClose(pose.position, expected[index] ?? []));
}

export function registerBoltedJointMultiTests(
  test: typeof baseTest, appForPage: (page: Page) => ElectronApplication | undefined = () => undefined,
): void {
  test.describe('ボルト締結をまとめて行う(J-02 P4)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.afterEach(async ({ page }) => { await resetAssemblyFileGateway(page); });

  test('Shift で穴を足し外しし、押した順を間違えると組の番号と穴で断り、正しい順の 2 組を 1 回で締結・取り消し・保存する', async ({ page }, info) => {
    const seen = watch(page);
    const spec = TWO_HOLE_PLATE, second = SECOND_PLATE_OFFSET, zero = [0, 0, 0] as const;
    const [left, right] = spec.holes;
    await plateAssembly(page, info, appForPage(page), spec, null);
    const before = await resolvedPoses(page);

    // 1) 1 組目の組み違い: (15, 15)↔画面の (15, −35)。1 組目は合うが、(45, 15) と同じ軸の相手が無い。
    await pickFourFaces(page, wallPoint(zero, left, spec.thickness), topPoint(zero, spec),
      wallPoint(second, left, spec.thickness), topPoint(second, spec));
    await expect(statusText(page)).toHaveText('ボルトで締結: 提案を確かめ、Enter か「締結する」で締結します。Esc でやめます。');
    await expect(holeCounts(page)).toHaveText('締結する穴: 頭側 1 ・ 相手側 1');
    await shiftClickWorldPoint(page, wallPoint(zero, right, spec.thickness));
    await expect(holeCounts(page)).toHaveText('締結する穴: 頭側 2 ・ 相手側 1');
    await expect(boltedJointDialog(page).getByTestId('bolted-joint-reasons'))
      .toContainText('締結する穴の組が揃っていません。');
    await expect(commitButton(page)).toBeDisabled();
    await shiftClickWorldPoint(page, wallPoint(second, right, spec.thickness));
    await expect(holeCounts(page)).toHaveText('締結する穴: 頭側 2 ・ 相手側 2');
    const reasons = boltedJointDialog(page).getByTestId('bolted-joint-reasons');
    await expect(reasons.locator('li[data-hole="2"]').first()).toContainText('穴の組 2(頭側 ');
    await expect(reasons.locator('li[data-hole="2"]').first()).toContainText('(45, 15, 5)');
    await expect(statusText(page)).toContainText('ボルトで締結: 穴の組 2: ');
    await expect(statusBar(page)).toHaveClass(/pcad-statusbar--error/u);
    await expect(commitButton(page)).toBeDisabled();
    // 足した穴をもう一度 Shift で押すと外れる。外しても文書は変わらない。
    await shiftClickWorldPoint(page, wallPoint(second, right, spec.thickness));
    await expect(holeCounts(page)).toHaveText('締結する穴: 頭側 2 ・ 相手側 1');
    await page.keyboard.press('Escape');
    await expect(boltedJointDialog(page)).toHaveCount(0);
    await expect(componentRows(page)).toHaveCount(2);
    expect(await resolvedPoses(page)).toEqual(before);

    // 2) 正しい順: 1 組目 (15, 15)↔画面の (45, −35)、2 組目 (45, 15)↔(15, −35)。2 組の提案(六角ボルト)。
    await pickFourFaces(page, wallPoint(zero, left, spec.thickness), topPoint(zero, spec),
      wallPoint(second, right, spec.thickness), topPoint(second, spec));
    await shiftClickWorldPoint(page, wallPoint(zero, right, spec.thickness));
    await shiftClickWorldPoint(page, wallPoint(second, left, spec.thickness));
    await expect(statusText(page)).toHaveText(SET_READY_STATUS);
    await expect(boltedJointDialog(page).getByTestId('bolted-joint-head')).toHaveText('頭の形 六角ボルト');
    await expect(boltedJointDialog(page).getByTestId('bolted-joint-set-row')).toHaveCount(2);
    await expect(commitButton(page)).toBeEnabled();

    // 3) 1 回の確定で 2 組(ボルト・ナット 2 組)を足し、6 部品を互いに固定する。1 回の元に戻すで全部消え、やり直すで戻る。
    const token = await beginRecompute(page);
    await commitButton(page).click();
    await expect(boltedJointDialog(page)).toHaveCount(0);
    await waitForRecompute(page, token);
    await expect(componentRows(page)).toHaveCount(6);
    await expect(fastenedBadges(page)).toHaveCount(6);
    await expectTwoJointPoses(page);
    await clickHistory(page, '元に戻す');
    await expect(componentRows(page)).toHaveCount(2);
    await expect(fastenedBadges(page)).toHaveCount(0);
    expect(await resolvedPoses(page)).toEqual(before);
    await clickHistory(page, 'やり直す');
    await expect(componentRows(page)).toHaveCount(6);
    await expectTwoJointPoses(page);

    // 4) 保存して開き直しても、6 部品と締結の印が同じ。
    await resetAssemblyFileGateway(page);
    const savedPath = info.outputPath('bolted-joint-multi.pcada');
    await saveFlowFile(page, savedPath, appForPage(page));
    expect(statSync(savedPath).size).toBeGreaterThan(0);
    await openSaveFlowFile(page, savedPath, appForPage(page));
    await expect(componentRows(page)).toHaveCount(6);
    await expect(fastenedBadges(page)).toHaveCount(6);
    await expectTwoJointPoses(page);

    expect(seen.dialogs).toEqual([]);
    expect(seen.errors).toEqual([]);
  });

  test('ざぐりの入口が当てる面の側にある穴は、入口の向きの理由で断り、文書を変えない', async ({ page }, info) => {
    const seen = watch(page);
    const spec = COUNTERBORE_PLATE, second = SECOND_PLATE_OFFSET, zero = [0, 0, 0] as const;
    await plateAssembly(page, info, appForPage(page), spec, COUNTERBORE);
    const before = await resolvedPoses(page);
    await pickFourFaces(page, counterboreWallPoint(zero), topPoint(zero, spec), counterboreWallPoint(second), topPoint(second, spec));
    const onFarSide = 'ざぐり・皿もみがボルトを入れる側にありません。頭側の穴と合わせ面を選び直し、入口のある外側から入る組み合わせにしてください。';
    await expect(boltedJointDialog(page).getByTestId('bolted-joint-reasons')).toContainText(onFarSide);
    // 組が 1 つの時は番号を付けない(今までの 1 組の締結の文と同じ形)。
    await expect(statusText(page)).toHaveText(`ボルトで締結: ${onFarSide}`);
    await expect(commitButton(page)).toBeDisabled();
    await boltedJointDialog(page).getByRole('button', { name: '取消', exact: true }).click();
    await expect(boltedJointDialog(page)).toHaveCount(0);
    await expect(componentRows(page)).toHaveCount(2);
    expect(await resolvedPoses(page)).toEqual(before);
    expect(seen.dialogs).toEqual([]);
    expect(seen.errors).toEqual([]);
  });

  test('板を取り込み直すと作り直しを知らせ、作り直すと新しい穴に合うボルトになって 1 回の元に戻すで戻り、厚みが変わった時は理由を出して断る(J-02 P8)',
    async ({ page }, info) => {
      const seen = watch(page);
      const spec = ONE_HOLE_PLATE, second = SECOND_PLATE_OFFSET, zero = [0, 0, 0] as const;
      const [hole] = spec.holes;
      const variants = await rebuildPlateAssembly(page, info, appForPage(page));

      // 1) φ9 の穴の組を締結する(穴径 9 は通し穴の表で M8)。知らせはまだ出ない。
      await pickFourFaces(page, wallPoint(zero, hole, spec.thickness), topPoint(zero, spec),
        wallPoint(second, hole, spec.thickness), topPoint(second, spec));
      await expect(boltedJointDialog(page).getByTestId('bolted-joint-bolt')).toContainText('ボルト M8 ');
      await commitAndWait(page, boltedJointDialog(page));
      await expect(componentRows(page)).toHaveCount(4);
      expect(await hardwareText(page)).toMatch(M8_ONLY);
      await expect(rebuildPanel(page)).toHaveCount(0);

      // 2) 板を φ11 の穴の板に取り込み直すと、作り直しを待つ締結 1 件を知らせる(締結はまだ M8 のまま)。
      await refreshPlates(page, variants.wider);
      await expect(rebuildPanel(page).getByTestId('bolted-joint-rebuild-count')).toHaveText(REBUILD_NOTICE);
      expect(await hardwareText(page)).toMatch(M8_ONLY);

      // 3) 「作り直す」で直す窓が開き、φ11 の穴に合う M10 を提案する。「締結する」で入れ替え、知らせは消える。
      await rebuildPanel(page).getByTestId('bolted-joint-rebuild-start').click();
      const dialog = page.getByRole('dialog', { name: EDIT_DIALOG, exact: true });
      await expect(dialog.getByTestId('bolted-joint-bolt')).toContainText('ボルト M10 ');
      await commitAndWait(page, dialog);
      await expect(componentRows(page)).toHaveCount(4);
      await expect(fastenedBadges(page)).toHaveCount(4);
      expect(await hardwareText(page)).toMatch(M10_ONLY);
      await expect(rebuildPanel(page)).toHaveCount(0);

      // 4) 1 回の元に戻すで M8 に戻り、やり直すで M10 に戻る。
      await clickHistory(page, '元に戻す');
      expect(await hardwareText(page)).toMatch(M8_ONLY);
      await clickHistory(page, 'やり直す');
      expect(await hardwareText(page)).toMatch(M10_ONLY);

      // 5) 厚み 12 の板に取り込み直すと、当てる面が食い込むので、直す窓が理由を出して断り、文書を変えない。
      await refreshPlates(page, variants.thicker);
      await expect(rebuildPanel(page).getByTestId('bolted-joint-rebuild-count')).toHaveText(REBUILD_NOTICE);
      await rebuildPanel(page).getByTestId('bolted-joint-rebuild-start').click();
      await expect(dialog.getByTestId('bolted-joint-reasons')).toContainText(FACES_OVERLAP);
      await expect(dialog.getByTestId('bolted-joint-commit')).toBeDisabled();
      const before = await resolvedPoses(page);
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(await resolvedPoses(page)).toEqual(before);
      expect(await hardwareText(page)).toMatch(M10_ONLY);

      expect(seen.dialogs).toEqual([]);
      expect(seen.errors).toEqual([]);
    });
});
}
