import { volumeNumber } from './workPlaneCaptureSupport.js';
/* ホーム視点の写し(solid.spec.ts の P3 節と同じ数値・同じ組み立て。この検査も視点を動かさない)。 */
import { clickWorldPoint } from './homeViewProjection.js';
import { homeViewPagePoint } from './boltedJointTestSupport.js';
import { statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { collectErrors } from './runtimeErrors.js';
import { disableFilePickers } from './filePickers.js';
import { openToolMenu } from './toolMenus.js';
import { fillFields, popover, popoverInputs } from './popoverFields.js';

import { beginRecompute, waitForRecompute, waitForSettledRecompute } from './recompute.js';
import { fieldByLabel } from './fieldByLabel.js';
import { uiMessage } from './uiMessages.js';

/**
 * EX-18 の限られた一段「平らな面の移動」を、実際のブラウザで通しで確かめる。**ヘッドレスで実行する。**
 *
 * 2026-10-16 に Root が3つの host で通した検査(runs/20261016-010141-root-face-three-host-r2-static/proof/faceOffset.spec.ts
 * 717ad8be…、実行 runs/20261016-010604-root-face-three-host-r2-e2e/execution: 3 passed)の本体を、そのまま常設の検査へ
 * 移したもの。変えたのは、Root 専用の起動の口(`page` の差し替え・環境変数の確かめ・記録の書き出し)を外し、
 * ブラウザーは face-offset-solid.spec.ts、Electron は electron-face-offset.spec.ts の既存の起動(launchDesktop)から
 * 呼ぶようにしたことと、窓の大きさを connectPointsFlow.ts と同じ setViewportSize でそろえたことだけ。
 *
 * 板(40×30×10)に関係のない貫通穴 φ6 をあけ、右の端面(x = 40、法線 +X)を符号付きの距離で動かす。
 * 形は実物の Worker + OCCT が作り、体積は画面のプロパティから読む(作った結果を差し込まない)。
 * 端面の隣の面(上・下・手前・奥)はどれも端面に直角なので、この段が扱える形になっている。
 *
 * 補助関数は solid.spec.ts と同じ作りで、共有ファイルを作らずここへ書き写す
 * (solid.spec.ts の頭の注釈と同じ決まり)。選択子は role / aria / class で引く。
 */

/** 幾何カーネル(Worker + OCCT、約 50MB)の読み込みぶんの上限(solid.spec.ts と同じ)。 */
const KERNEL_TIMEOUT_MS = 60_000;
/** ja.json の propertyPanel.unitCubicMillimeter。 */
const VOLUME_UNIT = 'mm³';
/** editSolidFace.ts の FACE_OFFSET_COLLISION_MESSAGE。 */
const COLLISION_REASON =
  '面を動かすと、ほかの形(穴や出っ張りなど)に当たるため動かせません。距離を見直してください。';

/** 板 40×30×10(mm³)。 */
const BOARD_VOLUME = 40 * 30 * 10;
/** φ6 の貫通穴 1 つが板から取り除く量(π·3²·10)。 */
const HOLE_6_THROUGH = Math.PI * 3 * 3 * 10;
/** 右の端面(30×10)の面積。距離 d だけ動かすと体積が d·300 だけ変わる。 */
const END_FACE_AREA = 30 * 10;
/** 穴の中心(x = 10)。端面を x = 12 まで削ると穴(x = 7〜13)に当たる。 */
const HOLE_CENTER: readonly [string, string, string] = ['10', '15', '0'];

async function acceptConfirms(page: Page): Promise<readonly string[]> {
  const messages: string[] = [];
  await page.addLocatorHandler(page.getByRole('alertdialog', { name: '保存していない変更があります' }), async (dialog) => {
    messages.push(await dialog.locator('p').innerText());
    await dialog.getByRole('button', { name: '保存せずに続ける', exact: true }).click();
  });
  return messages;
}

function sketchTool(page: Page, label: string): Locator {
  return page
    .getByRole('group', { name: 'スケッチ' })
    .getByRole('button', { name: label, exact: true });
}

function solidTool(page: Page, label: string): Locator {
  return page
    .getByRole('group', { name: 'ソリッド' })
    .getByRole('button', { name: label, exact: true });
}

function machiningTool(page: Page, label: string): Locator {
  return page
    .getByRole('group', { name: '加工' })
    .getByRole('button', { name: label, exact: true });
}

function fileAction(page: Page, label: string): Locator {
  return page
    .getByRole('group', { name: 'ファイル' })
    .getByRole('button', { name: label, exact: true });
}

function popoverTitle(page: Page): Locator {
  return page.locator('.pcad-popover__title');
}

function featureTree(page: Page): Locator {
  return page.locator('.pcad-panel--left');
}

function propertyPanel(page: Page): Locator {
  return page.locator('.pcad-panel--right');
}

function statusText(page: Page): Locator {
  return page.locator('.pcad-statusbar__text');
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

function solidRows(page: Page): Locator {
  return treeSection(page, 'ソリッド').locator('.pcad-tree__children > li');
}

function solidRowBox(page: Page, name: string): Locator {
  return treeSection(page, 'ソリッド').locator('.pcad-tree__row--child').filter({ hasText: name });
}

function propertyValue(page: Page, key: string): Locator {
  return propertyPanel(page)
    .locator('dt.pcad-properties__key', { hasText: key })
    .locator('xpath=following-sibling::dd[1]');
}

function propertyField(page: Page, label: string): Locator {
  return fieldByLabel(page, propertyPanel(page), label, { controlSelector: 'input.pcad-field__input' });
}

async function commitPopover(page: Page): Promise<void> {
  await popoverInputs(page).first().press('Enter');
}

async function cancelPopover(page: Page): Promise<void> {
  await popoverInputs(page).first().press('Escape');
  await expect(popover(page)).toHaveCount(0);
}

async function drawRectangle(
  page: Page,
  origin: readonly [string, string],
  size: readonly [string, string],
): Promise<void> {
  await sketchTool(page, '線分').click();
  await expect(popoverTitle(page)).toHaveText('線分の始点');
  await fillFields(page, [origin[0], origin[1], '0']);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('線分の終点');
  await fillFields(page, [size[0], null, null]);
  await commitPopover(page);
  await fillFields(page, [null, size[1], null]);
  await commitPopover(page);
  await fillFields(page, [`-${size[0]}`, null, null]);
  await commitPopover(page);
  await fillFields(page, [null, `-${size[1]}`, null]);
  await commitPopover(page);
  await cancelPopover(page);
}

async function makeFace(page: Page, lineNames: readonly string[]): Promise<void> {
  await treeRow(page, lineNames[0]).click();
  for (const name of lineNames.slice(1)) {
    await treeRow(page, name).click({ modifiers: ['Shift'] });
  }
  await sketchTool(page, '面').click();
  await page.locator('canvas.pcad-viewport__canvas').press('Enter');
}

async function extrudeFace(page: Page, faceName: string, distance: string | null): Promise<void> {
  await treeRow(page, faceName).click();
  await openToolMenu(page, '作る');
  await solidTool(page, '押し出し').click();
  await expect(popoverTitle(page)).toHaveText('押し出す');
  if (distance !== null) {
    await fillFields(page, [distance]);
  }
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
}

async function selectBodiesOnly(page: Page): Promise<void> {
  const status = page.locator('.pcad-statusbar');
  for (const [name, enabled] of [['頂点', false], ['辺', false], ['面', false], ['ソリッド', true]] as const) {
    const button = status.getByRole('button', { name, exact: true });
    if ((await button.getAttribute('aria-pressed')) !== String(enabled)) await button.click();
    await expect(button).toHaveAttribute('aria-pressed', String(enabled));
  }
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの ソリッド');
}


async function expectVolume(page: Page, expected: number, toleranceMm3 = 0.01): Promise<void> {
  await expect
    .poll(async () => Math.abs((await volumeNumber(page)) - expected), {
      timeout: KERNEL_TIMEOUT_MS,
      message: `体積が ${String(expected)} mm³ ± ${String(toleranceMm3)} になること`,
    })
    .toBeLessThanOrEqual(toleranceMm3);
}

declare global {
  interface Window {
    faceProofSaved?: number[];
    faceProofOpen?: number[] | null;
  }
}

/**
 * 実物の検査用ファイル口(PointerCadApp.tsx が E2E ビルドで差し出す `pcadSetFileGateway`、型は file/fileGateway.ts の
 * FileGateway。Window への宣言は assemblyTestSupport.ts)へ、保存したバイトを控え・開くときに 1 回だけ渡す口を入れる。
 */
async function installFileGateway(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.pcadSetFileGateway === 'function', undefined, { timeout: 15_000 });
  await page.evaluate(() => {
    const install = window.pcadSetFileGateway;
    if (install === undefined) throw new Error('Actual file gateway hook is absent');
    install({
      openPcad: () => {
        const bytes = window.faceProofOpen ?? null;
        window.faceProofOpen = null;
        return Promise.resolve(bytes === null ? null : { name: 'face-offset.pcad', bytes: new Uint8Array(bytes), saveTargetToken: null });
      },
      savePcad: (name, saved) => { window.faceProofSaved = [...saved]; return Promise.resolve(name); },
      hasSaveTarget: () => false,
      confirmSaveTarget: () => Promise.resolve(),
      clearSaveTarget: () => undefined,
    });
  });
}

/**
 * 穴のある板の端面を符号付きで動かし、寸法の変更・元に戻す・保存と開き直し・衝突の断りが実物で通る。
 * `entry` はブラウザーでは '/'(preview)、Electron では製品の入口 'app://pointercad/index.html'
 * (apps/desktop/src/main/appProtocol.ts の APP_ENTRY_URL)。
 */
export async function faceOffsetFlow(page: Page, info: TestInfo, entry: string): Promise<void> {
  const errors = collectErrors(page);
  const confirms = await acceptConfirms(page);
  await disableFilePickers(page);
  // solid.spec.ts の P3 節と同じ窓の大きさ(押す場所を計算するので固定する)。
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto(entry);
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  await installFileGateway(page);

  // 1) 40 × 30 の板を 10 押し出す。
  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await extrudeFace(page, '面1', null);
  await solidRow(page, '押し出し1').click();
  await expect(propertyValue(page, '体積')).toHaveAttribute('title', `${String(BOARD_VOLUME)} ${VOLUME_UNIT}`, {
    timeout: KERNEL_TIMEOUT_MS,
  });

  // 2) 関係のない貫通穴 φ6 を (10, 15) にあける(solid.spec.ts の穴の手順と同じ)。
  await makeThroughHole(page);

  // 3) 「面の移動」を押すと選ぶものが「面」へ切り替わる。右の端面(x = 40)の中央を押してから、もう一度押す。
  await openToolMenu(page, '加工');
  const faceOffsetButton = machiningTool(page, '面の移動');
  await faceOffsetButton.click({ force: true });
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  await clickWorldPoint(page, [40, 15, 5]);
  await openToolMenu(page, '加工');
  await expect(faceOffsetButton).toBeEnabled();
  await faceOffsetButton.click();

  // 4) 距離の既定は 1(directFaceEdit.ts の DEFAULT_FACE_OFFSET_MM)。+5 で外へ足す。
  await expect(popoverTitle(page)).toHaveText('面を動かす');
  await expect(popoverInputs(page).first()).toHaveValue('1');
  // W07: a rejected candidate keeps the existing two bodies and the input; correction commits once.
  await fillFields(page, ['-28']);
  await commitPopover(page);
  await expect(popover(page).getByRole('alert')).toHaveText(COLLISION_REASON, { timeout: KERNEL_TIMEOUT_MS });
  await expect(popoverInputs(page).first()).toHaveValue('-28');
  await expect(solidRows(page)).toHaveCount(2);
  await expect(solidRow(page, '面の移動1')).toHaveCount(0);
  await expect(solidRowBox(page, '穴1')).not.toContainText('統合済み');
  await fillFields(page, ['5']);
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);

  // 5) 実物の形: 体積 = 元 + 5·300、穴の分はそのまま引かれている(穴は端面にも隣の面にも当たらない)。
  await expect(solidRow(page, '面の移動1')).toBeVisible();
  await solidRow(page, '面の移動1').click();
  await expectVolume(page, BOARD_VOLUME + 5 * END_FACE_AREA - HOLE_6_THROUGH);
  await expect(propertyField(page, '動かす距離')).toHaveValue('5');
  await expect(solidRowBox(page, '穴1')).toContainText('統合済み');

  // W07: rejection added no history; one Undo removes the sole successful creation.
  await sketchTool(page, '選択').click();
  await page.keyboard.press('Control+z');
  await expect(solidRows(page)).toHaveCount(2);
  await expect(solidRow(page, '面の移動1')).toHaveCount(0);
  await solidRow(page, '穴1').click();
  await expectVolume(page, BOARD_VOLUME - HOLE_6_THROUGH);
  await page.keyboard.press('Control+y');
  await solidRow(page, '面の移動1').click();
  await expectVolume(page, BOARD_VOLUME + 5 * END_FACE_AREA - HOLE_6_THROUGH);

  // 6) 寸法を変える: 負の距離で内へ削る(式の欄から作り直される)。
  await propertyField(page, '動かす距離').fill('-5');
  await expectVolume(page, BOARD_VOLUME - 5 * END_FACE_AREA - HOLE_6_THROUGH);

  // 7) 元に戻す・やり直す。寸法の変更が 1 段、面の移動そのものが 1 段で戻る。
  //    式の欄に焦点があるあいだはキーが欄に入るので、道具を選び直して焦点を欄から外す
  //    (solid.spec.ts の「加工の間違った操作」の 6) と同じ手順)。
  await sketchTool(page, '選択').click();
  await page.keyboard.press('Control+z');
  await solidRow(page, '面の移動1').click();
  await expect(propertyField(page, '動かす距離')).toHaveValue('5');
  await expectVolume(page, BOARD_VOLUME + 5 * END_FACE_AREA - HOLE_6_THROUGH);
  await sketchTool(page, '選択').click();
  await page.keyboard.press('Control+z');
  await expect(solidRow(page, '面の移動1')).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await page.keyboard.press('Control+y');
  await expect(solidRow(page, '面の移動1')).toBeVisible();
  await solidRow(page, '面の移動1').click();
  await expect(propertyField(page, '動かす距離')).toHaveValue('-5');
  await expectVolume(page, BOARD_VOLUME - 5 * END_FACE_AREA - HOLE_6_THROUGH);

  // 8) 保存 → 新規 → 開き直し。面の参照と符号付きの距離が戻り、形も同じに作り直される。
  //    受け渡しは 3 環境とも同じ実物の検査用ファイル口(window.pcadSetFileGateway)。Electron には
  //    ダウンロード・ファイル選択の代替経路が無いため(実物の保存・読込の処理はそのまま通る)。
  await page.evaluate(() => { delete window.faceProofSaved; });
  await fileAction(page, '保存').click();
  await expect.poll(() => page.evaluate(() => window.faceProofSaved?.length ?? 0)).toBeGreaterThan(0);
  const savedBytes = await page.evaluate(() => window.faceProofSaved ?? []);
  const savedPath = info.outputPath('face-offset.pcad');
  await writeFile(savedPath, Uint8Array.from(savedBytes));
  expect(statSync(savedPath).size).toBeGreaterThan(0);
  await expect(statusText(page)).toHaveText('保存しました');

  await fileAction(page, '新規').click();
  await expect(featureTree(page)).toContainText('まだ何もありません。');
  await page.evaluate((bytes) => { window.faceProofOpen = bytes; }, savedBytes);
  await fileAction(page, '開く').click();
  await expect(solidRow(page, '面の移動1')).toBeVisible();
  // 開いたのは保存した実バイト(口が 1 回だけ渡して空にした)。
  expect(await page.evaluate(() => window.faceProofOpen ?? null)).toBeNull();
  await solidRow(page, '面の移動1').click();
  await expect(propertyField(page, '動かす距離')).toHaveValue('-5');
  await expectVolume(page, BOARD_VOLUME - 5 * END_FACE_AREA - HOLE_6_THROUGH);

  // 9) 衝突の断り: 端面を x = 12 まで削る(−28)と穴(x = 7〜13)に当たる。理由が出て、形は作られない。
  await propertyField(page, '動かす距離').fill('-28');
  await expect(solidRowBox(page, '面の移動1').locator('.pcad-tree__alert')).toHaveAttribute(
    'title',
    new RegExp(COLLISION_REASON.replace(/[()]/g, '\\$&')),
    { timeout: KERNEL_TIMEOUT_MS },
  );
  await expect(propertyPanel(page).locator('.pcad-panel__error')).toHaveText(COLLISION_REASON);
  // 断っても立体の数は増えも減りもしない(押し出し1・穴1・面の移動1)。
  await expect(solidRows(page)).toHaveCount(3);

  // EX-18.16: the failed edit consumes nothing; its successful input still consumes the original extrusion.
  await expect(solidRowBox(page, '穴1')).not.toContainText('統合済み');
  await expect(solidRowBox(page, '押し出し1')).toContainText('統合済み');
  await solidRow(page, '穴1').click();
  await expectVolume(page, BOARD_VOLUME - HOLE_6_THROUGH);
  // Pick the restored input through the viewport, rather than relying only on the history row.
  await solidRow(page, '面の移動1').click();
  // The home camera is unchanged; exclude overlapping sketch geometry through the ordinary selection filters.
  await selectBodiesOnly(page);
  await clickWorldPoint(page, [40, 15, 5]);
  await expect(solidRowBox(page, '穴1')).toHaveClass(/pcad-tree__row--selected/);
  await expectVolume(page, BOARD_VOLUME - HOLE_6_THROUGH);
  await expect(propertyPanel(page)).not.toContainText(COLLISION_REASON);

  // Save the actual failed feature and reopen through the normal file gateway.
  await page.evaluate(() => { delete window.faceProofSaved; });
  await fileAction(page, '保存').click();
  await expect.poll(() => page.evaluate(() => window.faceProofSaved?.length ?? 0)).toBeGreaterThan(0);
  const failedBytes = await page.evaluate(() => window.faceProofSaved ?? []);
  const failedPath = info.outputPath('face-offset-failed.pcad');
  await writeFile(failedPath, Uint8Array.from(failedBytes));
  expect(statSync(failedPath).size).toBe(failedBytes.length);
  const failedSavedBytes = [...(await readFile(failedPath))];
  expect(failedSavedBytes).toEqual(failedBytes);
  // statusText.ts:1197-1198 keeps the recompute error ahead of the save notice (1238-1239).
  await expect(statusText(page)).toHaveText(`計算に失敗しました: ${COLLISION_REASON}`);
  await fileAction(page, '新規').click();
  await expect(featureTree(page)).toContainText('まだ何もありません。');
  await page.evaluate((bytes) => { window.faceProofOpen = bytes; }, failedSavedBytes);
  await fileAction(page, '開く').click();
  await expect(solidRowBox(page, '面の移動1').locator('.pcad-tree__alert')).toHaveAttribute(
    'title', new RegExp(COLLISION_REASON.replace(/[()]/g, '\\$&')), { timeout: KERNEL_TIMEOUT_MS },
  );
  expect(await page.evaluate(() => window.faceProofOpen ?? null)).toBeNull();
  await expect(solidRowBox(page, '穴1')).not.toContainText('統合済み');
  await expect(solidRowBox(page, '押し出し1')).toContainText('統合済み');
  await solidRow(page, '穴1').click();
  await expectVolume(page, BOARD_VOLUME - HOLE_6_THROUGH);
  await solidRow(page, '面の移動1').click();
  await expect(propertyField(page, '動かす距離')).toHaveValue('-28');
  await expect(propertyPanel(page).locator('.pcad-panel__error')).toHaveText(COLLISION_REASON);
  await selectBodiesOnly(page);
  await clickWorldPoint(page, [40, 15, 5]);
  await expect(solidRowBox(page, '穴1')).toHaveClass(/pcad-tree__row--selected/);
  await expectVolume(page, BOARD_VOLUME - HOLE_6_THROUGH);
  await solidRow(page, '面の移動1').click();

  // 10) 値を戻すと形も戻る(断りで画面が固まっていない証拠。solid.spec.ts の R 面取りと同じ確かめ方)。
  await propertyField(page, '動かす距離').fill('-5');
  await expect(solidRowBox(page, '面の移動1').locator('.pcad-tree__alert')).toHaveCount(0, {
    timeout: KERNEL_TIMEOUT_MS,
  });
  await expectVolume(page, BOARD_VOLUME - 5 * END_FACE_AREA - HOLE_6_THROUGH);
  await expect(solidRowBox(page, '穴1')).toContainText('統合済み');

  expect(confirms).toEqual([]);
  expect(errors).toEqual([]);
}

