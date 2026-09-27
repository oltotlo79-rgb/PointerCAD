import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { exactMathScenarioTimeout, undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';
import { reopenPart } from './reopenPart.js';
import { savePart } from './scriptsFlow.js';
import { uiMessage } from './uiMessages.js';

/*
 * MC-21b (ADD-22 items 22-06 and 22-07): the indefinite integral on the real screen, the real calculation Worker and
 * the real exact runtime, in Chromium, Firefox and real Electron. The answer is shown as an antiderivative with its
 * integration constant, can be applied neither to a coefficient nor to a coordinate, keeps its meaning through the
 * structured input and back, and is refused the same way after the document is saved and reopened. A definite
 * integral of the same integrand is then used as the coefficient, followed by a coordinate, saved, reopened, edited
 * and undone. The expected sentences are the product's own (i18n through uiMessage, the antiderivative text from
 * mathIndefiniteIntegralResult.test.ts, which checks the same strings on the real runtime's reply), and every shown
 * text is logged as [実測] before it is compared (rules/06 §10.329).
 * The function-plot use (the reason for Y = integrate(X^2,X) and plotting X^3/3+1) belongs to the function-plot flows.
 */

/**
 * The coefficient editor, the X editor beside the first recomputation, the Y editor, the reopened recomputation, the
 * re-edit editor and the edited recomputation settled before Undo: six exact-runtime preparations in sequence, the
 * same count as the coordinate flows (EXACT_COORDINATE_SCENARIO_TIMEOUT_MS). Undo then reuses the settled part.
 */
export const INDEFINITE_INTEGRALS_SCENARIO_TIMEOUT_MS = exactMathScenarioTimeout(6);
/** The shared limit of one result (mathEditorReady.ts: results 225 s); it never extends a product deadline. */
const RESULT_TIMEOUT_MS = 225_000;

const m = (key: string): string => uiMessage('math', key);
const PARAMETER = '不定積分の確認';
const INDEFINITE = 'integrate(t^2,t)';
const ANTIDERIVATIVE = `${m('math.indefiniteIntegral.antiderivative')}: 1/3 * t^3 + C`;
/** The definite integral of the same integrand is a number: 3^3/3 = 9. */
const SOURCE = 'integrate(t^2,t,0,3)';
/** The re-edit widens the range: 6^3/3 = 72. */
const CHANGED_SOURCE = 'integrate(t^2,t,0,6)';
const COORDINATE = `coef("${PARAMETER}")`;
/** The Y coordinate: the integral of t from 0 to 2 is 2. */
const Y_SOURCE = 'integrate(t,t,0,2)';

async function shownText(locator: Locator, label: string): Promise<string> {
  const text = await locator.innerText();
  console.log(`[実測] ${label}: ${text}`);
  return text;
}

/** An antiderivative is displayed with its constant and the reason why it cannot be applied as a number. */
async function expectAntiderivative(dialog: Locator, message: string, detail: string): Promise<void> {
  const result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const lines = result.locator('p');
  await expect(lines.first()).toHaveText(message, { timeout: RESULT_TIMEOUT_MS });
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(1)).toHaveText(detail);
  await shownText(result, `不定積分 ${message}`);
  await expect(result).not.toHaveClass(/pcad-math-editor__result--error/u);
  await expect(dialog.getByRole('button', { name: 'この式を使う', exact: true })).toBeDisabled();
}

/** Every indefinite answer below is refused as a number; the hint says so in the product's words. */
async function checkIndefiniteAnswers(dialog: Locator): Promise<void> {
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  const hint = m('math.indefiniteIntegral.hint');
  expect(hint).toContain('座標・成分・係数の数値には使えません');
  await input.fill(INDEFINITE);
  await expectAntiderivative(dialog, ANTIDERIVATIVE, hint);
  // The structured input shows the same integral without bounds, keeps the answer, and returns the typed source.
  // Wait for each result before switching: switching while a calculation runs cancels it (rules/06 §10.149).
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  const field = dialog.locator('math-field');
  await expect(field).toBeFocused();
  await expectAntiderivative(dialog, ANTIDERIVATIVE, hint);
  const latex = await field.evaluate(element => String(Reflect.get(element, 'value')));
  console.log(`[実測] 不定積分の構造入力: ${latex}`);
  // Read from the real screen first (Chromium, RUN 20260925-082702): the switch shows the named operation without
  // bounds, which reads back to the same integral; typing the ∫ form itself is covered by exactIndefiniteIntegrals.test.ts.
  expect(latex).toBe(String.raw`\operatorname{integrate}\left({\left(t\right)}^{2},t\right)`);
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(INDEFINITE);
  await expectAntiderivative(dialog, ANTIDERIVATIVE, hint);
  // The zero integrand is the constant function 0 + C, not the number 0.
  await input.fill('integrate(0,t)');
  await expectAntiderivative(dialog, `${m('math.indefiniteIntegral.antiderivative')}: 0 + C`, hint);
  // Only an antiderivative written with ln adds the note on reading it in the real range (22-07).
  await input.fill('integrate(1/t,t)');
  await expectAntiderivative(dialog, `${m('math.indefiniteIntegral.antiderivative')}: ln(t) + C`,
    `${hint} ${m('math.indefiniteIntegral.lnRealNote')}`);
  // No single closed form: the value stays undetermined instead of an unchecked answer.
  await input.fill('integrate(sin(sin(t)),t)');
  await expect(result).toHaveText(m('math.unresolved'), { timeout: RESULT_TIMEOUT_MS });
  await shownText(result, '閉じた形の無い不定積分');
  await expect(apply).toBeDisabled();
  // A variable called C would be confused with the constant, which is then named K.
  await input.fill('integrate(C^2,C)');
  await expectAntiderivative(dialog, `${m('math.indefiniteIntegral.antiderivative')}: 1/3 * C^3 + K`,
    m('math.indefiniteIntegral.hintConstantK'));
}

