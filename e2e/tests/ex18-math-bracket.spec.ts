/// <reference lib="dom" />
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { disableFilePickers } from './boltedJointTestSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import {
  cancelPopover, clickWorldPoint, commitPopover, fillFields, popover, popoverInputs, popoverTitle, propertyPanel,
  selectionKindLabel, sketchTool, topFaceCenter, treeRow,
} from './solidCaptureSupport.js';

/*
 * EX-18 の 4 つ目の作り方(数式の座標)を、実際の画面の道具とプロパティの式の欄だけで通す。
 * packages/model/src/part/ex18BracketKernel.test.ts の route 4 と同じ組み立て:
 *   「作る」の「箱」を原点に置き、寸法を式 4*10・3*10・2*5、中心を式 (4*10)/2・30/2・10/2 にする →
 *   点の道具で穴の中心を式 40/4・30/2・10 に打つ → 「加工」の「穴」で上面に φ6 の貫通穴をあける。
 * 独立した期待(手で求めた値): 板 40 × 30 × 10 = 12000 mm³、φ6 の貫通穴は π·3²·10。幅の式を 5*10、中心を (5*10)/2 に
 * 直すと 50 × 30 × 10 = 15000 mm³ から同じ穴。保存・開き直しと、欄ごとに 1 段の Undo/Redo を確かめる。
 * 1 つ目・2 つ目(candidate-18)・3 つ目の面の移動・5 つ目の画面の検査と、route 4 の模型の検査は繰り返さない。
 */

const KERNEL_TIMEOUT_MS = 60_000;
const HOLE_6_THROUGH = Math.PI * 3 * 3 * 10;
const BRACKET_40 = 40 * 30 * 10 - HOLE_6_THROUGH;
const BRACKET_50 = 50 * 30 * 10 - HOLE_6_THROUGH;

function treeSection(page: Page, title: string): Locator {
  return page.locator('.pcad-panel--left').locator('.pcad-tree__sections > li').filter({ hasText: title });
}

function solidRow(page: Page, name: string): Locator {
  return treeSection(page, 'ソリッド').getByRole('button', { name, exact: true });
}

function propertyValue(page: Page, key: string): Locator {
  return propertyPanel(page).locator('dt.pcad-properties__key', { hasText: key }).locator('xpath=following-sibling::dd[1]');
}

/** 見出しが完全に一致する式の欄(solid.spec.ts の propertyField と同じ。「X」と「X の長さ」を取り違えない)。 */
function propertyField(page: Page, label: string): Locator {
  return propertyPanel(page).locator('.pcad-field')
    .filter({ has: page.locator('.pcad-field__label', { hasText: new RegExp(`^${label}$`) }) })
    .locator('input.pcad-field__input');
}

function machiningTool(page: Page, label: string): Locator {
  return page.getByRole('group', { name: '加工' }).getByRole('button', { name: label, exact: true });
}

async function volumeNumber(page: Page): Promise<number> {
  const cell = propertyValue(page, '体積');
  if ((await cell.count()) === 0) return Number.NaN;
  return Number.parseFloat(await cell.innerText());
}

/** 体積を許容差 0.01 mm³ で比べる(solid.spec.ts の expectVolume と同じ基準)。 */
async function expectVolume(page: Page, expected: number): Promise<void> {
  await expect.poll(async () => Math.abs((await volumeNumber(page)) - expected), {
    timeout: KERNEL_TIMEOUT_MS, message: `体積が ${String(expected)} mm³ ± 0.01 になること`,
  }).toBeLessThanOrEqual(0.01);
}

/** 欄へ式を入れ、木の行を押して焦点を外す(solid.spec.ts 1432〜1434 と同じ確定の仕方)。 */
async function setExpression(page: Page, label: string, source: string, rowName: string, rowOf: (page: Page, name: string) => Locator): Promise<void> {
  // 欄の式の確定は形を作り直す(ex18-sew-bracket.spec.ts の直径の欄と同じく、作り直しの終わりを待つ)。
  const token = await beginRecompute(page);
  await propertyField(page, label).fill(source);
  await rowOf(page, rowName).click();
  await waitForRecompute(page, token);
  await expect(propertyField(page, label)).toHaveValue(source);
}