/** solid.json の solidError.pushPullUnsupported(押し引きで振り分けられない選択の断り)。 */
const PUSH_PULL_REASON = '押し引きでは、作図の面か閉じた領域、立体の面、立体の辺のどれか 1 種類を選んでから押してください。';

async function openPushPullInput(page: Page, title: string): Promise<void> {
  await openToolMenu(page, '加工');
  const tool = machiningTool(page, uiMessage('toolbar', 'toolbar.machining.pushPull'));
  await expect(tool).toBeEnabled();
  await tool.click();
  await expect(popoverTitle(page)).toHaveText(title);
}

/** 立体の縦の辺を選び、押し引きから開いたR面取りを取消・確定する。 */
async function pushPullFillet(page: Page): Promise<void> {
  await sketchTool(page, '選択').click();
  await page.keyboard.press('2');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 辺');
  await waitForSettledRecompute(page);
  await clickWorldPoint(page, [0, 0, 5]);
  await openPushPullInput(page, '角を丸める');
  await fillFields(page, ['3']);
  await cancelPopover(page);
  await expect(solidRow(page, 'R面取り1')).toHaveCount(0);

  await page.keyboard.press('2');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 辺');
  await clickWorldPoint(page, [0, 0, 5]);
  await openPushPullInput(page, '角を丸める');
  await fillFields(page, ['2']);
  await commitPopover(page);
  await expect(solidRow(page, 'R面取り1')).toBeVisible();
  await solidRow(page, 'R面取り1').click();
  await expectVolume(page, BOARD_VOLUME - 10 * (4 - Math.PI));
  await page.keyboard.press('Control+z');
  await expect(solidRow(page, 'R面取り1')).toHaveCount(0);
  await solidRow(page, '押し出し1').click();
  await expectVolume(page, BOARD_VOLUME);
  await page.keyboard.press('Control+y');
  await expect(solidRow(page, 'R面取り1')).toBeVisible();
  await solidRow(page, 'R面取り1').click();
  await expectVolume(page, BOARD_VOLUME - 10 * (4 - Math.PI));
  await page.keyboard.press('Control+z');
  await expect(solidRow(page, 'R面取り1')).toHaveCount(0);
  await solidRow(page, '押し出し1').click();
  await expectVolume(page, BOARD_VOLUME);
}

