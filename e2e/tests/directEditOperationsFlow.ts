import { statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

/** Real UI gestures and the product file gateway; geometry and document state are never injected.
 * Helpers follow faceOffsetFlow.ts and solid.spec.ts. Root runs the three hosts headlessly. */
/** 幾何カーネル(Worker + OCCT、約 50MB)の読み込みぶんの上限(solid.spec.ts と同じ)。 */
const KERNEL_TIMEOUT_MS = 60_000;
/** ja.json の propertyPanel.unitCubicMillimeter。 */
const VOLUME_UNIT = 'mm³';
/** 板 40×30×8(mm³)。 */
const BOARD_VOLUME = 40 * 30 * 8;
/** φ6 の貫通穴 1 つが板から取り除く量(π·3²·8)。 */
const HOLE_6_THROUGH = Math.PI * 3 * 3 * 8;
/** 穴の中心(x = 10)。端面を x = 12 まで削ると穴(x = 7〜13)に当たる。 */
const HOLE_CENTER: readonly [string, string, string] = ['10', '15', '8'];

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
    directEditProofSaved?: number[];
    directEditProofOpen?: number[] | null;
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
        const bytes = window.directEditProofOpen ?? null;
        window.directEditProofOpen = null;
        return Promise.resolve(bytes === null ? null : { name: 'direct-edit.pcad', bytes: new Uint8Array(bytes), saveTargetToken: null });
      },
      savePcad: (name, saved) => { window.directEditProofSaved = [...saved]; return Promise.resolve(name); },
      hasSaveTarget: () => false,
      confirmSaveTarget: () => Promise.resolve(),
      clearSaveTarget: () => undefined,
    });
  });
}


type DirectOperation = 'holeTranslate' | 'faceRotate';

async function chooseDirectMaterials(page: Page, tool: DirectOperation, edgeFirst: boolean): Promise<void> {
  await sketchTool(page, '選択').click();
  await openToolMenu(page, '加工');
  const button = machiningTool(page, tool === 'holeTranslate' ? '穴の移動' : '面の回転');
  await button.click({ force: true });
  const canvas = page.locator('canvas.pcad-viewport__canvas');
  await canvas.press(tool === 'faceRotate' && edgeFirst ? '2' : '3');
  if (tool === 'holeTranslate') {
    // The visible inner wall, below the top rim and opposite the home camera.
    await clickWorldPoint(page, [10 - 3 / Math.SQRT2, 15 + 3 / Math.SQRT2, 7]);
  } else {
    await clickWorldPoint(page, edgeFirst ? [20, 0, 8] : [20, 15, 8]);
    await canvas.press(edgeFirst ? '3' : '2');
    await expect(selectionKindLabel(page)).toHaveText(edgeFirst ? '選ぶもの 面' : '選ぶもの 辺');
    await page.keyboard.down('Shift');
    try { await clickWorldPoint(page, edgeFirst ? [20, 15, 8] : [20, 0, 8]); }
    finally { await page.keyboard.up('Shift'); }
  }
  await openToolMenu(page, '加工');
  await expect(button).toBeEnabled();
  await button.click();
  await expect(popoverTitle(page)).toHaveText(tool === 'holeTranslate' ? '穴の移動量' : '面の回転角度');
}

