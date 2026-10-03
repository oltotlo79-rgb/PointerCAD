import { writeFile } from 'node:fs/promises';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForMathEditorText } from './mathEditorReady.js';
import { MATH_GEOMETRY_FIXTURE, MATH_GEOMETRY_FIXTURE_FILE, mathGeometryFixtureDocument, mathGeometryFixtureFile } from './mathGeometryFixture.js';
import { beginRecompute, readRecomputeStats, waitForRecomputeOutcome, waitForSettledRecompute, type RecomputeToken } from './recompute.js';
import { reopenPart } from './reopenPart.js';
import { uiMessage } from './uiMessages.js';

/*
 * 「構造化した数式と係数を入力する」章の「図形の測定値を数式で使う」→「積分にこの値を使う」の1枚
 * (`packages/help-content/docs/ja/math-input.md`、FIX-01 / F01)。
 *
 * math-geometry-integral: 図形の測定値の道具で線分1(50mm)の長さを測って「長さ」と名付け、「この値の係数を作る」で
 * 係数「長さの値」を作り、新しい係数「積分の値」の数式入力で線積分の座標式にその係数を使った画面。
 * 式は章の表の「線積分 / 座標式」の形 `lineintegral(1,[x],[coef("長さの値")*t],t,0,1)` で、答えは長さと同じ50。
 * 数式入力のパレットの「図形の測定値」に「長さ」が並ぶ。
 *
 * 道具・行・係数の操作と待ち方は `mathGeometryReferenceFlow.ts`(GR-24、その関数は外へ出していないので
 * 同じ作りをここに写した)、係数の追加と数式入力・答えの待ち時間は `mathLineIntegralsFlow.ts` と同じ。
 * 図形は `mathGeometryFixture.ts` の文書を開き直して使い、実際の計算部で測る。
 */
const SCRIPT = new URL('./mathGeometryIntegralCaptureFlow.ts', import.meta.url);
const m = (key: string): string => uiMessage('mathGeometry', key);
const TOOL = m('toolbar.look.mathGeometry');
const LOOK_MENU = uiMessage('toolbar', 'toolbar.look.groupLabel');
const MM = uiMessage('view', 'measure.unit.millimeter');
const { line1 } = MATH_GEOMETRY_FIXTURE;
const LENGTH = '長さ', LENGTH_COEFFICIENT = `${LENGTH}${m('mathGeometry.createParameter.nameSuffix')}`;
const RESULT_NAME = '積分の値';
const SOURCE = `lineintegral(1,[x],[coef("${LENGTH_COEFFICIENT}")*t],t,0,1)`;
/** 線分1は (0,0) から (50,0)。 */
const LINE_LENGTH = 50;

const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  Object.entries(values).reduce((text, [name, value]) => text.split(`{${name}}`).join(value), template);
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const panel = (page: Page): Locator => page.getByRole('region', { name: m('mathGeometry.title'), exact: true });
const notice = (page: Page): Locator => panel(page).getByRole('status');
const rows = (page: Page): Locator => panel(page).locator('li[data-math-geometry-id]');
const quantity = (page: Page): Locator => panel(page).getByRole('combobox', { name: m('mathGeometry.quantityLabel'), exact: true });
const nameField = (row: Locator): Locator => row.getByRole('textbox', { name: m('mathGeometry.nameLabel'), exact: true });
const rowProperty = (row: Locator, key: string): Locator => row.locator('dt.pcad-properties__key')
  .filter({ hasText: new RegExp(`^${escapeRegExp(m(key))}$`, 'u') }).locator('xpath=following-sibling::dd[1]');
const tree = (page: Page, name: string): Locator => page.locator('.pcad-panel--left').getByRole('button', { name, exact: true });
const tab = (page: Page, key: string): Locator => page.getByRole('tab', { name: uiMessage('propertyPanel', key), exact: true });
const parameterRow = (page: Page, name: string): Locator => page.locator('.pcad-parameter').filter({
  has: page.getByRole('textbox', { name: `${uiMessage('parameters', 'parameterPanel.nameLabel')} ${name}`, exact: true }) });
const parameterSource = (page: Page, name: string): Locator => parameterRow(page, name).getByRole('textbox',
  { name: `${uiMessage('parameters', 'parameterPanel.sourceLabel')} ${name}`, exact: true });
const parameterMessage = (page: Page, name: string): Locator => parameterRow(page, name).locator('.pcad-field').nth(1).locator('.pcad-field__message');

/** 1回の編集で再計算がちょうど1世代進み、成功で終わる(`mathGeometryReferenceFlow.ts` の settle と同じ)。 */
async function settle(page: Page, token: RecomputeToken): Promise<void> {
  await waitForRecomputeOutcome(page, token, 'success');
  const stats = await readRecomputeStats(page);
  expect(stats.requestedGeneration, '1回の操作で再計算がちょうど1世代進むこと').toBe(token.requestedGeneration + 1);
  expect(stats.completedGeneration).toBe(stats.requestedGeneration);
}