/**
 * 押し引き(M-05 4-1a・4-1b)。板(40×30×10)の右の端面を選んで「押し引き」を押すと、面の移動の入力欄が開き、
 * 確定すると面の移動と同じ形・同じ行になる。立体そのものを選んでいる時は、何も開かずに理由を帯へ出す。
 * 穴の内側の面(計算部が下穴の壁と名付けた面)を選んで押すと、入力欄は開かずに穴を選び、右の欄の「直径」へ焦点が移る。
 * 裏づけ: 振り分けは solid/pushPull.ts の pushPullTarget、押した時の処理は shell/menus/solidToolActions.ts の runPushPull
 * (振り分け先が押せれば openSolidInput、押せなければ理由だけ、穴の壁なら setSelection と requestFocus)。
 * 焦点は shell/solidFieldFocus.ts の useSolidFieldFocus が PropertyPanel.tsx の SolidProperties の欄の focused を真にし、
 * sketch/ExpressionField.tsx の効果が焦点を移して全選択する(そのまま打つと置き換わる)。穴の欄の並びは solidSummary.ts の holeFields。
 * 名前は toolbar.json の toolbar.machining.pushPull。面を選ぶのは 3 キー(commandDefinitions.ts の selection.face)。
 * 入力欄の題・既定の距離は上の faceOffsetFlow と同じ。
 */