/** 40×30×8 plate: a single r3 through-hole moves ±2mm; a box support plane rotates ±5°. */
export async function directEditOperationsFlow(page: Page, info: TestInfo, entry: string, tool: DirectOperation): Promise<void> {
  const errors = collectErrors(page);
  const confirms = await acceptConfirms(page);
  await disableFilePickers(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(entry);
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  await installFileGateway(page);
  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await extrudeFace(page, '面1', '8');
  await solidRow(page, '押し出し1').click();
  await expect(propertyValue(page, '体積')).toHaveText(`${String(BOARD_VOLUME)} ${VOLUME_UNIT}`, { timeout: KERNEL_TIMEOUT_MS });
  if (tool === 'holeTranslate') {
    await sketchTool(page, '点').click();
    await fillFields(page, HOLE_CENTER);
    await commitPopover(page);
    await cancelPopover(page);
    await openToolMenu(page, '加工');
    await machiningTool(page, '穴').click({ force: true });
    await clickWorldPoint(page, [20, 15, 8]);
    await treeRow(page, '点1').click({ modifiers: ['Shift'] });
    await openToolMenu(page, '加工');
    await machiningTool(page, '穴').click();
    await popover(page).getByRole('switch', { name: '貫通', exact: true }).click();
    await commitPopover(page);
    await expect(popover(page)).toHaveCount(0);
    await solidRow(page, '穴1').click();
    await expectVolume(page, BOARD_VOLUME - HOLE_6_THROUGH);
  }
  const label = tool === 'holeTranslate' ? '穴の移動' : '面の回転';
  const name = `${label}1`;
  const sourceName = tool === 'holeTranslate' ? '穴1' : '押し出し1';
  const count = tool === 'holeTranslate' ? 2 : 1;
  const positive = tool === 'holeTranslate' ? '2' : '5';
  const negative = tool === 'holeTranslate' ? '-2' : '-5';
  const field = tool === 'holeTranslate' ? 'X' : '回す角度';
  const volume = (sign: number) => tool === 'holeTranslate' ? BOARD_VOLUME - HOLE_6_THROUGH
    : BOARD_VOLUME + sign * 18000 * Math.tan(5 * Math.PI / 180);

  // Cancel an actual input, then select in the opposite order for the rotation.
  await chooseDirectMaterials(page, tool, false);
  await expect(popoverInputs(page).first()).toHaveValue(tool === 'holeTranslate' ? '1' : '5');
  await fillFields(page, [positive]);
  await cancelPopover(page);
  await expect(solidRows(page)).toHaveCount(count);
  await chooseDirectMaterials(page, tool, true);
  await fillFields(page, ['0']);
  await commitPopover(page);
  await expect(statusText(page)).toContainText('0 でない');
  await expect(solidRows(page)).toHaveCount(count);
  // A real native refusal arrives asynchronously; it must leave the original document intact.
  await fillFields(page, [tool === 'holeTranslate' ? '-7' : '-20']);
  await commitPopover(page);
  await expect(popover(page).getByRole('alert')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
  await expect(popover(page).getByRole('alert')).not.toHaveText('');
  await expect(solidRows(page)).toHaveCount(count);
  await fillFields(page, [positive]);
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0, { timeout: KERNEL_TIMEOUT_MS });
  await solidRow(page, name).click();
  await expectVolume(page, volume(1));
  await expect(propertyField(page, field)).toHaveValue(positive);
  await expect(solidRowBox(page, sourceName)).toContainText('統合済み');

  // Creation is exactly one history entry.
  await sketchTool(page, '選択').click();
  await page.keyboard.press('Control+z');
  await expect(solidRow(page, name)).toHaveCount(0);
  await expect(solidRows(page)).toHaveCount(count);
  await page.keyboard.press('Control+y');
  await solidRow(page, name).click();
  await expectVolume(page, volume(1));
  await propertyField(page, field).fill(negative);
  await expectVolume(page, volume(-1));
  await sketchTool(page, '選択').click();
  await page.keyboard.press('Control+z');
  await solidRow(page, name).click();
  await expect(propertyField(page, field)).toHaveValue(positive);
  await expectVolume(page, volume(1));
  await sketchTool(page, '選択').click();
  await page.keyboard.press('Control+y');
  await solidRow(page, name).click();
  await expect(propertyField(page, field)).toHaveValue(negative);
  await expectVolume(page, volume(-1));

  await fileAction(page, '保存').click();
  await expect.poll(() => page.evaluate(() => window.directEditProofSaved?.length ?? 0)).toBeGreaterThan(0);
  const bytes = await page.evaluate(() => window.directEditProofSaved ?? []);
  const savedPath = info.outputPath(`${tool}.pcad`);
  await writeFile(savedPath, Uint8Array.from(bytes));
  expect(statSync(savedPath).size).toBeGreaterThan(0);
  await expect(statusText(page)).toHaveText('保存しました');
  await fileAction(page, '新規').click();
  await expect(featureTree(page)).toContainText('まだ何もありません。');
  await page.evaluate(saved => { window.directEditProofOpen = saved; }, bytes);
  await fileAction(page, '開く').click();
  await solidRow(page, name).click();
  await expect(propertyField(page, field)).toHaveValue(negative);
  await expectVolume(page, volume(-1));
  expect(await page.evaluate(() => window.directEditProofOpen ?? null)).toBeNull();
  await expect(solidRows(page)).toHaveCount(count + 1);
  expect(confirms).toEqual([]);
  expect(errors).toEqual([]);
}
