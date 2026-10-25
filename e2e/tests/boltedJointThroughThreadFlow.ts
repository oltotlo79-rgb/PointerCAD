/// <reference lib="dom" />
import { statSync } from 'node:fs';
import { expect, test as baseTest, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import {
  chooseToolMenuItem, installAssemblyFileGateway, openToolMenu, resetAssemblyFileGateway, toolMenuPanel,
} from './assemblyTestSupport.js';
import {
  boltedJointDialog, clickWorldPointChecked, componentRows, disableFilePickers, expectVectorClose, fastenedBadges,
  fileAction, goHome, holeWallPoint, PICK_TEXT, placeQueuedPart, plateTopPoint, READY_STATUS, resolvedPoses,
  SECOND_PLATE_OFFSET, statusBar, statusText, stepStatus, type ComponentPose,
} from './boltedJointTestSupport.js';
import { beginRecompute, waitForRecompute, waitForSettledRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import {
  cancelPopover, commitPopover, drawRectangle, extrudeFace, fillFields, makeFace, popover, popoverInputs, popoverTitle,
  propertyPanel, selectionKindLabel, sketchTool, topFaceCenter, treeRow,
} from './solidCaptureSupport.js';

/*
 * ボルト締結(追加要件6)の、通し穴＋貫通のねじ穴の画面検査。板は 2 枚とも部品の画面の実操作で作って保存し、
 * 組立の「部品を置く」へ渡す(完成した組立や状態を注入しない)。止まりのねじ穴の件(tapped-host-r1)と違い、
 * ねじ部が板の厚さより短い貫通の穴なので、ねじの入口を決める道(bindHoleSelection.ts の threadStartOf:
 * 加工で消えた元のボディの面を、由来で今のボディに選び直す)と、外へ出る長さを通る。
 *
 * 期待は計画の関数から求めず、規格の値から手で出した数を写す:
 * - 頭の側の板 A: 40×30×20、(20,15) に φ9 の貫通穴(M8 の通し穴)。
 * - ねじ穴の側の板 B: 40×30×15、(20,15) に M8 並目の貫通のねじ穴、ねじ部 10(上面=ねじ穴を開けた面から)。
 *   M8 並目のピッチは 1.25(JIS B 0205)、下穴径は D1 = 8 − (5√3/8)·1.25。
 * - 板 B の合わせ面は上面(ねじの入口と同じ面)なので、ねじ部は合わせ面から 0〜10。
 * - 締め付ける厚さは板 A の 20。ねじ込み 8 → 長さは 20 + 0 + 8 = 28 以上。
 * - 本体規格 M8 の推奨呼び長さ(確認済みの抜粋)は 40 から。L=40 のねじ部 b は 22 なので首下の円筒部 18 は 20 の中。
 * - 先端は合わせ面から 40 − 20 = 20。ボルトのねじは先端から 22(合わせ面の手前 2 から)。
 *   穴のねじ部 0〜10 と重なるのは 10。板 B の厚さ 15 を 20 − 15 = 5 突き抜ける。ナットは付かない。
 * - ねじ込み 12 は穴のねじ部 10 より長いので断る。
 *
 * 締結の後: 板 A は原点のまま(置いた時に固定)。板 B は −Y 軸まわり 180° 回り、穴の上面 (20,15,15) が (20,15,20) へ
 * 来る位置 (40, 0, 35)。ボルトの首下は板 A の下面の (20,15,0)。
 */

const CLEARANCE_PLATE_THICKNESS = 20;
const THREADED_PLATE_THICKNESS = 15;
const THREAD_LENGTH = 10;
const M8_COARSE_PITCH = 1.25;
const M8_COARSE_DRILL = 8 - (5 * Math.sqrt(3) * M8_COARSE_PITCH) / 8;

const THROUGH_FASTENED: ComponentPose = { position: [40, 0, 35], rotation: [0, -1, 0, 0] };

/** 締結の窓の文(`packages/ui/src/i18n/ja/assembly.json` の実文を写す)。 */
const REASON = {
  engagementRequired: 'ねじ込み長さを入力してください。',
  engagementExceedsThread: 'ねじ込み長さが穴のねじ部より長くなっています。',
  washerOnTappedSide: 'ねじ穴の側には座金を置けません。',
} as const;

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

function propertyField(page: Page, label: string): Locator {
  return propertyPanel(page).locator('.pcad-field')
    .filter({ has: page.locator('.pcad-field__label', { hasText: new RegExp(`^${label}$`, 'u') }) })
    .locator('input.pcad-field__input');
}

/** 40×30 の板を押し出し、上面の中心の真下 (20,15,0) に点を 1 つ打つ(`boltedJointTestSupport.ts` と同じ手順)。 */
async function plateWithCenterPoint(page: Page, thickness: number): Promise<void> {
  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await extrudeFace(page, '面1', String(thickness));
  await waitForSettledRecompute(page);
  await sketchTool(page, '点').click();
  await expect(popoverTitle(page)).toHaveText('点を作る');
  await fillFields(page, ['20', '15', '0']);
  await commitPopover(page);
  await cancelPopover(page);
  await expect(treeRow(page, '点1')).toBeVisible();
}

/** 加工の道具を押して面を選ぶ段にし、上面→点の順に選んでから押し直して窓を開く。 */
async function openMachiningWindow(page: Page, label: '穴' | 'ねじ穴', thickness: number): Promise<void> {
  await openToolMenu(page, '加工');
  const button = toolMenuPanel(page, '加工').getByRole('button', { name: label, exact: true });
  await button.click({ force: true });
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  await clickWorldPointChecked(page, topFaceCenter(thickness));
  await treeRow(page, '点1').click({ modifiers: ['Shift'] });
  await openToolMenu(page, '加工');
  await expect(button).toBeEnabled();
  await button.click();
}

async function commitAndWait(page: Page): Promise<void> {
  const token = await beginRecompute(page);
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
  await waitForRecompute(page, token);
}

async function savePart(page: Page, info: TestInfo, name: string, app?: ElectronApplication): Promise<Uint8Array> {
  const bytes = new Uint8Array(await saveFlowFile(page, info.outputPath(name), app));
  await expect(statusText(page)).toHaveText('保存しました');
  expect(bytes.byteLength).toBeGreaterThan(0);
  return bytes;
}

/** 板 A(通し穴)。 */
async function createClearancePlate(page: Page, info: TestInfo, app?: ElectronApplication): Promise<Uint8Array> {
  await plateWithCenterPoint(page, CLEARANCE_PLATE_THICKNESS);
  await openMachiningWindow(page, '穴', CLEARANCE_PLATE_THICKNESS);
  await expect(popoverTitle(page)).toHaveText('穴をあける');
  await popoverInputs(page).first().fill('9');
  await popover(page).getByRole('switch', { name: '貫通', exact: true }).click();
  await commitAndWait(page);
  await expect(treeRow(page, '穴1')).toBeVisible();
  return savePart(page, info, 'clearance-plate.pcad', app);
}

/** 板 B(M8 の貫通のねじ穴、ねじ部 10)。呼びは窓の「呼び」の一覧で選ぶ(`threadShaftCaptureFlow.ts` と同じ操作)。 */
async function createThroughThreadPlate(page: Page, info: TestInfo, app?: ElectronApplication): Promise<Uint8Array> {
  await plateWithCenterPoint(page, THREADED_PLATE_THICKNESS);
  await openMachiningWindow(page, 'ねじ穴', THREADED_PLATE_THICKNESS);
  await expect(popoverTitle(page)).toHaveText('ねじ穴をあける');
  const designation = popover(page).locator('.pcad-popover__choice').filter({ hasText: '呼び' });
  await designation.locator('.pcad-menu__trigger').click();
  await designation.getByRole('menuitem', { name: 'M8', exact: true }).click();
  await expect(designation.locator('.pcad-menu__count')).toHaveText('M8');
  await expect(popover(page).locator('.pcad-popover__choice').filter({ hasText: 'ねじの種類' })
    .getByRole('button', { name: '並目', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // ねじ穴の窓の欄は 深さ・ねじ部の長さ の順(numericInput.ts の THREAD_SIZE_FIELDS)。貫通では深さは使わない。
  await fillFields(page, [null, String(THREAD_LENGTH)]);
  await popover(page).getByRole('switch', { name: '貫通', exact: true }).click();
  await commitAndWait(page);
  await expect(treeRow(page, 'ねじ穴1')).toBeVisible();
  await treeRow(page, 'ねじ穴1').click();
  await expect(propertyField(page, 'ピッチ')).toHaveValue(String(M8_COARSE_PITCH));
  expect(Number(await propertyField(page, '下穴径').inputValue())).toBeCloseTo(M8_COARSE_DRILL, 6);
  return savePart(page, info, 'through-thread-plate.pcad', app);
}

/** 画面の操作だけで、通し穴の板(原点・固定)と貫通ねじ穴の板(y=-50)を置いた組立を用意してホーム視点にする。 */
async function throughThreadAssembly(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  if (app === undefined) {
    await disableFilePickers(page);
    await page.goto('/');
  } else {
    expect(page.url()).toBe('app://pointercad/index.html');
  }
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  const clearance = await createClearancePlate(page, info, app);
  await fileAction(page, '新規').click();
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  const threaded = await createThroughThreadPlate(page, info, app);
  const token = await beginRecompute(page);
  await chooseToolMenuItem(page, 'ファイルのほかの操作', '新しいアセンブリ');
  await waitForRecompute(page, token);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
  await installAssemblyFileGateway(page, { parts: [
    { fileName: '通し穴の板.pcad', bytes: clearance }, { fileName: '貫通ねじ穴の板.pcad', bytes: threaded },
  ] });
  await placeQueuedPart(page, ['', '', '']);
  await placeQueuedPart(page, SECOND_PLATE_OFFSET.map(String));
  await expect(componentRows(page)).toHaveCount(2);
  await expect(page.locator('.pcad-tree__badge').filter({ hasText: /^固定$/u })).toHaveCount(1);
  await goHome(page);
}

/** 締結の窓を開き、板 A の穴・上面、板 B のねじ穴・上面の順に選ぶ。 */
async function openAndPickThroughThread(page: Page): Promise<void> {
  await chooseToolMenuItem(page, '組む', 'ボルトで締結');
  await expect(boltedJointDialog(page)).toBeVisible();
  await expect(statusText(page)).toHaveText(stepStatus(1, PICK_TEXT.holeA));
  const steps: readonly [readonly [number, number, number], string | null][] = [
    [holeWallPoint([0, 0, 0], CLEARANCE_PLATE_THICKNESS), stepStatus(2, PICK_TEXT.faceA)],
    [plateTopPoint([0, 0, 0], CLEARANCE_PLATE_THICKNESS), stepStatus(3, PICK_TEXT.holeB)],
    [holeWallPoint(SECOND_PLATE_OFFSET, THREADED_PLATE_THICKNESS), stepStatus(4, PICK_TEXT.faceB)],
    [plateTopPoint(SECOND_PLATE_OFFSET, THREADED_PLATE_THICKNESS), null],
  ];
  for (const [point, expected] of steps) {
    await clickWorldPointChecked(page, point);
    if (expected !== null) await expect(statusText(page)).toHaveText(expected);
  }
  await expect(statusText(page)).not.toContainText('/4:');
}

function dialogField(page: Page, testId: string): Locator {
  return boltedJointDialog(page).getByTestId(testId);
}

function commitButton(page: Page): Locator {
  return dialogField(page, 'bolted-joint-commit');
}

/** 断る時: 理由を窓と状態欄(赤)に出し、「締結する」は押せず、文書は変えない。 */
async function expectRefusal(page: Page, reason: string): Promise<void> {
  await expect(dialogField(page, 'bolted-joint-reasons')).toContainText(reason);
  await expect(statusText(page)).toHaveText(`ボルトで締結: ${reason}`);
  await expect(statusBar(page)).toHaveClass(/pcad-statusbar--error/u);
  await expect(commitButton(page)).toBeDisabled();
  await expect(componentRows(page)).toHaveCount(2);
  await expect(fastenedBadges(page)).toHaveCount(0);
}

async function expectThroughThreadProposal(page: Page): Promise<void> {
  await expect(statusText(page)).toHaveText(READY_STATUS);
  await expect(statusBar(page)).not.toHaveClass(/pcad-statusbar--error/u);
  await expect(dialogField(page, 'bolted-joint-bolt')).toHaveText('ボルト M8 呼び長さ(mm) 40');
  await expect(dialogField(page, 'bolted-joint-nut')).toHaveText('ナットなし(ねじ穴にねじ込みます)');
  await expect(dialogField(page, 'bolted-joint-engaged')).toHaveText('ねじが掛かる長さ(mm) 10');
  await expect(dialogField(page, 'bolted-joint-plan').getByText('外へ出る長さ(mm) 5', { exact: true })).toBeVisible();
  await expect(commitButton(page)).toBeEnabled();
}

/** 締結の後: 板 A そのまま、板 B は −Y 軸まわり 180° で (40,0,35)、ボルトの首下 (20,15,0)。ナットは無い。 */
function expectThroughThreadPoses(poses: readonly ComponentPose[]): void {
  expect(poses).toHaveLength(3);
  const [plateA, plateB, bolt] = poses;
  expectVectorClose(plateA?.position ?? [], [0, 0, 0]);
  expectVectorClose(plateA?.rotation ?? [], [0, 0, 0, 1]);
  expectVectorClose(plateB?.position ?? [], THROUGH_FASTENED.position);
  // 四元数は符号が逆でも同じ向きなので、成分の絶対値で比べる。
  expectVectorClose((plateB?.rotation ?? []).map(Math.abs), THROUGH_FASTENED.rotation.map(Math.abs));
  expectVectorClose(bolt?.position ?? [], [20, 15, 0]);
}

async function clickHistory(page: Page, name: '元に戻す' | 'やり直す'): Promise<void> {
  const token = await beginRecompute(page);
  await page.getByRole('button', { name, exact: true }).click();
  await waitForRecompute(page, token);
}

export function registerBoltedJointThroughThreadTests(
  test: typeof baseTest, appForPage: (page: Page) => ElectronApplication | undefined = () => undefined,
): void {
  test.describe('ボルト締結の貫通ねじ穴(追加要件6)', () => {
    test.use({ viewport: { width: 1440, height: 900 } });
    test.afterEach(async ({ page }) => { await resetAssemblyFileGateway(page); });

    test('通し穴＋貫通のねじ穴: ねじ部より長いねじ込み・ねじ穴側の座金は断り、M8×40 をナットなしで掛かり 10・突き出し 5 で締結し、1 回の Undo/Redo と保存・開き直しで保つ', async ({ page }, info) => {
      const seen = watch(page);
      await throughThreadAssembly(page, info, appForPage(page));
      const before = await resolvedPoses(page);
      await openAndPickThroughThread(page);

      // 1) ねじ込み長さは既定で空。入れるまで締結しない。貫通の穴なので底のすきまは要らない。
      await expect(dialogField(page, 'bolted-joint-engagement')).toHaveValue('');
      await expectRefusal(page, REASON.engagementRequired);
      // 2) ねじ込み 12 は穴のねじ部 10 より長い。
      await dialogField(page, 'bolted-joint-engagement').fill('12');
      await expectRefusal(page, REASON.engagementExceedsThread);
      // 3) ねじ込み 8 で提案(底のすきまは空のまま)。
      await dialogField(page, 'bolted-joint-engagement').fill('8');
      await expect(dialogField(page, 'bolted-joint-bottom')).toHaveValue('');
      await expectThroughThreadProposal(page);
      // 4) ねじ穴の側(ナットの側)に座金を置くと断る。なしに戻すと提案に戻る。
      await boltedJointDialog(page).getByLabel('ナットの側の座金').selectOption('plainWasher');
      await expectRefusal(page, REASON.washerOnTappedSide);
      await boltedJointDialog(page).getByLabel('ナットの側の座金').selectOption('none');
      await expectThroughThreadProposal(page);
      expect(await resolvedPoses(page)).toEqual(before);

      // 5) 「締結する」で、板 B を合わせてボルト 1 本を足し、3 部品を互いに固定する。ナットは足さない。
      const token = await beginRecompute(page);
      await commitButton(page).click();
      await expect(boltedJointDialog(page)).toHaveCount(0);
      await waitForRecompute(page, token);
      await expect(componentRows(page)).toHaveCount(3);
      await expect(fastenedBadges(page)).toHaveCount(3);
      const fastened = await resolvedPoses(page);
      expectThroughThreadPoses(fastened);

      // 6) 1 回の元に戻すで、足したボルト・組・板 B の移動がまとめて戻る。やり直すで同じ締結に戻る。
      await clickHistory(page, '元に戻す');
      await expect(componentRows(page)).toHaveCount(2);
      await expect(fastenedBadges(page)).toHaveCount(0);
      expect(await resolvedPoses(page)).toEqual(before);
      await clickHistory(page, 'やり直す');
      await expect(componentRows(page)).toHaveCount(3);
      await expect(fastenedBadges(page)).toHaveCount(3);
      expectThroughThreadPoses(await resolvedPoses(page));

      // 7) 保存して開き直しても、締結の組(印 3 つ)と配置が同じ。
      await resetAssemblyFileGateway(page);
      const savedPath = info.outputPath('bolted-joint-through-thread.pcada');
      await saveFlowFile(page, savedPath, appForPage(page));
      expect(statSync(savedPath).size).toBeGreaterThan(0);
      await openSaveFlowFile(page, savedPath, appForPage(page));
      await expect(componentRows(page)).toHaveCount(3);
      await expect(fastenedBadges(page)).toHaveCount(3);
      const reopened = await resolvedPoses(page);
      reopened.forEach((pose, index) => {
        expectVectorClose(pose.position, fastened[index]?.position ?? []);
        expectVectorClose(pose.rotation, fastened[index]?.rotation ?? []);
      });

      expect(seen.dialogs).toEqual([]);
      expect(seen.errors).toEqual([]);
    });
  });
}