export async function pushPullFlow(page: Page, entry: string): Promise<void> {
  const errors = collectErrors(page);
  await disableFilePickers(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(entry);
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await sketchTool(page, '選択').click();
  await page.keyboard.press('3');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  await treeRow(page, '面1').click();
  await openPushPullInput(page, '押し出す');
  await fillFields(page, ['10']);
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0, { timeout: KERNEL_TIMEOUT_MS });
  await solidRow(page, '押し出し1').click();
  await expect(propertyValue(page, '体積')).toHaveAttribute('title', `${String(BOARD_VOLUME)} ${VOLUME_UNIT}`, {
    timeout: KERNEL_TIMEOUT_MS,
  });

  // 立体そのもの(押し出し1)を選んでいる時は、何も開かずに理由だけを帯へ出す。
  await openToolMenu(page, '加工');
  await machiningTool(page, '押し引き').click({ force: true });
  await expect(statusText(page)).toContainText(PUSH_PULL_REASON);
  await expect(popover(page)).toHaveCount(0);

  // 選ぶものを面にして、右の端面(x = 40)を押してから「押し引き」を押すと、面の移動の入力欄が開く。
  await sketchTool(page, '選択').click();
  await page.keyboard.press('3');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  await clickWorldPoint(page, [40, 15, 5]);
  await openToolMenu(page, '加工');
  await machiningTool(page, '押し引き').click();
  await expect(popoverTitle(page)).toHaveText('面を動かす');
  await expect(popoverInputs(page).first()).toHaveValue('1');
  await fillFields(page, ['5']);
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0, { timeout: KERNEL_TIMEOUT_MS });
  await expect(solidRow(page, '面の移動1')).toBeVisible();
  await expectVolume(page, BOARD_VOLUME + 5 * END_FACE_AREA);

  // 元に戻すは、面の移動の 1 段だけで戻る(押し引きは段を作らない)。
  await sketchTool(page, '選択').click();
  await page.keyboard.press('Control+z');
  await expect(solidRow(page, '面の移動1')).toHaveCount(0);
  await solidRow(page, '押し出し1').click();
  await expectVolume(page, BOARD_VOLUME);

  await page.keyboard.press('Control+y');
  await expect(solidRow(page, '面の移動1')).toBeVisible();
  await solidRow(page, '面の移動1').click();
  await expectVolume(page, BOARD_VOLUME + 5 * END_FACE_AREA);
  await page.keyboard.press('Control+z');
  await expect(solidRow(page, '面の移動1')).toHaveCount(0);

  await pushPullFillet(page);

  // 4-1b: 穴の内側の面を選んで押すと、入力欄は開かずに穴1を選び、右の欄の「直径」へ焦点が移る。そのまま打つと径が変わる。
  await makeThroughHole(page);
  // 「選択」の道具は選ぶものを立体へ戻す(sketchSlice.ts の setActiveTool → subShapeSelection.ts の selectionKindForTool の既定)。
  // なので上の 4-1a の段と同じく、押した後に 3 キーで面へ切り替える。
  await sketchTool(page, '選択').click();
  await page.keyboard.press('3');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  await clickWorldPoint(page, HOLE_WALL_POINT);
  await openToolMenu(page, '加工');
  await machiningTool(page, '押し引き').click();
  await expect(propertyField(page, '直径')).toBeFocused();
  await expect(popover(page)).toHaveCount(0);
  await expect(solidRowBox(page, '穴1')).toHaveClass(/pcad-tree__row--selected/);
  await page.keyboard.type('8');
  await expectVolume(page, BOARD_VOLUME - HOLE_8_THROUGH);

  // 同じ焦点の頼み(store/viewSlice.ts の focusRequest)のもう 1 つの受け手: 3D の表示で Space を押すと、コマンドの欄へ焦点が移る
  // (commandDefinitions.ts の commandLine.focus → commandRegistry.ts の focusCommandLine → shell/CommandLine.tsx の効果)。
  await page.locator('canvas.pcad-viewport__canvas').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#pcad-command-line-input')).toBeFocused();
  expect(errors).toEqual([]);
}