/** 何も選ばずに「作る」の「箱」を置く(selectedPrimitiveOrigin の既定は原点の絶対座標)。寸法は式で入れる。 */
async function placeMathBox(page: Page): Promise<void> {
  await openToolMenu(page, '作る');
  await toolMenuPanel(page, '作る').getByRole('button', { name: '箱', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('箱を置く');
  await fillFields(page, ['4*10', '3*10', '2*5']);
  const token = await beginRecompute(page);
  await commitPopover(page);
  await waitForRecompute(page, token);
  if (await popover(page).count() > 0) await popoverInputs(page).first().press('Escape');
  await expect(popover(page)).toHaveCount(0);
}

async function drillThroughHole(page: Page): Promise<void> {
  await openToolMenu(page, '加工');
  const holeButton = machiningTool(page, '穴');
  await expect(holeButton).toBeDisabled();
  await holeButton.click({ force: true });
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  await clickWorldPoint(page, topFaceCenter(10));
  await treeRow(page, '点1').click({ modifiers: ['Shift'] });
  await openToolMenu(page, '加工');
  await expect(holeButton).toBeEnabled();
  await holeButton.click();
  await expect(popoverTitle(page)).toHaveText('穴をあける');
  await expect(popoverInputs(page).first()).toHaveValue('6');
  await popover(page).getByRole('switch', { name: '貫通', exact: true }).click();
  const token = await beginRecompute(page);
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
  await waitForRecompute(page, token);
}

test.describe('EX-18 数式の座標の画面', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('式で置いた箱と式の点で穴をあけ、保存・開き直して幅の式を直し、欄ごとの Undo/Redo で戻せる', async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await disableFilePickers(page);
    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) 箱を寸法の式で置き、中心の座標を式にする。板は x 0〜40, y 0〜30, z 0〜10 で 12000 mm³。
    await placeMathBox(page);
    await solidRow(page, '箱1').click();
    await expect(propertyField(page, 'X の長さ')).toHaveValue('4*10');
    await setExpression(page, 'X', '(4*10)/2', '箱1', solidRow);
    await setExpression(page, 'Y', '30/2', '箱1', solidRow);
    await setExpression(page, 'Z', '10/2', '箱1', solidRow);
    await expectVolume(page, 40 * 30 * 10);

    // 2) 穴の中心を式の座標の点で打つ(上面 z=10 の x=10, y=15)。
    await sketchTool(page, '点').click();
    await expect(popoverTitle(page)).toHaveText('点を作る');
    await fillFields(page, ['40/4', '30/2', '10']);
    await commitPopover(page);
    await cancelPopover(page);
    await expect(treeRow(page, '点1')).toBeVisible();

    // 3) 箱の上面と点1 で φ6 の貫通穴をあける。
    await drillThroughHole(page);
    await expect(solidRow(page, '穴1')).toBeVisible();
    await solidRow(page, '穴1').click();
    await expectVolume(page, BRACKET_40);
    await expect(propertyValue(page, '加工するもとの立体')).toHaveText('箱1');

    // 4) 保存して開き直す。式のまま戻り、同じ体積になる。
    const savedPath = info.outputPath('ex18-math-bracket.pcad');
    await saveFlowFile(page, savedPath);
    await openSaveFlowFile(page, savedPath);
    await expect(solidRow(page, '箱1')).toBeVisible();
    await expect(solidRow(page, '穴1')).toBeVisible();
    await solidRow(page, '箱1').click();
    await expect(propertyField(page, 'X の長さ')).toHaveValue('4*10');
    await expect(propertyField(page, 'X')).toHaveValue('(4*10)/2');
    await solidRow(page, '穴1').click();
    await expectVolume(page, BRACKET_40);

    // 5) 開き直した箱の幅を式で 5*10 に、中心を (5*10)/2 に直す。左の面は x=0 のままで、穴は x=10 に残る。
    await solidRow(page, '箱1').click();
    await setExpression(page, 'X の長さ', '5*10', '箱1', solidRow);
    await setExpression(page, 'X', '(5*10)/2', '箱1', solidRow);
    await solidRow(page, '穴1').click();
    await expectVolume(page, BRACKET_50);

    // 6) 欄ごとに 1 段: 2 回の Undo で幅 40 の式へ、2 回の Redo で幅 50 の式へ戻る(焦点は木の行)。
    let token = await beginRecompute(page);
    await page.keyboard.press('Control+z');
    await waitForRecompute(page, token);
    token = await beginRecompute(page);
    await page.keyboard.press('Control+z');
    await waitForRecompute(page, token);
    await solidRow(page, '箱1').click();
    await expect(propertyField(page, 'X の長さ')).toHaveValue('4*10');
    await expect(propertyField(page, 'X')).toHaveValue('(4*10)/2');
    await solidRow(page, '穴1').click();
    await expectVolume(page, BRACKET_40);
    token = await beginRecompute(page);
    await page.keyboard.press('Control+y');
    await waitForRecompute(page, token);
    token = await beginRecompute(page);
    await page.keyboard.press('Control+y');
    await waitForRecompute(page, token);
    await solidRow(page, '箱1').click();
    await expect(propertyField(page, 'X の長さ')).toHaveValue('5*10');
    await expect(propertyField(page, 'X')).toHaveValue('(5*10)/2');
    await solidRow(page, '穴1').click();
    await expectVolume(page, BRACKET_50);

    expect(errors).toEqual([]);
  });
});
