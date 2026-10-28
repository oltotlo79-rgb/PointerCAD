import { statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

import { beginRecompute, waitForRecompute } from './recompute.js';

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

async function acceptConfirms(page: Page): Promise<readonly string[]> {
  const messages: string[] = [];
  await page.addLocatorHandler(page.getByRole('alertdialog', { name: '保存していない変更があります' }), async (dialog) => {
    messages.push(await dialog.locator('p').innerText());
    await dialog.getByRole('button', { name: '保存せずに続ける', exact: true }).click();
  });
  return messages;
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

function solidTool(page: Page, label: string): Locator {
  return page
    .getByRole('group', { name: 'ソリッド' })
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

function popover(page: Page): Locator {
  return page.locator('.pcad-popover');
}

function popoverTitle(page: Page): Locator {
  return page.locator('.pcad-popover__title');
}

function popoverInputs(page: Page): Locator {
  return page.locator('.pcad-popover input.pcad-field__input');
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
  return propertyPanel(page)
    .locator('.pcad-field')
    .filter({ has: page.locator('.pcad-field__label', { hasText: new RegExp(`^${label}$`) }) })
    .locator('input.pcad-field__input');
}

async function fillFields(page: Page, sources: readonly (string | null)[]): Promise<void> {
  await expect(popover(page)).toBeVisible();
  const inputs = popoverInputs(page);
  for (const [index, source] of sources.entries()) {
    if (source === null) {
      continue;
    }
    await inputs.nth(index).fill(source);
  }
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

/* ホーム視点の写し(solid.spec.ts の P3 節と同じ数値・同じ組み立て。この検査も視点を動かさない)。 */
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

async function selectBodiesOnly(page: Page): Promise<void> {
  const status = page.locator('.pcad-statusbar');
  for (const [name, enabled] of [['頂点', false], ['辺', false], ['面', false], ['立体', true]] as const) {
    const button = status.getByRole('button', { name, exact: true });
    if ((await button.getAttribute('aria-pressed')) !== String(enabled)) await button.click();
    await expect(button).toHaveAttribute('aria-pressed', String(enabled));
  }
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 立体');
}

async function volumeNumber(page: Page): Promise<number> {
  const cell = propertyValue(page, '体積');
  if ((await cell.count()) === 0) {
    return Number.NaN;
  }
  return Number.parseFloat(await cell.innerText());
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
  await expect(propertyValue(page, '体積')).toHaveText(`${String(BOARD_VOLUME)} ${VOLUME_UNIT}`, {
    timeout: KERNEL_TIMEOUT_MS,
  });

  // 2) 関係のない貫通穴 φ6 を (10, 15) にあける(solid.spec.ts の穴の手順と同じ)。
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