/**
 * 穴の内側の面の 1 点。穴は中心 (10, 15)・半径 3・深さ 10(上面 z = 10)。既定の視点(homeViewProjection.ts の HOME_AZIMUTH -45°・
 * HOME_ELEVATION、カメラは +X・-Y・+Z の側)から穴の口ごしに見えるのは、カメラと反対の側(-X・+Y の向き)の壁の、上面から約 3.7 までの帯。
 * その帯の中ほど(上面から 2)を押す。
 */
const HOLE_WALL_POINT: readonly [number, number, number] = [10 - 3 / Math.SQRT2, 15 + 3 / Math.SQRT2, 8];
/** 径を 8 に打ち直した貫通穴が板から取り除く量(π·4²·10)。 */
const HOLE_8_THROUGH = Math.PI * 4 * 4 * 10;

/**
 * 板(押し出し1、40×30×10)に、貫通穴 φ6 を (10, 15) にあける(faceOffsetFlow の 2) と pushPullFlow が使う。
 * 穴の径は入力欄の既定のまま(φ6)。点1 は、この手順で初めて作る点。
 */
async function makeThroughHole(page: Page): Promise<void> {
  await sketchTool(page, '点').click();
  await fillFields(page, [...HOLE_CENTER]);
  const beforeHoleCenter = await beginRecompute(page);
  await commitPopover(page);
  await cancelPopover(page);
  // 点の作成も再計算を起こす。古い体積や入力欄の消失だけでは立体の面を拾えない。
  await waitForRecompute(page, beforeHoleCenter);
  await openToolMenu(page, '加工');
  const holeButton = machiningTool(page, '穴');
  await holeButton.click({ force: true });
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  await clickWorldPoint(page, [20, 15, 10]);
  await expect(solidRowBox(page, '押し出し1')).toHaveClass(/pcad-tree__row--selected/);
  await treeRow(page, '点1').click({ modifiers: ['Shift'] });
  await openToolMenu(page, '加工');
  await holeButton.click();
  await expect(popoverTitle(page)).toHaveText('穴をあける');
  await popover(page).getByRole('switch', { name: '貫通', exact: true }).click();
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
  await expect(solidRow(page, '穴1')).toBeVisible();
  await expectVolume(page, BOARD_VOLUME - HOLE_6_THROUGH);
}