/** The whole-formula indefinite integral is shown as F + C, refused as a number, and survives save, reopen and Undo. */
export async function mathIndefiniteIntegralsFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill(PARAMETER); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  await checkIndefiniteAnswers(dialog);
  // With bounds the same integrand is a number and can be applied.
  await input.fill(SOURCE);
  await expect(result).toHaveText('= 9', { timeout: RESULT_TIMEOUT_MS });
  await expect(apply).toBeEnabled();
  await apply.click(); await expect(dialog).toHaveCount(0);

  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover');
  await popover.getByRole('button', { name: /数式で入力/u }).nth(0).click();
  await waitForMathEditorText(dialog); await input.fill(COORDINATE);
  await expect(result).toHaveText('= 9', { timeout: RESULT_TIMEOUT_MS });
  await apply.click(); await expect(dialog).toHaveCount(0);
  // A coordinate needs one real number: the antiderivative cannot be applied there either.
  await popover.getByRole('button', { name: /数式で入力/u }).nth(1).click();
  await waitForMathEditorText(dialog); await input.fill(INDEFINITE);
  await expectAntiderivative(dialog, ANTIDERIVATIVE, m('math.indefiniteIntegral.hint'));
  await input.fill(Y_SOURCE);
  await expect(result).toHaveText('= 2', { timeout: RESULT_TIMEOUT_MS });
  await apply.click(); await expect(dialog).toHaveCount(0);
  await popover.locator('input.pcad-field__input').nth(2).fill('0');
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();

  const saved = await savePart(page, info, 'indefinite-integrals.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === PARAMETER)?.value).toMatchObject({
    value: 9, source: SOURCE, mathDefinition: { source: SOURCE, angleUnit: 'degree' },
  });
  const point = saved.sketches[0].features.find(feature => feature.kind === 'point');
  if (point?.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('定積分の答えを使った点がありません。');
  expect(point.at.x).toMatchObject({ value: 9, source: COORDINATE });
  expect(point.at.y).toMatchObject({ value: 2, source: Y_SOURCE });

  await reopenPart(page, info, 'indefinite-integrals.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  await expect(input).toHaveValue(SOURCE); await expect(result).toHaveText('= 9', { timeout: RESULT_TIMEOUT_MS });
  // The reopened document still refuses the indefinite integral as its coefficient.
  await input.fill(INDEFINITE);
  await expectAntiderivative(dialog, ANTIDERIVATIVE, m('math.indefiniteIntegral.hint'));
  await page.keyboard.press('F1');
  const help = page.locator('.pcad-help__article');
  await expect(help).toContainText('不定積分（原始関数）');
  await expect(help).toContainText('積分定数は値が1つに決まらないため');
  await page.keyboard.press('Escape');
  await input.fill(CHANGED_SOURCE); await expect(result).toHaveText('= 72', { timeout: RESULT_TIMEOUT_MS });
  await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'indefinite-integrals-edited.pcad', app);
  expect(edited.parameters.find(parameter => parameter.name === PARAMETER)?.value).toMatchObject({ value: 72, source: CHANGED_SOURCE });
  expect(edited.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 72, source: COORDINATE } } });
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'indefinite-integrals-undone.pcad', app);
  expect(undone.parameters.find(parameter => parameter.name === PARAMETER)?.value).toMatchObject({ value: 9, source: SOURCE });
  expect(undone.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 9, source: COORDINATE } } });
}
