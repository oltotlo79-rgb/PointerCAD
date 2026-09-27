import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { CLOSED_CURVE_OPEN, CLOSED_CURVE_UNPROVED, CLOSED_SURFACE_OPEN } from '../../packages/expression/src/math/closedIntegrals.js';
import { exactMathScenarioTimeout, undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';
import { reopenPart } from './reopenPart.js';
import { savePart } from './scriptsFlow.js';
import { uiMessage } from './uiMessages.js';

/*
 * MC-21b (ADD-23 item 23-04): ∮ and ∯ on the real screen, the real calculation Worker and the real exact runtime, in
 * Chromium, Firefox and real Electron. The closure of the curve or surface is proved in the saved angle unit before
 * the integral is calculated, and an open or unprovable one is refused with its own reason (the product's sentences
 * from closedIntegrals.ts). The closed integral is then used as a coefficient and ∯ as a coordinate, kept through the
 * structured input, saved, reopened, edited and undone. Every shown text is logged as [実測] before it is compared
 * (rules/06 §10.329); the values are independent: the circulation of [-y,x] around a circle of radius r is 2πr², and
 * the area of the unit sphere is 4π.
 */

/**
 * The coefficient editor, the X editor beside the first recomputation, the Y editor, the reopened recomputation, the
 * re-edit editor and the edited recomputation settled before Undo: six exact-runtime preparations in sequence, the
 * same count as the coordinate flows (EXACT_COORDINATE_SCENARIO_TIMEOUT_MS). Undo then reuses the settled part.
 */
export const CLOSED_INTEGRALS_SCENARIO_TIMEOUT_MS = exactMathScenarioTimeout(6);
/** The shared limit of one result (mathEditorReady.ts: results 225 s); it never extends a product deadline. */
const RESULT_TIMEOUT_MS = 225_000;

const PARAMETER = '閉路積分の値';
const CIRCLE = '∮([-y,x],[x,y],[cos(t),sin(t)],t,0,';
/** One turn in degrees: 2π. */
const SOURCE = `${CIRCLE}360)`;
/** The re-edit doubles the radius: 2π·2² = 8π. */
const CHANGED_SOURCE = '∮([-y,x],[x,y],[2*cos(t),2*sin(t)],t,0,360)';
const SPHERE = '[sin(u)*cos(v),sin(u)*sin(v),cos(u)]';
/** The unit sphere is closed over 0-180 and 0-360 degrees: its area is 4π. */
const Y_SOURCE = `∯(1,[x,y,z],${SPHERE},[u,v],[0,0],[180,360])`;
const COORDINATE = `coef("${PARAMETER}")`;
const TWO_PI = /^= 6\.28318530717/u, FOUR_PI = /^= 12\.5663706143/u, EIGHT_PI = /^= 25\.1327412287/u;

async function expectRefused(dialog: Locator, reason: string, label: string): Promise<void> {
  const result = dialog.locator('.pcad-math-editor__result[role="status"]');
  await expect(result).toHaveText(reason, { timeout: RESULT_TIMEOUT_MS });
  console.log(`[実測] ${label}: ${await result.innerText()}`);
  await expect(dialog.locator('textarea')).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.getByRole('button', { name: 'この式を使う', exact: true })).toBeDisabled();
}

async function expectValue(dialog: Locator, value: RegExp, label: string): Promise<void> {
  const result = dialog.locator('.pcad-math-editor__result[role="status"]');
  await expect(result).toHaveText(value, { timeout: RESULT_TIMEOUT_MS });
  console.log(`[実測] ${label}: ${await result.innerText()}`);
  await expect(dialog.getByRole('button', { name: 'この式を使う', exact: true })).toBeEnabled();
}