/**
 * 面の移動の矢印のつまみ(M-05 4-2a)。板(40×30×10)の右の端面(重心 (40, 15, 5)、外向きの法線 +X)を選んで「面の移動」の
 * 入力欄を開き、5 を打つと、つまみの根もとは (45, 15, 5) へ動く(打った数が優先)。そこを掴んで引くと距離の欄の数が動き、
 * 掴んだまま Esc を押すと掴む前の 5 へ戻って窓は開いたまま。もう一度掴んで内へ押して離すと欄は約 -3 になるが、形の計算は
 * しない(行は増えない)。Enter で確定すると、面の移動の 1 段が欄の数どおりの体積で入る。
 * 裏づけ:
 * - 選ぶ手順は上の faceOffsetFlow の 3)〜4)(「面の移動」を押すと選ぶものが「面」へ切り替わる → 端面を押す → もう一度押す)と同じ。
 * - つまみの位置: solid/faceOffsetHandle.ts の faceOffsetHandleOf(重心 + 外向きの法線 × 欄の距離。距離は確定と同じ
 *   previewSolidCommit で読む)。画面の位置は既定の視点の写し(homeViewProjection.ts の worldToCanvas。この検査も視点を動かさない)。
 * - 掴める所: viewport/faceOffsetHandleDrag.ts の begin(根もとの 18px。sectionHandleDrag.ts の HANDLE_PICK_RADIUS_PIXELS)。
 *   押下の順は sketchInteractionResources.ts の onPointerDown(つまみ → 断面のつまみ → 今までの当たり判定)。
 * - 窓の位置: 端面を押した時の画面の外形を避けて開く(NumericInputPopover.tsx の placePopover、M-10 ①)。押す点が窓に覆われて
 *   いない事は、押す前に確かめる(pressHandle)。動かす間はポインタを捕まえてある(setPointerCapture)。
 * - 欄の数: faceOffsetHandleDrag.ts の writeDistance(表示の単位で小数 3 桁。打鍵と同じ reduceNumericInput の edit)。
 *   引いた距離は画素の丸めで少しずれるので、±0.5 で確かめ、確定の体積は欄に入った数から求める。
 * - Esc: sketchInteractionResources.ts の onGrabEscape(window の捕捉の段で入力欄の Esc より先に受け、掴む前の入力欄へ戻す)。
 * - 欄の名前・題・既定の距離は上の faceOffsetFlow と同じ(題「面を動かす」、既定 1)。
 */