export async function mathGeometryIntegralCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await writeFile(info.outputPath(MATH_GEOMETRY_FIXTURE_FILE), mathGeometryFixtureFile(), { flag: 'wx' });
  await reopenPart(page, info, MATH_GEOMETRY_FIXTURE_FILE);
  const fixture = mathGeometryFixtureDocument();

  // 道具を出し、線分1を選んで長さを追加する。
  await chooseToolMenuItem(page, LOOK_MENU, TOOL);
  await expect(panel(page)).toBeVisible();
  await tree(page, line1.name).click();
  await expect(quantity(page).locator('option')).toHaveText([m('mathGeometry.kind.length')]);
  await quantity(page).selectOption({ label: m('mathGeometry.kind.length') });
  let token = await beginRecompute(page);
  await panel(page).getByRole('button', { name: m('mathGeometry.add'), exact: true }).click();
  await settle(page, token);
  await expect(rows(page)).toHaveCount(1);
  const row = rows(page).nth(0);
  await expect(rowProperty(row, 'mathGeometry.quantityLabel')).toHaveText(m('mathGeometry.kind.length'));
  await expect(rowProperty(row, 'mathGeometry.valueLabel')).toHaveText(`${String(LINE_LENGTH)} ${MM}`);

  // 名前を「長さ」に変え、「この値の係数を作る」で係数「長さの値」を作る。
  token = await beginRecompute(page);
  await nameField(row).fill(LENGTH);
  await nameField(row).press('Enter');
  await settle(page, token);
  await expect(nameField(row)).toHaveValue(LENGTH);
  token = await beginRecompute(page);
  await row.getByRole('button', { name: m('mathGeometry.createParameter'), exact: true }).click();
  await expect(notice(page)).toHaveText(fill(m('mathGeometry.createParameter.notice'), { name: LENGTH_COEFFICIENT }));
  await settle(page, token);

  // 新しい係数を足し、数式入力で線積分の座標式に「長さの値」を使う。
  await tab(page, 'propertyPanel.tabParameters').click();
  await expect(parameterSource(page, LENGTH_COEFFICIENT)).toHaveValue(`coef("${LENGTH}")`);
  await expect(parameterMessage(page, LENGTH_COEFFICIENT)).toHaveText(`= ${String(LINE_LENGTH)}`);
  // 係数を足すと測り直しが走り、その間は名前を変えられない(「図形の測定値を計算中です。」と断られる。
  // RUN 20261001-202705 で2本同時に流した時に起きた)。足した後と改名の後は再計算の終わりを待つ。
  const parameterCount = await page.locator('.pcad-parameter').count();
  token = await beginRecompute(page);
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  await settle(page, token);
  await expect(page.locator('.pcad-parameter')).toHaveCount(parameterCount + 1);
  const added = page.locator('.pcad-parameter').last();
  const name = added.locator('.pcad-field').first().locator('input');
  await name.fill(RESULT_NAME);
  token = await beginRecompute(page);
  await name.press('Enter');
  await settle(page, token);
  await expect(parameterSource(page, RESULT_NAME)).toBeVisible();
  await waitForSettledRecompute(page);
  await parameterRow(page, RESULT_NAME).getByRole('button', { name: uiMessage('math', 'math.open'), exact: true }).click();
  const dialog = page.locator('.pcad-math-dialog');
  await waitForMathEditorText(dialog);
  const geometryGroup = dialog.getByRole('group', { name: m('mathGeometry.palette.group'), exact: true });
  await expect(geometryGroup.getByRole('button')).toHaveText([LENGTH]);
  await expect(dialog.getByRole('group', { name: uiMessage('math', 'math.coefficients'), exact: true })
    .getByRole('button', { name: LENGTH_COEFFICIENT, exact: true })).toBeVisible();
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  await input.fill(SOURCE);
  await expect(result).toHaveText(`= ${String(LINE_LENGTH)}`, { timeout: 225_000 });
  const apply = dialog.getByRole('button', { name: uiMessage('math', 'math.apply'), exact: true });
  await expect(apply).toBeEnabled();
  await captureManualDetail(page, info, { name: 'math-geometry-integral', dialog, script: SCRIPT,
    fixture: { document: fixture, measured: { name: LENGTH, kind: 'length', target: line1.name, value: LINE_LENGTH },
      coefficient: LENGTH_COEFFICIENT, parameter: RESULT_NAME, source: SOURCE, expected: LINE_LENGTH } });

  // 適用すると係数「積分の値」は50になり、図形由来の印が付く。
  token = await beginRecompute(page);
  await apply.click();
  await expect(dialog).toHaveCount(0);
  await settle(page, token);
  await expect(parameterSource(page, RESULT_NAME)).toHaveValue(SOURCE);
  await expect(parameterMessage(page, RESULT_NAME)).toHaveText(`= ${String(LINE_LENGTH)}`);
  await expect(parameterRow(page, RESULT_NAME).locator('.pcad-parameter__mark').first()).toHaveText(m('mathGeometry.derived'));
}