/** Closure is proved in the chosen angle unit before calculating; open and unprovable cases are refused. */
async function checkClosure(dialog: Locator): Promise<void> {
  const input = dialog.locator('textarea');
  const angle = dialog.getByRole('combobox', { name: uiMessage('math', 'math.angleUnit'), exact: true });
  await input.fill(SOURCE);
  await expectValue(dialog, TWO_PI, '∮ 度で1周');
  // In radians 0-360 is not a whole number of turns: the same source is recalculated and refused.
  await angle.selectOption('radian');
  await expectRefused(dialog, CLOSED_CURVE_OPEN, '∮ ラジアンで0〜360');
  // Closed only up to rounding is never accepted as closed.
  await input.fill(`${CIRCLE}6.283185307179586)`);
  await expectRefused(dialog, CLOSED_CURVE_UNPROVED, '∮ 丸めた2π');
  await input.fill(`${CIRCLE}2*pi)`);
  await expectValue(dialog, TWO_PI, '∮ ラジアンで0〜2π');
  await angle.selectOption('degree');
  // Wait for each result first: switching while a calculation runs cancels it (rules/06 §10.149).
  await expectRefused(dialog, CLOSED_CURVE_OPEN, '∮ 度で0〜2π');
  await input.fill(`${CIRCLE}180)`);
  await expectRefused(dialog, CLOSED_CURVE_OPEN, '∮ 半周');
  // A half sphere is not closed; the whole sphere is, and its outward flux of [x,y,z] is 4π as well.
  await input.fill(`∯(1,[x,y,z],${SPHERE},[u,v],[0,0],[90,360])`);
  await expectRefused(dialog, CLOSED_SURFACE_OPEN, '∯ 半球');
  await input.fill(`∯([x,y,z],[x,y,z],${SPHERE},[u,v],[0,0],[180,360])`);
  await expectValue(dialog, FOUR_PI, '∯ 球の流束');
  // The structured input shows ∮ as \oint, keeps the value and returns the typed source.
  await input.fill(SOURCE);
  await expectValue(dialog, TWO_PI, '∮ 度で1周（表示切替の前）');
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  const field = dialog.locator('math-field');
  await expect(field).toBeFocused();
  await expectValue(dialog, TWO_PI, '∮ 構造入力');
  const latex = await field.evaluate(element => String(Reflect.get(element, 'value')));
  console.log(`[実測] ∮ の構造入力: ${latex}`);
  expect(latex).toMatch(/^\\oint\\left\(/u);
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(SOURCE);
  await expectValue(dialog, TWO_PI, '∮ テキスト入力へ戻す');
}

/** ∮ as a coefficient and ∯ as a coordinate survive save, reopen, edit and Undo. */
export async function mathClosedIntegralsFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill(PARAMETER); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  await checkClosure(dialog);
  await apply.click(); await expect(dialog).toHaveCount(0);

  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover');
  for (const [axis, expression, value] of [[0, COORDINATE, TWO_PI], [1, Y_SOURCE, FOUR_PI]] as const) {
    await popover.getByRole('button', { name: /数式で入力/u }).nth(axis).click();
    await waitForMathEditorText(dialog); await input.fill(expression);
    await expectValue(dialog, value, `座標 ${expression}`);
    await apply.click(); await expect(dialog).toHaveCount(0);
  }
  await popover.locator('input.pcad-field__input').nth(2).fill('0');
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();

  const saved = await savePart(page, info, 'closed-integrals.pcad', app);
  const parameter = saved.parameters.find(item => item.name === PARAMETER)?.value;
  expect(parameter).toMatchObject({ source: SOURCE, mathDefinition: { source: SOURCE, angleUnit: 'degree' } });
  expect(parameter?.value).toBeCloseTo(2 * Math.PI, 12);
  const point = saved.sketches[0].features.find(feature => feature.kind === 'point');
  if (point?.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('閉じた積分の答えを使った点がありません。');
  expect(point.at.x).toMatchObject({ source: COORDINATE });
  expect(point.at.x.value).toBeCloseTo(2 * Math.PI, 12);
  expect(point.at.y).toMatchObject({ source: Y_SOURCE });
  expect(point.at.y.value).toBeCloseTo(4 * Math.PI, 12);

  await reopenPart(page, info, 'closed-integrals.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  await expect(input).toHaveValue(SOURCE);
  await expectValue(dialog, TWO_PI, '∮ 再開後');
  await page.keyboard.press('F1');
  const help = page.locator('.pcad-help__article');
  await expect(help).toContainText('閉じた曲線・曲面で積分する');
  await expect(help).toContainText(CLOSED_CURVE_OPEN);
  await page.keyboard.press('Escape');
  await input.fill(CHANGED_SOURCE);
  await expectValue(dialog, EIGHT_PI, '∮ 半径2');
  await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'closed-integrals-edited.pcad', app);
  expect(edited.parameters.find(item => item.name === PARAMETER)?.value).toMatchObject({ source: CHANGED_SOURCE });
  const editedPoint = edited.sketches[0].features.find(feature => feature.kind === 'point');
  if (editedPoint?.kind !== 'point' || editedPoint.at.mode !== 'absolute') throw new Error('編集後の点がありません。');
  expect(editedPoint.at.x.value).toBeCloseTo(8 * Math.PI, 12);
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'closed-integrals-undone.pcad', app);
  const undoneParameter = undone.parameters.find(item => item.name === PARAMETER)?.value;
  expect(undoneParameter).toMatchObject({ source: SOURCE });
  expect(undoneParameter?.value).toBeCloseTo(2 * Math.PI, 12);
  const undonePoint = undone.sketches[0].features.find(feature => feature.kind === 'point');
  if (undonePoint?.kind !== 'point' || undonePoint.at.mode !== 'absolute') throw new Error('Undo後の点がありません。');
  expect(undonePoint.at.x).toMatchObject({ source: COORDINATE });
  expect(undonePoint.at.x.value).toBeCloseTo(2 * Math.PI, 12);
}