export async function faceOffsetHandleFlow(page: Page, entry: string): Promise<void> {
  const errors = collectErrors(page);
  await disableFilePickers(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(entry);
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await extrudeFace(page, '面1', null);
  await solidRow(page, '押し出し1').click();
  await expect(propertyValue(page, '体積')).toHaveAttribute('title', `${String(BOARD_VOLUME)} ${VOLUME_UNIT}`, {
    timeout: KERNEL_TIMEOUT_MS,
  });

  // faceOffsetFlow の 3)〜4) と同じ手順で、右の端面(x = 40)を選んで「面の移動」の入力欄を開く。
  await openToolMenu(page, '加工');
  const faceOffsetButton = machiningTool(page, '面の移動');
  await faceOffsetButton.click({ force: true });
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  await clickWorldPoint(page, [40, 15, 5]);
  await openToolMenu(page, '加工');
  await expect(faceOffsetButton).toBeEnabled();
  await faceOffsetButton.click();
  await expect(popoverTitle(page)).toHaveText('面を動かす');
  const distance = popoverInputs(page).first();
  await expect(distance).toHaveValue('1');

  // 打った数が優先: 5 を打つと、つまみの根もとは (45, 15, 5) へ動く(動いていなければ下で掴んでも 10 にならない)。
  await fillFields(page, ['5']);

  // (a) 掴んで外へ x = 50 まで引くと欄は約 10。掴んだまま Esc を押すと 5 へ戻り、窓は閉じない。
  await pressHandle(page, [45, 15, 5]);
  await moveHandle(page, [50, 15, 5]);
  await expectDistanceNear(distance, 10);
  await page.keyboard.press('Escape');
  await expect(distance).toHaveValue('5');
  await page.mouse.up();
  await expect(popoverTitle(page)).toHaveText('面を動かす');
  await expect(distance).toHaveValue('5');

  // (b) もう一度掴んで内へ x = 37 まで押して離すと欄は約 -3。離しても形は計算しない(面の移動の行は増えない)。
  await pressHandle(page, [45, 15, 5]);
  await moveHandle(page, [37, 15, 5]);
  await page.mouse.up();
  const dragged = await expectDistanceNear(distance, -3);
  await expect(solidRows(page)).toHaveCount(1);
  await expect(solidRow(page, '面の移動1')).toHaveCount(0);

  // (c) Enter で確定すると、面の移動の 1 段が欄の数どおりの体積で入る(確定は今までの道のまま)。
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0, { timeout: KERNEL_TIMEOUT_MS });
  await expect(solidRow(page, '面の移動1')).toBeVisible();
  await expectVolume(page, BOARD_VOLUME + dragged * END_FACE_AREA);
  expect(errors).toEqual([]);
}

