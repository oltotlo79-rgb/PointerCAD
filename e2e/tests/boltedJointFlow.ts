/// <reference lib="dom" />
import { statSync } from 'node:fs';
import { expect, test as baseTest, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { chooseToolMenuItem, installAssemblyFileGateway, resetAssemblyFileGateway } from './assemblyTestSupport.js';
import {
  boltedJointDialog, clickWorldPointChecked, componentRows, createHoledPlatePartFile, disableFilePickers,
  expectVectorClose, fastenedBadges, goHome, holeWallPoint, homeViewPagePoint, openAndPickFourFaces,
  PICK_TEXT, placeQueuedPart, plateTopPoint, READY_STATUS, resolvedPoses, SECOND_PLATE_OFFSET, selectComponent,
  statusBar, statusText, stepStatus, type ComponentPose,
} from './boltedJointTestSupport.js';
import { beginRecompute, waitForRecompute, waitForSettledRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';

/*
 * ボルト締結(追加要件6)の機能の画面検査。穴付きの板は部品の画面で作って保存し、組立へ 2 回置く。
 * 1 つ目の板(原点、置いた時に固定)と 2 つ目の板(y=-50)の、穴の内側の面と上面を順に選ぶ。
 * 2 つ目は反対向きの最小回転で裏返り、上面どうしが接して穴の軸が一致する位置 (40, 0, 20) へ動く。
 * 締め付け 20mm・本体規格 M8 ナット mMax 6.8・突き出し 0 → 26.8 以上の推奨長さの最小 40 を提案する。
 */

interface Watch {
  readonly errors: string[];
  readonly dialogs: string[];
}

function watch(page: Page): Watch {
  const errors: string[] = [];
  const dialogs: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  // 確認の窓が出たら記録して閉じる(出ないはずなので、最後に空であることを確かめる)。
  page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  return { errors, dialogs };
}

/** 画面の操作だけで、穴付きの板 2 枚を置いた組立を用意してホーム視点にする(受入の検査 boltedJointAcceptFlow.ts も使う)。 */
export async function holedPlateAssembly(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  if (app === undefined) {
    await disableFilePickers(page);
    await page.goto('/');
  } else {
    expect(page.url()).toBe('app://pointercad/index.html');
  }
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  const part = await createHoledPlatePartFile(page, info, app);
  const token = await beginRecompute(page);
  await chooseToolMenuItem(page, 'ファイルのほかの操作', '新しいアセンブリ');
  await waitForRecompute(page, token);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
  await installAssemblyFileGateway(page, { parts: [
    { fileName: '穴付きの板.pcad', bytes: part }, { fileName: '穴付きの板.pcad', bytes: part },
  ] });
  await placeQueuedPart(page, ['', '', '']);
  await placeQueuedPart(page, SECOND_PLATE_OFFSET.map(String));
  await expect(componentRows(page)).toHaveCount(2);
  await expect(page.locator('.pcad-tree__badge').filter({ hasText: /^固定$/u })).toHaveCount(1);
  await goHome(page);
}

function protrusionField(page: Page): Locator {
  return boltedJointDialog(page).getByTestId('bolted-joint-protrusion');
}

function commitButton(page: Page): Locator {
  return boltedJointDialog(page).getByTestId('bolted-joint-commit');
}

async function expectReadyProposal(page: Page): Promise<void> {
  await expect(statusText(page)).toHaveText(READY_STATUS);
  await expect(statusBar(page)).not.toHaveClass(/pcad-statusbar--error/u);
  await expect(boltedJointDialog(page).getByTestId('bolted-joint-bolt')).toHaveText('ボルト M8 呼び長さ(mm) 40');
  await expect(boltedJointDialog(page).getByTestId('bolted-joint-nut')).toHaveText('ナット M8');
  await expect(commitButton(page)).toBeEnabled();
}

/** 合成イベントで変換キーと暗黙submitを検査する。実OSのIMEを操作した証拠ではない。 */
async function composingEnterAndEscape(page: Page): Promise<void> {
  await protrusionField(page).evaluate((input) => {
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'あ' }));
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', isComposing: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape', isComposing: true }));
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
    const form = input.closest('form');
    if (form === null) throw new Error('bolted joint form missing');
    // Even after compositionend the confirming Enter must not implicitly commit.
    form.requestSubmit();
    for (const properties of [
      { key: 'Enter', keyCode: 229 }, { key: 'Escape', keyCode: 229 }, { key: 'Process', keyCode: 0 },
    ]) {
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true,
        isComposing: false, ...properties }));
      form.requestSubmit();
    }
  });
  await page.locator('canvas.pcad-viewport__canvas').dispatchEvent('keydown',
    { key: 'Escape', isComposing: true, bubbles: true, cancelable: true });
  await page.locator('canvas.pcad-viewport__canvas').dispatchEvent('keydown',
    { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
  for (const properties of [
    { key: 'Enter', keyCode: 229 }, { key: 'Escape', keyCode: 229 }, { key: 'Process', keyCode: 0 },
  ]) await page.locator('canvas.pcad-viewport__canvas').dispatchEvent('keydown',
    { isComposing: false, bubbles: true, cancelable: true, ...properties });
}

async function clickHistory(page: Page, name: '元に戻す' | 'やり直す'): Promise<void> {
  const token = await beginRecompute(page);
  await page.getByRole('button', { name, exact: true }).click();
  await waitForRecompute(page, token);
}

const SECOND_FASTENED: ComponentPose = { position: [40, 0, 20], rotation: [0, -1, 0, 0] };

/** 締結の後の配置: 板A そのまま、板B は −Y 軸まわり 180° で (40,0,20)、ボルトの首下 (20,15,0)、ナットの座面 (20,15,20)。 */
function expectFastenedPoses(poses: readonly ComponentPose[]): void {
  expect(poses).toHaveLength(4);
  const [plateA, plateB, bolt, nut] = poses;
  expectVectorClose(plateA?.position ?? [], [0, 0, 0]);
  expectVectorClose(plateA?.rotation ?? [], [0, 0, 0, 1]);
  expectVectorClose(plateB?.position ?? [], SECOND_FASTENED.position);
  // 四元数は符号が逆でも同じ向きなので、成分の絶対値で比べる。
  expectVectorClose((plateB?.rotation ?? []).map(Math.abs), SECOND_FASTENED.rotation.map(Math.abs));
  expectVectorClose(bolt?.position ?? [], [20, 15, 0]);
  expectVectorClose(nut?.position ?? [], [20, 15, 20]);
}

async function dragWorldPoint(page: Page, world: readonly [number, number, number], dx: number): Promise<void> {
  await waitForSettledRecompute(page);
  const [x, y] = await homeViewPagePoint(page, world);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  await page.mouse.up();
}

function displacement(after: ComponentPose, before: ComponentPose): number[] {
  return after.position.map((value, axis) => value - (before.position[axis] ?? Number.NaN));
}

export function registerBoltedJointTests(
  test: typeof baseTest, appForPage: (page: Page) => ElectronApplication | undefined = () => undefined,
): void {
  test.describe('ボルト締結(追加要件6)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.afterEach(async ({ page }) => { await resetAssemblyFileGateway(page); });

  test('4 面の選び方・状態欄の案内・取消・日本語入力中のキー・数値の誤り・不適合・古い選択では文書を変えない', async ({ page }, info) => {
    const seen = watch(page);
    await holedPlateAssembly(page, info, appForPage(page));
    const before = await resolvedPoses(page);

    // 1) 道具を開く。新しい締結の画面の既定は本体規格・並目。状態欄は 1/4 と最初に選ぶ面。
    await chooseToolMenuItem(page, '組む', 'ボルトで締結');
    await expect(boltedJointDialog(page)).toBeVisible();
    await expect(boltedJointDialog(page).locator('select').first()).toHaveValue('main');
    await expect(statusText(page)).toHaveText(stepStatus(1, PICK_TEXT.holeA));

    // 2) 穴A を選ぶと 2/4。次に別の部品(板B)の面を押しても、穴と当てる面は同じ部品からなので数は進まない。
    await clickWorldPointChecked(page, holeWallPoint([0, 0, 0]));
    await expect(statusText(page)).toHaveText(stepStatus(2, PICK_TEXT.faceA));
    await clickWorldPointChecked(page, plateTopPoint(SECOND_PLATE_OFFSET));
    await expect(statusText(page)).toHaveText(stepStatus(2, PICK_TEXT.faceA));

    // 3) ビューに焦点がある時、変換中の Esc は打ちかけをやめない。変換でない Esc はやめ、文書は変えない。
    await page.locator('canvas.pcad-viewport__canvas').dispatchEvent('keydown',
      { key: 'Escape', isComposing: true, bubbles: true, cancelable: true });
    await expect(boltedJointDialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(boltedJointDialog(page)).toHaveCount(0);
    await expect(statusText(page)).not.toContainText('ボルトで締結');
    await expect(componentRows(page)).toHaveCount(2);

    // 4) 開き直して 4 面を選ぶ。穴径 9 は通し穴の表で M8 だけに当たり、M8×40 とナットを提案する。
    await openAndPickFourFaces(page);
    await expectReadyProposal(page);

    // 5) 長さの欄の誤り(負の数・壊れた式)は赤い状態欄と押せない「締結する」。0 に戻すと提案に戻る。
    for (const source of ['-1', '1/']) {
      await protrusionField(page).fill(source);
      await expect(statusText(page)).toHaveText('ボルトで締結: 長さの欄を 0 以上の数か式にしてください。');
      await expect(statusBar(page)).toHaveClass(/pcad-statusbar--error/u);
      await expect(commitButton(page)).toBeDisabled();
    }
    await protrusionField(page).fill('0');
    await expectReadyProposal(page);

    // 6) 不適合: 穴より太い M10 を指定すると理由を窓と状態欄に出し、締結できない。自動に戻すと提案に戻る。
    await boltedJointDialog(page).getByTestId('bolted-joint-nominal').selectOption('M10');
    await expect(boltedJointDialog(page).getByTestId('bolted-joint-reasons')).toContainText('穴がボルトの径より大きくありません。');
    await expect(statusText(page)).toHaveText('ボルトで締結: 穴がボルトの径より大きくありません。');
    await expect(commitButton(page)).toBeDisabled();
    await boltedJointDialog(page).getByTestId('bolted-joint-nominal').selectOption('');
    await expectReadyProposal(page);

    // 7) 変換中の Enter・Esc(欄とビューの両方)は確定もやめもしない。
    await composingEnterAndEscape(page);
    await expect(boltedJointDialog(page)).toBeVisible();
    await expect(componentRows(page)).toHaveCount(2);
    await expectReadyProposal(page);

    // 8) 欄で変換でない Esc を押すとやめる。文書・配置は変わらない。
    await protrusionField(page).press('Escape');
    await expect(boltedJointDialog(page)).toHaveCount(0);
    await expect(componentRows(page)).toHaveCount(2);
    await expect(fastenedBadges(page)).toHaveCount(0);
    expect(await resolvedPoses(page)).toEqual(before);

    // 9) 古い選択: 選んだ後に文書が変わると(ここでは元に戻す)、打ちかけは捨てられ、前の選択で締結しない。
    await chooseToolMenuItem(page, '組む', 'ボルトで締結');
    await clickWorldPointChecked(page, holeWallPoint([0, 0, 0]));
    await expect(statusText(page)).toHaveText(stepStatus(2, PICK_TEXT.faceA));
    await clickHistory(page, '元に戻す');
    await expect(boltedJointDialog(page)).toHaveCount(0);
    await expect(componentRows(page)).toHaveCount(1);
    await clickHistory(page, 'やり直す');
    await expect(componentRows(page)).toHaveCount(2);
    await chooseToolMenuItem(page, '組む', 'ボルトで締結');
    await expect(statusText(page)).toHaveText(stepStatus(1, PICK_TEXT.holeA));
    await boltedJointDialog(page).getByRole('button', { name: 'やめる', exact: true }).click();
    await expect(boltedJointDialog(page)).toHaveCount(0);
    await expect(fastenedBadges(page)).toHaveCount(0);

    expect(seen.dialogs).toEqual([]);
    expect(seen.errors).toEqual([]);
  });

  test('欄の Enter で確定し、1 回の Undo/Redo で戻せて、保存と開き直しで締結の組と配置を保つ', async ({ page }, info) => {
    const seen = watch(page);
    await holedPlateAssembly(page, info, appForPage(page));
    const before = await resolvedPoses(page);
    await openAndPickFourFaces(page);
    await expectReadyProposal(page);

    // 変換を確定したキーの後でも、次の通常 Enter は本来の締結を一度だけ行う。
    await composingEnterAndEscape(page);
    await expect(boltedJointDialog(page)).toBeVisible();
    await expect(componentRows(page)).toHaveCount(2);
    expect(await resolvedPoses(page)).toEqual(before);
    // 1) 欄で Enter(変換でない)を押すと、板B を合わせ、ボルトとナットを足して 4 部品を互いに固定する。
    const token = await beginRecompute(page);
    await protrusionField(page).press('Enter');
    await expect(boltedJointDialog(page)).toHaveCount(0);
    await waitForRecompute(page, token);
    await expect(componentRows(page)).toHaveCount(4);
    await expect(fastenedBadges(page)).toHaveCount(4);
    await expect(statusText(page)).not.toContainText('ボルトで締結');
    const fastened = await resolvedPoses(page);
    expectFastenedPoses(fastened);

    // 2) 1 回の元に戻すで、足した部品・組・板B の移動がまとめて戻る。やり直すで同じ締結に戻る。
    await clickHistory(page, '元に戻す');
    await expect(componentRows(page)).toHaveCount(2);
    await expect(fastenedBadges(page)).toHaveCount(0);
    expect(await resolvedPoses(page)).toEqual(before);
    // Explicit pointer and keyboard button activation must still work after composition.
    for (const activation of ['pointer', 'keyboard'] as const) {
      await openAndPickFourFaces(page);
      await expectReadyProposal(page);
      await composingEnterAndEscape(page);
      await expect(boltedJointDialog(page)).toBeVisible();
      await expect(componentRows(page)).toHaveCount(2);
      const activated = await beginRecompute(page);
      if (activation === 'pointer') {
        // The persistent timeline must remain visible while the foreground form receives the click.
        await expect(page.locator('.pcad-assembly-motion')).toBeVisible();
        await commitButton(page).scrollIntoViewIfNeeded();
        await expect.poll(() => commitButton(page).evaluate((button) => {
          const box = button.getBoundingClientRect();
          const target = button.ownerDocument.elementFromPoint(
            box.left + box.width / 2, box.top + box.height / 2);
          return target !== null && button.contains(target);
        })).toBe(true);
        await commitButton(page).click();
      }
      else { await commitButton(page).focus(); await commitButton(page).press('Space'); }
      await expect(boltedJointDialog(page)).toHaveCount(0);
      await waitForRecompute(page, activated);
      await expect(componentRows(page)).toHaveCount(4);
      await expect(fastenedBadges(page)).toHaveCount(4);
      expectFastenedPoses(await resolvedPoses(page));
      await clickHistory(page, '元に戻す');
      await expect(componentRows(page)).toHaveCount(2);
      await expect(fastenedBadges(page)).toHaveCount(0);
      expect(await resolvedPoses(page)).toEqual(before);
    }
    await clickHistory(page, 'やり直す');
    await expect(componentRows(page)).toHaveCount(4);
    await expect(fastenedBadges(page)).toHaveCount(4);
    expectFastenedPoses(await resolvedPoses(page));

    // 3) 保存して開き直しても、締結の組(印 4 つ)と配置が同じ。
    await resetAssemblyFileGateway(page);
    const savedPath = info.outputPath('bolted-joint.pcada');
    await saveFlowFile(page, savedPath, appForPage(page));
    expect(statSync(savedPath).size).toBeGreaterThan(0);
    await openSaveFlowFile(page, savedPath, appForPage(page));
    await expect(componentRows(page)).toHaveCount(4);
    await expect(fastenedBadges(page)).toHaveCount(4);
    const reopened = await resolvedPoses(page);
    reopened.forEach((pose, index) => {
      expectVectorClose(pose.position, fastened[index]?.position ?? []);
      expectVectorClose(pose.rotation, fastened[index]?.rotation ?? []);
    });

    expect(seen.dialogs).toEqual([]);
    expect(seen.errors).toEqual([]);
  });

  test('ビューの Enter で確定し、固定の組は動かず、固定を外すと組ごと動き、締結を外すと 1 部品だけ動く', async ({ page }, info) => {
    const seen = watch(page);
    await holedPlateAssembly(page, info, appForPage(page));
    await openAndPickFourFaces(page);
    await expectReadyProposal(page);

    // 1) 最後に面を押したビューに焦点がある。ビューで Enter を押すと予告どおり締結する。
    const token = await beginRecompute(page);
    await page.keyboard.press('Enter');
    await expect(boltedJointDialog(page)).toHaveCount(0);
    await waitForRecompute(page, token);
    await expect(fastenedBadges(page)).toHaveCount(4);
    const fastened = await resolvedPoses(page);
    expectFastenedPoses(fastened);

    // 2) 板A が固定なので組全体が動かない。板B(上面 z=20)を引っぱっても配置は変わらない。
    const plateBTop = plateTopPoint([0, 0, 0], 20);
    await dragWorldPoint(page, plateBTop, 80);
    await waitForSettledRecompute(page);
    expect(await resolvedPoses(page)).toEqual(fastened);

    // 3) 板A の固定を外し、板B を引っぱると、組の 4 部品が同じ変位で動き、向きは変わらない。
    await selectComponent(page, 0);
    let history = await beginRecompute(page);
    await chooseToolMenuItem(page, '組む', '固定を解除する');
    await waitForRecompute(page, history);
    await expect(page.locator('.pcad-tree__badge').filter({ hasText: /^固定$/u })).toHaveCount(0);
    await dragWorldPoint(page, plateBTop, 80);
    await expect.poll(async () => (await resolvedPoses(page))[1]?.position)
      .not.toEqual(fastened[1]?.position);
    await waitForSettledRecompute(page);
    const moved = await resolvedPoses(page);
    const delta = displacement(moved[1] ?? fastened[1] ?? SECOND_FASTENED, fastened[1] ?? SECOND_FASTENED);
    expect(Math.hypot(...delta)).toBeGreaterThan(1);
    moved.forEach((pose, index) => {
      const start = fastened[index];
      if (start === undefined) throw new Error(`${String(index)} 番目の部品の締結後の配置がありません。`);
      expectVectorClose(displacement(pose, start), delta, 4);
      expectVectorClose(pose.rotation, start.rotation, 6);
    });

    // 4) 板B を選んで「締結を外す」。組の印が消え、配置は変わらない。1 回の元に戻すで組に戻る。
    await selectComponent(page, 1);
    history = await beginRecompute(page);
    await chooseToolMenuItem(page, '組む', '締結を外す');
    await waitForRecompute(page, history);
    await expect(fastenedBadges(page)).toHaveCount(0);
    expect(await resolvedPoses(page)).toEqual(moved);
    await clickHistory(page, '元に戻す');
    await expect(fastenedBadges(page)).toHaveCount(4);
    await clickHistory(page, 'やり直す');
    await expect(fastenedBadges(page)).toHaveCount(0);

    // 5) 解いた後は板B だけが動き、板A・ボルト・ナットは動かない。
    const released = await resolvedPoses(page);
    const plateBTopNow: readonly [number, number, number] = [
      plateBTop[0] + delta[0], plateBTop[1] + delta[1], plateBTop[2] + delta[2]];
    await dragWorldPoint(page, plateBTopNow, 60);
    await expect.poll(async () => (await resolvedPoses(page))[1]?.position)
      .not.toEqual(released[1]?.position);
    await waitForSettledRecompute(page);
    const after = await resolvedPoses(page);
    for (const index of [0, 2, 3]) expect(after[index]).toEqual(released[index]);

    expect(seen.dialogs).toEqual([]);
    expect(seen.errors).toEqual([]);
  });
});
}
