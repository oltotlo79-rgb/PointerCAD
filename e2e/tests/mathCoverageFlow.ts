/// <reference lib="dom" />
import { readFileSync } from 'node:fs';
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { NABLA_VARIABLES_REQUIRED } from '../../packages/expression/src/math/differentialEquationNotation.js';
import { RATIO_TERMS } from '../../packages/expression/src/math/mathTextSyntax.js';
import { exactMathScenarioTimeout, focusField, undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { reopenPart } from './reopenPart.js';
import { savePart } from './scriptsFlow.js';
import { uiMessage } from './uiMessages.js';

/*
 * MC-21 (scratchpad/claude/plans/math-add-coverage.md §7.2, items 19-02 and 28-06): the notations of the second math
 * wave on the real screen, the real calculation Worker and the real exact runtime. They are entered in the ordinary
 * editor, used in a coefficient and in point coordinates, then saved, reopened, edited, undone and explained by F1.
 * The same steps run in Chromium, Firefox and real Electron. Labels come from the product catalogs (uiMessage) and the
 * refusals from the product's own sentences; every shown value is logged as [実測] before it is compared, and the
 * expectations were read from the real screen first (Chromium and Firefox, RUN 20260924-102244, rules/06 §10.329).
 * Added later as their own tests once the features are finished: the refused indefinite integral (MC-20), the catalog
 * search of the new items (MC-02d) and ∮・∯ (MC-19d).
 */

/**
 * The coefficient editor, the X editor beside the first recomputation, the Y editor, the reopened recomputation, the
 * re-edit editor and the edited recomputation settled before Undo: six exact-runtime preparations in sequence, the same
 * count as the coordinate flows (EXACT_COORDINATE_SCENARIO_TIMEOUT_MS). Undo then reuses the settled calculation part.
 * Measured on 2026-09-24 with 2 workers while the point's recomputation was still awaited (one preparation more):
 * Chromium 84.6 s, Firefox 370.8 s with each preparation taking 44-55 s (RUN 20260924-102244).
 */
export const MATH_COVERAGE_SCENARIO_TIMEOUT_MS = exactMathScenarioTimeout(6);
/** The shared limit of one result (mathEditorReady.ts: results 225 s); it never extends a product deadline. */
const RESULT_TIMEOUT_MS = 225_000;

const m = (key: string): string => uiMessage('math', key);
const COEFFICIENT = '網羅の係数';
/** A set relation chooses the branch of a case distinction whose value is a dot product: 1·4 + 2·5 + 3·6 = 32. */
const COEFFICIENT_SOURCE = 'which({1}⊂{1,2},[1,2,3]·[4,5,6],true,0)';
/** The re-edit changes one component: 1·4 + 2·5 + 3·7 = 35. */
const EDITED_COEFFICIENT_SOURCE = 'which({1}⊂{1,2},[1,2,3]·[4,5,7],true,0)';
/** The X coordinate after fixing the sign of coef ± 1. */
const X_SOURCE = `coef("${COEFFICIENT}")+1`;
/** The Y coordinate chosen with the component picker from the transposed matrix: row 1, column 2 of [[1,3],[2,4]]. */
const Y_SOURCE = 'tensorelement(transpose([[1,2],[3,4]]),[1,2])';
const MATH_FORMAT = 'pointercad-math/1';
/** 1/3 is exact: the editor shows 40 significant digits and no error bound. */
const ONE_THIRD = `0.${'3'.repeat(40)}`;

interface MathEditor {
  readonly page: Page;
  readonly dialog: Locator;
  readonly input: Locator;
  readonly field: Locator;
  readonly apply: Locator;
}
/** MathLive adds its own status announcer in structured input; the application result keeps its class. */
const RESULT_SELECTOR = '.pcad-math-dialog .pcad-math-editor__result[role="status"]';
function mathEditor(page: Page): MathEditor {
  const dialog = page.locator('.pcad-math-dialog');
  return { page, dialog, input: dialog.locator('textarea'), field: dialog.locator('math-field'),
    apply: dialog.getByRole('button', { name: m('math.apply'), exact: true }) };
}

/** What the result area shows once the editor has finished with the current input. */
interface Shown { readonly message: string; readonly detail: string; readonly error: boolean }
/**
 * Typing publishes "数式を入力してください。" at once, then the calculation (and the first time the preparation) runs;
 * only the state after them is read, so a previous input's result is never taken for the current one.
 * The paragraphs and the error mark are read in one evaluation, i.e. from one render. Playwright's allInnerTexts()
 * finds the paragraphs and reads their text in two round trips: when "数式を計算しています。" (one paragraph) was
 * replaced by the |A| candidates (two paragraphs) in between, the new message was read without its detail
 * (independent copy, delivery 20260924-103433, trace call@8526).
 */
const PENDING: ReadonlySet<string> = new Set([m('math.editing'), m('math.calculating'), m('math.preparingExact')]);
async function settledResult(editor: MathEditor, what: string): Promise<Shown> {
  let shown: Shown = { message: '', detail: '', error: false };
  await expect.poll(async () => {
    const read = await editor.page.evaluate(selector => {
      const results = document.querySelectorAll(selector);
      const result = results.length === 1 ? results[0] : undefined;
      return result === undefined ? null : { paragraphs: Array.from(result.querySelectorAll('p'), paragraph => paragraph.innerText),
        error: result.classList.contains('pcad-math-editor__result--error') };
    }, RESULT_SELECTOR);
    const [message = '', detail = ''] = read?.paragraphs ?? [];
    shown = { message, detail, error: read?.error ?? false };
    return read === null || message === '' || PENDING.has(message) ? 'pending' : 'settled';
  }, { message: `${what} の結果を表示すること`, timeout: RESULT_TIMEOUT_MS }).toBe('settled');
  console.log(`[実測] ${what} → ${shown.message}${shown.detail === '' ? '' : ` ／ ${shown.detail}`}${shown.error ? '（誤りの表示）' : ''}`);
  return shown;
}

/**
 * The outcomes a coefficient or coordinate field distinguishes: a value it can use ("= …", exactly or to 12 digits),
 * a result shown but not usable as one number (candidates, true/false, a vector), or a refusal with its reason.
 */
type Outcome =
  | { readonly value: string }
  | { readonly near: number }
  | { readonly shown: string; readonly detail?: string }
  | { readonly refused: string };
/** Whether a settled reading already matches the expected outcome (no assertion, just the comparison). */
function outcomeMatches(shown: Shown, outcome: Outcome): boolean {
  if (shown.error) return 'refused' in outcome && shown.message === outcome.refused && shown.detail === '';
  if ('value' in outcome) return shown.message === `= ${outcome.value}` && shown.detail === '';
  if ('near' in outcome) {
    if (shown.detail !== '' || !shown.message.startsWith('= ')) return false;
    const value = Number(shown.message.slice(2));
    return Number.isFinite(value) && Math.abs(value - outcome.near) < 5e-13;
  }
  if ('shown' in outcome) return shown.message === outcome.shown && shown.detail === (outcome.detail ?? '');
  return false;
}
/**
 * A structured-input notation change (e.g. adding the overline of MC-21) can leave the previous input's finished
 * result on screen for one render before the recalculation of the new one replaces it; settledResult only waits out
 * "計算中"/"数式を準備しています。" and would otherwise return that stale, already-settled value at once. Re-reading
 * settledResult until it matches the expected outcome (bounded by the same RESULT_TIMEOUT_MS as one read) tells the
 * stale render apart from a genuine mismatch while still reading paragraphs and the error mark from a single render.
 */
async function expectOutcome(editor: MathEditor, what: string, outcome: Outcome): Promise<void> {
  let shown: Shown = { message: '', detail: '', error: false };
  await expect.poll(async () => {
    shown = await settledResult(editor, what);
    return outcomeMatches(shown, outcome);
  }, { message: `${what} の結果が期待どおりに落ち着くこと`, timeout: RESULT_TIMEOUT_MS }).toBe(true);
  if ('value' in outcome) {
    expect(shown, what).toEqual({ message: `= ${outcome.value}`, detail: '', error: false });
  } else if ('near' in outcome) {
    expect({ ...shown, message: shown.message.slice(0, 2) }, what).toEqual({ message: '= ', detail: '', error: false });
    expect(Number(shown.message.slice(2)), what).toBeCloseTo(outcome.near, 12);
  } else if ('shown' in outcome) {
    expect(shown, what).toEqual({ message: outcome.shown, detail: outcome.detail ?? '', error: false });
  } else {
    expect(shown, what).toEqual({ message: outcome.refused, detail: '', error: true });
  }
  if ('value' in outcome || 'near' in outcome) await expect(editor.apply, `${what} は欄に使えること`).toBeEnabled();
  else await expect(editor.apply, `${what} は一つの数ではないため欄に使えないこと`).toBeDisabled();
}
async function enter(editor: MathEditor, what: string, source: string, outcome: Outcome): Promise<void> {
  await editor.input.fill(source);
  await expectOutcome(editor, `${what}「${source}」`, outcome);
}

/**
 * A vector or matrix result offers the component picker, one index per array axis and nothing preselected. An index
 * past its axis cannot be chosen; choosing wraps the typed formula in tensorelement(…,[indices]) in the text field.
 */
async function chooseComponent(editor: MathEditor, what: string, sizes: readonly number[], indices: readonly number[]): Promise<void> {
  const picker = editor.dialog.getByRole('group', { name: m('math.component.title'), exact: true });
  const choose = picker.getByRole('button', { name: m('math.component.choose'), exact: true });
  const axis = (number: number): Locator => picker.getByRole('spinbutton', { name: `${m('math.component.axis')} ${String(number)}`, exact: true });
  await expect(picker, `${what} から成分を選べること`).toBeVisible();
  await expect(picker.getByRole('spinbutton')).toHaveCount(sizes.length);
  for (const [index, size] of sizes.entries()) {
    await expect(axis(index + 1)).toHaveValue('');
    await expect(axis(index + 1)).toHaveAttribute('max', String(size));
  }
  await expect(choose).toBeDisabled();
  for (const [index, size] of sizes.entries()) await axis(index + 1).fill(String(size + 1));
  await expect(choose, '軸の大きさを超える番号は選べないこと').toBeDisabled();
  for (const [index, value] of indices.entries()) await axis(index + 1).fill(String(value));
  await expect(choose).toBeEnabled();
  const source = await editor.input.inputValue();
  await choose.click();
  await expect(editor.input).toHaveValue(`tensorelement(${source},[${indices.join(',')}])`);
  await expect(editor.input).toBeFocused();
  await expect(picker).toHaveCount(0);
}

async function structuredValue(field: Locator): Promise<string> {
  const value: unknown = await field.evaluate(element => Reflect.get(element, 'value'));
  if (typeof value !== 'string') throw new Error('構造入力の欄の値が文字列ではありません');
  return value;
}
/**
 * Typing and palette insertions reach the editor through MathLive's own input event. The field's LaTeX (read, like
 * math-keyboard.spec.ts, from the element) must be the new one before the result is read for it.
 */
async function expectStructured(field: Locator, what: string, latex: string): Promise<void> {
  await expect.poll(() => structuredValue(field), { message: `${what} の構造入力の欄の式` }).toBe(latex);
}

const parameterRow = (page: Page, name: string): Locator => page.locator('.pcad-parameter').filter({
  has: page.getByRole('textbox', { name: `${uiMessage('parameters', 'parameterPanel.nameLabel')} ${name}`, exact: true }) });
const parameterMessage = (page: Page, name: string): Locator => parameterRow(page, name).locator('.pcad-field').nth(1).locator('.pcad-field__message');
const openParameterEditor = (page: Page, name: string): Promise<void> =>
  parameterRow(page, name).getByRole('button', { name: m('math.open'), exact: true }).click();
const tab = (page: Page, key: string): Locator => page.getByRole('tab', { name: uiMessage('propertyPanel', key), exact: true });
const pointInTree = (page: Page): Locator => page.locator('.pcad-panel--left').getByRole('button', { name: '点1', exact: true });
const axisLabel = (axis: 'x' | 'y' | 'z'): string => uiMessage('numericInput', `numericInput.field.${axis}`);

type SavedDocument = Awaited<ReturnType<typeof savePart>>;
/** The saved formulas: every coefficient and the point's coordinates with their sources, values and definitions. */
function formulaFields(document: SavedDocument) {
  const point = document.sketches[0].features.find(feature => feature.kind === 'point');
  if (point?.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('座標を数式で指定した点がありません。');
  return { parameters: document.parameters.map(({ name, unit, mathId, value }) => ({ name, unit, mathId, value })),
    point: { x: point.at.x, y: point.at.y, z: point.at.z } };
}
function expectSaved(document: SavedDocument, coefficient: { readonly source: string; readonly value: number }, x: number): void {
  const fields = formulaFields(document);
  expect(fields.parameters.find(parameter => parameter.name === COEFFICIENT)).toMatchObject({ value: { value: coefficient.value,
    source: coefficient.source, mathDefinition: { format: MATH_FORMAT, source: coefficient.source, inputNotation: 'text', angleUnit: 'degree' } } });
  expect(fields.point).toMatchObject({
    x: { value: x, source: X_SOURCE, mathDefinition: { format: MATH_FORMAT, source: X_SOURCE, inputNotation: 'text' } },
    y: { value: 3, source: Y_SOURCE, mathDefinition: { format: MATH_FORMAT, source: Y_SOURCE, inputNotation: 'text' } },
    z: { value: 0 } });
}

/** Set relations, case distinctions, ≈ with its tolerance, ∇, ratios, repeating decimals and products in one editor. */
async function coefficientEditor(page: Page, editor: MathEditor): Promise<void> {
  const what = '係数の画面';
  const truth = { shown: m('math.boolean.true') }, falsity = { shown: m('math.boolean.false') };
  await enter(editor, what, '{1}⊂{1,2}', truth);
  await enter(editor, what, '3∉{1,2}', truth);
  await enter(editor, what, '{1,2}⊆{1}', falsity);
  await enter(editor, what, 'which(notelement(1,set(1)),7,true,9)', { value: '9' });
  await enter(editor, what, 'approxequal(1,1.05,0.1)', truth);
  // ≈ without an explicit absolute tolerance has no value (MC-24): refused with the common reason.
  await enter(editor, what, '1≈1.05', { refused: '式の成立条件または計算結果を確認してください。' });
  await enter(editor, what, 'which(approxequal(0.3,0.2,0.1),1,true,2)', { value: '1' });
  // ∇ without its variable list belongs to function plots only (MC-19b).
  await enter(editor, what, '∇(x^2)', { refused: NABLA_VARIABLES_REQUIRED });
  await enter(editor, what, '3:4', { value: '0.75' });
  await enter(editor, what, '1:2:3', { refused: `${RATIO_TERMS}（4文字目）` });
  await enter(editor, what, '0.1(6)*6', { value: '1' });
  await enter(editor, what, '0.(3)', { value: ONE_THIRD });

  // Structured input: the same value survives the switch; a ratio is typed and a repeating decimal is marked with an
  // overline by selecting its digit and choosing the overline item of the palette (MC-19c, Q1=A). Switching back to
  // text shows the same meaning in the named form, as every notation switch does.
  await editor.dialog.getByRole('button', { name: m('math.structured'), exact: true }).click();
  await expect(editor.field).toBeFocused();
  await expectStructured(editor.field, '構造入力へ切り替えた 0.(3)', String.raw`\frac{1}{3}`);
  await expectOutcome(editor, `${what}（構造入力へ切替）`, { value: ONE_THIRD });
  await focusField(editor.field);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('1:4');
  await expectStructured(editor.field, '構造入力へ打った比', '1:4');
  await expectOutcome(editor, `${what}（構造入力へ打った比「1:4」）`, { value: '0.25' });
  await editor.dialog.locator('summary').filter({ hasText: m('math.palette') }).click();
  await editor.dialog.getByRole('searchbox', { name: m('math.search'), exact: true })
    .fill(uiMessage('mathPaletteBasic', 'math.palette.conjugate.label'));
  const overline = editor.dialog.locator('.pcad-math-editor__palette')
    .getByRole('button', { name: uiMessage('mathPaletteBasic', 'math.palette.conjugate.label'), exact: true });
  await expect(overline).toBeVisible();
  await focusField(editor.field);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('0.3');
  await expectStructured(editor.field, '構造入力へ打った小数', '0.3');
  await expectOutcome(editor, `${what}（構造入力へ打った小数「0.3」）`, { value: '0.3' });
  await page.keyboard.press('Shift+ArrowLeft');
  await overline.click();
  await expectStructured(editor.field, '選んだ数字に上線を付けた循環小数', String.raw`0.\overline{3}`);
  await expectOutcome(editor, `${what}（上線の循環小数「0.\\overline{3}」）`, { value: ONE_THIRD });
  await editor.dialog.getByRole('button', { name: m('math.text'), exact: true }).click();
  await expect(editor.input).toBeFocused();
  await expect(editor.input).toHaveValue('Divide(1,3)');
  await expectOutcome(editor, `${what}（通常入力へ戻す）`, { value: ONE_THIRD });

  await enter(editor, what, '[1,2,3]·[4,5,6]', { value: '32' });
  await enter(editor, what, '⟨[1,2,3],[4,5,6]⟩', { value: '32' });
  await enter(editor, what, 'norm([3,4])', { value: '5' });
  await enter(editor, what, COEFFICIENT_SOURCE, { value: '32' });
}

/**
 * ± and a matrix |A| show their candidates and why a coordinate cannot use them; fixing the reading makes it usable.
 * The |A| candidates are the determinant −2 and the norm √30, written as their formulas (the product showed the norm as
 * "sqrt(30)^1" until 10:44 on 2026-09-24; "-2, sqrt(30)" was read on the fixed product's real screen in the independent
 * copy, delivery 20260924-103433). Both rewrites the hint names are usable.
 */
async function xCoordinateEditor(editor: MathEditor): Promise<void> {
  const what = 'X座標の画面';
  await enter(editor, what, `coef("${COEFFICIENT}")±1`, { shown: m('math.multiple'),
    detail: `${m('math.multipleCandidates')}: 33, 31. ${m('math.multipleSelectionHint')}` });
  await enter(editor, what, '|[[1,2],[3,4]]|', { shown: m('math.multiple'),
    detail: `${m('math.absoluteCandidates')}: -2, sqrt(30). ${m('math.absoluteSelectionHint')}` });
  await enter(editor, `${what}（行列式へ書き換え）`, 'det([[1,2],[3,4]])', { value: '-2' });
  await enter(editor, `${what}（ノルムへ書き換え）`, 'norm([1,2,3,4])', { near: Math.sqrt(30) });
  await enter(editor, what, X_SOURCE, { value: '33' });
}

/** Cross product, identity, inverse and transpose are arrays: each gives its component through the picker. */
async function yCoordinateEditor(editor: MathEditor): Promise<void> {
  const what = 'Y座標の画面';
  const vector = { shown: m('math.kind.vector') }, matrix = { shown: m('math.kind.matrix') };
  await enter(editor, what, '[1,0,0]×[0,1,0]', vector);
  await chooseComponent(editor, '外積', [3], [3]);
  await expectOutcome(editor, `${what}（外積の成分）`, { value: '1' });
  await enter(editor, what, 'identitymatrix(3)', matrix);
  await chooseComponent(editor, '単位行列', [3, 3], [2, 2]);
  await expectOutcome(editor, `${what}（単位行列の成分）`, { value: '1' });
  await enter(editor, what, 'inverse([[2,0],[0,4]])', matrix);
  await chooseComponent(editor, '逆行列', [2, 2], [1, 1]);
  await expectOutcome(editor, `${what}（逆行列の成分）`, { value: '0.5' });
  await enter(editor, what, 'transpose([[1,2],[3,4]])', matrix);
  await chooseComponent(editor, '転置行列', [2, 2], [1, 2]);
  await expect(editor.input).toHaveValue(Y_SOURCE);
  await expectOutcome(editor, `${what}（転置行列の成分）`, { value: '3' });
}

async function applyEditor(editor: MathEditor): Promise<void> {
  await editor.apply.click();
  await expect(editor.dialog).toHaveCount(0);
}

function elapsed(started: number): string {
  return `${String(Math.round(performance.now() - started))} ms`;
}

/**
 * MC-21: every notation above in the real editor, a coefficient and a point made from them, saved and reopened with the
 * original formulas, F1 on the math input chapter, an edit of the coefficient followed by the point, and one Undo.
 */
export async function mathCoverageFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const started = performance.now(), editor = mathEditor(page);

  // A named coefficient made from a set relation, a case distinction and a dot product.
  await tab(page, 'propertyPanel.tabParameters').click();
  await page.getByRole('button', { name: uiMessage('parameters', 'parameterPanel.addTooltip'), exact: true }).click();
  const name = page.locator('.pcad-parameter').last().locator('.pcad-field').first().locator('input');
  await name.fill(COEFFICIENT); await name.press('Enter');
  await expect(parameterRow(page, COEFFICIENT)).toHaveCount(1);
  await openParameterEditor(page, COEFFICIENT);
  await waitForMathEditorText(editor.dialog);
  await coefficientEditor(page, editor);
  await applyEditor(editor);
  await expect(parameterMessage(page, COEFFICIENT)).toHaveText('= 32');
  console.log(`[実測] 係数の画面まで ${elapsed(started)}`);

  // A point whose X uses the coefficient after fixing ± and whose Y is a component chosen from a matrix.
  await page.getByRole('group', { name: uiMessage('toolbar', 'toolbar.sketch.groupLabel'), exact: true })
    .getByRole('button', { name: uiMessage('toolbar', 'toolbar.tool.point'), exact: true }).click();
  const popover = page.locator('.pcad-popover');
  await expect(popover.locator('input.pcad-field__input')).toHaveCount(3);
  const popoverMath = (axis: 'x' | 'y'): Locator => popover.getByRole('button', { name: `${axisLabel(axis)}: ${m('math.open')}`, exact: true });
  await popoverMath('x').click();
  await waitForMathEditorText(editor.dialog);
  await xCoordinateEditor(editor);
  await applyEditor(editor);
  await expect(popover.locator('.pcad-field__message').nth(0)).toHaveText('= 33');
  await popoverMath('y').click();
  await waitForMathEditorText(editor.dialog);
  await yCoordinateEditor(editor);
  await applyEditor(editor);
  await expect(popover.locator('.pcad-field__message').nth(1)).toHaveText('= 3');
  await popover.getByRole('textbox', { name: axisLabel('z'), exact: true }).fill('0');
  await popover.getByRole('button', { name: uiMessage('numericInput', 'numericInput.commit'), exact: true }).click();
  await popover.getByRole('button', { name: uiMessage('numericInput', 'numericInput.cancel'), exact: true }).click();
  await expect(pointInTree(page)).toBeVisible();
  // Like the other coordinate flows, the point's recomputation is not awaited here: it would prepare the exact runtime
  // once more in sequence (a seventh preparation, 44-55 s in Firefox, RUN 20260924-102244), and the saved formulas do
  // not depend on it. The reopened document's recomputation below is awaited and must succeed.
  console.log(`[実測] 点の作成まで ${elapsed(started)}`);
  const saved = await savePart(page, info, 'math-coverage.pcad', app);
  expectSaved(saved, { source: COEFFICIENT_SOURCE, value: 32 }, 33);

  // Reopening keeps every original formula, not the displayed values.
  await reopenPart(page, info, 'math-coverage.pcad', app);
  console.log(`[実測] 再読込みまで ${elapsed(started)}`);
  await pointInTree(page).click();
  const properties = page.locator('.pcad-panel--right');
  await tab(page, 'propertyPanel.tabProperties').click();
  await expect(properties.getByRole('textbox', { name: axisLabel('x'), exact: true })).toHaveValue(X_SOURCE);
  await expect(properties.getByRole('textbox', { name: axisLabel('y'), exact: true })).toHaveValue(Y_SOURCE);
  expect(formulaFields(await savePart(page, info, 'math-coverage-reopened.pcad', app))).toEqual(formulaFields(saved));

  // F1 in the reopened editor opens the math input chapter and keeps the formula; the edit is followed by the point.
  await tab(page, 'propertyPanel.tabParameters').click();
  await openParameterEditor(page, COEFFICIENT);
  await waitForMathEditorText(editor.dialog);
  await expect(editor.input).toHaveValue(COEFFICIENT_SOURCE);
  await expectOutcome(editor, '再読込み後の係数の画面', { value: '32' });
  const chapter = readFileSync(new URL('../../packages/help-content/docs/ja/math-input.md', import.meta.url), 'utf8').split(/\r?\n/u);
  const title = chapter[0]?.replace(/^# /u, '') ?? '';
  const signs = chapter.find(line => line.startsWith('## ') && line.includes('±'))?.slice(3);
  if (signs === undefined) throw new Error('数式入力の章に ± の節がありません。');
  await page.keyboard.press('F1');
  const article = page.locator('.pcad-help__article');
  await expect(article.locator('h1').first()).toHaveText(title);
  await expect(article.getByRole('heading', { name: signs, exact: true })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.pcad-help')).toHaveCount(0);
  await expect(editor.input).toHaveValue(COEFFICIENT_SOURCE);
  await enter(editor, '再読込み後の係数の画面', EDITED_COEFFICIENT_SOURCE, { value: '35' });
  const edit = await beginRecompute(page);
  await applyEditor(editor);
  await waitForRecompute(page, edit);
  await expect(parameterMessage(page, COEFFICIENT)).toHaveText('= 35');
  const edited = await savePart(page, info, 'math-coverage-edited.pcad', app);
  expectSaved(edited, { source: EDITED_COEFFICIENT_SOURCE, value: 35 }, 36);

  // One Undo restores the coefficient and the point that follows it, exactly as first saved.
  await undoMathEdit(page);
  await expect(parameterMessage(page, COEFFICIENT)).toHaveText('= 32');
  const undone = await savePart(page, info, 'math-coverage-undone.pcad', app);
  expect(formulaFields(undone)).toEqual(formulaFields(saved));
  console.log(`[確認] 保存照合: 再読込み後・Undo後の係数と点の式・値が最初の保存と一致（全体 ${elapsed(started)}）`);
}