/** 面の移動と同じ掴み方と距離の待ち方を使うため、共通の補助があるこのファイルに置く。 */
export async function extrudeHandleFlow(page: Page): Promise<void> {
  const errors = collectErrors(page);
  await disableFilePickers(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await waitForSettledRecompute(page);
  // extrudeFace と同じく、ツリーで面を選んで「作る」から開く。ここでは距離を確定せずに引く。
  await treeRow(page, '面1').click();
  await openToolMenu(page, '作る');
  await solidTool(page, '押し出し').click();
  await expect(popoverTitle(page)).toHaveText('押し出す');
  const distance = popoverInputs(page).first();
  await expect(distance).toHaveValue('10');
  await expect(solidRows(page)).toHaveCount(0);

  await pressHandle(page, [20, 15, 10]);
  await moveHandle(page, [20, 15, 20]);
  await expectDistanceNear(distance, 20);
  await page.keyboard.press('Escape');
  await expect(distance).toHaveValue('10');
  await expect(popoverTitle(page)).toHaveText('押し出す');
  await page.mouse.up();

  await pressHandle(page, [20, 15, 10]);
  await moveHandle(page, [20, 15, 5]);
  await page.mouse.up();
  const dragged = await expectDistanceNear(distance, 5);
  await expect(solidRows(page)).toHaveCount(0);

  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0, { timeout: KERNEL_TIMEOUT_MS });
  const extruded = solidRow(page, '押し出し1');
  await expect(extruded).toBeVisible();
  await extruded.click();
  await expectVolume(page, 40 * 30 * dragged);
  expect(errors).toEqual([]);
}

/** つまみの根もと(ワールドの点)が写る所を押して掴む。押す前に、その画素の一番上が 3D の canvas(窓に覆われていない)事を確かめる。 */
async function pressHandle(page: Page, world: readonly [number, number, number]): Promise<void> {
  const [x, y] = await homeViewPagePoint(page, world);
  expect(await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.matches('canvas.pcad-viewport__canvas') ?? false,
    [x, y] as const), `つまみの根もと ${world.join(',')} が窓に覆われている`).toBe(true);
  await page.mouse.move(x, y);
  await page.mouse.down();
}

/** 掴んだまま、ワールドの点が写る所までポインタを動かす(numericInputDragCaptureFlow.ts の dragHeading と同じ steps の動かし方)。 */
async function moveHandle(page: Page, world: readonly [number, number, number]): Promise<void> {
  const [x, y] = await homeViewPagePoint(page, world);
  await page.mouse.move(x, y, { steps: 8 });
}

/** 距離の欄が `expected` ± 0.5 になるのを待ち、入った数を返す(画素の丸めのぶんだけずれる)。 */
async function expectDistanceNear(distance: Locator, expected: number): Promise<number> {
  await expect.poll(async () => Math.abs(Number.parseFloat(await distance.inputValue()) - expected), {
    message: `距離の欄が ${String(expected)} ± 0.5 になること`,
  }).toBeLessThanOrEqual(0.5);
  return Number.parseFloat(await distance.inputValue());
}
