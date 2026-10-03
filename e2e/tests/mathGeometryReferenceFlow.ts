import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mathGeometryCoefficientId, type Parameter, type PartDocument } from '../../packages/model/src/index.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForMathEditorText } from './mathEditorReady.js';
import { MATH_GEOMETRY_FIXTURE, MATH_GEOMETRY_FIXTURE_FILE, mathGeometryFixtureDocument, mathGeometryFixtureFile } from './mathGeometryFixture.js';
import { beginRecompute, readRecomputeStats, waitForRecomputeOutcome, type RecomputeToken } from './recompute.js';
import { reopenPart } from './reopenPart.js';
import { savePart } from './scriptsFlow.js';
import { uiMessage } from './uiMessages.js';

/*
 * GR-24 (scratchpad/claude/plans/geomref-plan.md §4(h)): the tool "図形の測定値" on the real screen, the real
 * kernel and the real calculation Worker. Every flow takes the page and, for real Electron (GR-24e), the
 * application, so the same steps run in Chromium, Firefox and Electron. Values, labels and saved documents are
 * compared with what the product shows and stores; labels come from the product catalogs (uiMessage). The
 * displayed numbers were read from the real screen first (Chromium, RUN 20260924-090149, rules/06 §10.329).
 */
const SCRIPT = new URL('./mathGeometryReferenceFlow.ts', import.meta.url);
const m = (key: string): string => uiMessage('mathGeometry', key);
const TOOL = m('toolbar.look.mathGeometry');
const LOOK_MENU = uiMessage('toolbar', 'toolbar.look.groupLabel');
const MM = uiMessage('view', 'measure.unit.millimeter');
const DEGREE = uiMessage('view', 'measure.unit.degree');
const MM3 = uiMessage('propertyPanel', 'propertyPanel.unitCubicMillimeter');
const BODY = uiMessage('view', 'selection.kind.body');
const EDGE = uiMessage('view', 'selection.kind.edge');
const { box1, box2, width, sketch, line1, line2 } = MATH_GEOMETRY_FIXTURE;
const BOX1_VOLUME = '箱1体積', BOX2_VOLUME = '箱2体積', BOX1_COEFFICIENT = `${BOX1_VOLUME}${m('mathGeometry.createParameter.nameSuffix')}`;
const WIDTH_SOURCE = `coef("${BOX1_COEFFICIENT}")/1000`;
/** The default comparison widths, 1e-6 mm and 1e-6 rad, shown with 12 significant digits in mm and degrees. */
const DEFAULT_LINEAR = '0.000001', DEFAULT_ANGULAR = '0.0000572957795131';

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  Object.entries(values).reduce((text, [name, value]) => text.split(`{${name}}`).join(value), template);
const readyGuide = (count: number): string => fill(m('mathGeometry.guide.ready'), { count: String(count) });
const toleranceText = (linear: string, angular: string): string =>
  fill(m('mathGeometry.toleranceValue'), { linear: `${linear} ${MM}`, angular: `${angular} ${DEGREE}` });
const volumeText = (value: number): string => `${String(value)} ${MM3}`;
const lineTargets = [line1, line2].map(line => `${sketch.name} / ${line.name} (${EDGE}: ${line.id})`).join(' / ');
const referencedBy = (names: readonly string[]): string => fill(m('mathGeometry.error.referencedBy'), { names: names.join(' / ') });

const statusText = (page: Page): Locator => page.locator('.pcad-statusbar__text');
const panel = (page: Page): Locator => page.getByRole('region', { name: m('mathGeometry.title'), exact: true });
const guide = (page: Page): Locator => panel(page).locator('.pcad-panel__note').first();
const notice = (page: Page): Locator => panel(page).getByRole('status');
const rows = (page: Page): Locator => panel(page).locator('li[data-math-geometry-id]');
const quantity = (page: Page): Locator => panel(page).getByRole('combobox', { name: m('mathGeometry.quantityLabel'), exact: true });
const nameField = (row: Locator): Locator => row.getByRole('textbox', { name: m('mathGeometry.nameLabel'), exact: true });
/** A width field is named by its heading only; its error sentence is its description (aria-describedby, GR-19c). */
const toleranceField = (row: Locator, field: 'linear' | 'angular'): Locator =>
  row.getByLabel(m(`mathGeometry.tolerance.${field}Label`), { exact: true });
const rowButton = (row: Locator, key: string): Locator => row.getByRole('button', { name: m(key), exact: true });
const rowProperty = (row: Locator, key: string): Locator => row.locator('dt.pcad-properties__key')
  .filter({ hasText: new RegExp(`^${escapeRegExp(m(key))}$`, 'u') }).locator('xpath=following-sibling::dd[1]');
/** GR-19d: the row's own heading (`dt`), to confirm its column no longer collapses to width 0. */
const rowHeading = (row: Locator, key: string): Locator => row.locator('dt.pcad-properties__key')
  .filter({ hasText: new RegExp(`^${escapeRegExp(m(key))}$`, 'u') });
const usageMark = (row: Locator): Locator => row.locator('.pcad-parameter__head > .pcad-parameter__mark').first();
const tree = (page: Page, name: string): Locator => page.locator('.pcad-panel--left').getByRole('button', { name, exact: true });
/** A `has` locator is queried inside each row, so it names the row's own button without the panel prefix. */
const treeAlert = (page: Page, name: string): Locator => page.locator('.pcad-panel--left .pcad-tree__row')
  .filter({ has: page.getByRole('button', { name, exact: true }) }).locator('.pcad-tree__alert');
const properties = (page: Page): Locator => page.locator('.pcad-panel--right');
const tab = (page: Page, key: string): Locator => page.getByRole('tab', { name: uiMessage('propertyPanel', key), exact: true });
const parameterRow = (page: Page, name: string): Locator => page.locator('.pcad-parameter').filter({
  has: page.getByRole('textbox', { name: `${uiMessage('parameters', 'parameterPanel.nameLabel')} ${name}`, exact: true }) });
const parameterSource = (page: Page, name: string): Locator => parameterRow(page, name).getByRole('textbox',
  { name: `${uiMessage('parameters', 'parameterPanel.sourceLabel')} ${name}`, exact: true });
const parameterMessage = (page: Page, name: string): Locator => parameterRow(page, name).locator('.pcad-field').nth(1).locator('.pcad-field__message');

/** One edit publishes one document: exactly one new recomputation generation, completed with the expected outcome. */
async function settle(page: Page, token: RecomputeToken, outcome: 'success' | 'failed' = 'success'): Promise<void> {
  await waitForRecomputeOutcome(page, token, outcome);
  const stats = await readRecomputeStats(page);
  expect(stats.requestedGeneration, '1回の操作で再計算がちょうど1世代進むこと').toBe(token.requestedGeneration + 1);
  expect(stats.completedGeneration).toBe(stats.requestedGeneration);
}

async function undoOrRedo(page: Page, key: 'Control+z' | 'Control+y'): Promise<void> {
  const token = await beginRecompute(page);
  const canvas = page.locator('canvas.pcad-viewport__canvas');
  await canvas.focus(); await expect(canvas).toBeFocused();
  await page.keyboard.press(key);
  await settle(page, token);
}

/** Switching the tool on or off never edits the document, so it never starts a recomputation. */
async function switchTool(page: Page, active: boolean): Promise<void> {
  const before = await readRecomputeStats(page);
  await chooseToolMenuItem(page, LOOK_MENU, TOOL);
  if (active) {
    await expect(panel(page)).toBeVisible();
    await expect(tab(page, 'propertyPanel.tabProperties')).toHaveAttribute('aria-selected', 'true');
  } else {
    await expect(panel(page)).toHaveCount(0);
  }
  expect((await readRecomputeStats(page)).requestedGeneration, '道具の切替では再計算しないこと').toBe(before.requestedGeneration);
}

async function openFixture(page: Page, info: TestInfo, app?: ElectronApplication): Promise<PartDocument> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await writeFile(info.outputPath(MATH_GEOMETRY_FIXTURE_FILE), mathGeometryFixtureFile(), { flag: 'wx' });
  await reopenPart(page, info, MATH_GEOMETRY_FIXTURE_FILE, app);
  // Opening two solids into a fresh profile shows the one-time timeline hint first; it outranks tool guides
  // until the next document edit (statusText.ts), so the status bar guide is compared after the first edit.
  await expect(statusText(page), '初めて2段の履歴を開いた直後は、つまみの案内が状態欄に出ること')
    .toHaveText(uiMessage('view', 'timeline.hint'));
  return mathGeometryFixtureDocument();
}

/** Adds the chosen candidate with its default name and waits for its measurement. */
async function addFromSelection(page: Page, kindKey: string, name: string): Promise<Locator> {
  const count = await rows(page).count();
  await quantity(page).selectOption({ label: m(kindKey) });
  const token = await beginRecompute(page);
  await panel(page).getByRole('button', { name: m('mathGeometry.add'), exact: true }).click();
  await expect(notice(page)).toHaveText(fill(m('mathGeometry.guide.added'), { name }));
  await settle(page, token);
  await expect(rows(page)).toHaveCount(count + 1);
  const row = rows(page).nth(count);
  await expect(nameField(row)).toHaveValue(name);
  await expect(rowProperty(row, 'mathGeometry.quantityLabel')).toHaveText(m(kindKey));
  return row;
}

async function rename(page: Page, row: Locator, name: string): Promise<void> {
  const token = await beginRecompute(page);
  await nameField(row).fill(name);
  await nameField(row).press('Enter');
  await settle(page, token);
  await expect(nameField(row)).toHaveValue(name);
}

/** "この値の係数を作る" on a row whose value is current: one edit, then the same name is refused. */
async function createCoefficient(page: Page, row: Locator, name: string): Promise<void> {
  const token = await beginRecompute(page);
  await rowButton(row, 'mathGeometry.createParameter').click();
  await expect(notice(page)).toHaveText(fill(m('mathGeometry.createParameter.notice'), { name }));
  await settle(page, token);
}

async function expectVolumes(page: Page, first: number, second: number): Promise<void> {
  await expect(rowProperty(rows(page).nth(0), 'mathGeometry.valueLabel')).toHaveText(volumeText(first));
  await expect(rowProperty(rows(page).nth(1), 'mathGeometry.valueLabel')).toHaveText(volumeText(second));
}

/**
 * GR-19d: `.pcad-properties.pcad-parameter__properties` keeps the heading column (測る量・参照先・値・比べる幅)
 * a `max-content` width instead of letting the shared `.pcad-properties` grid shrink it to 0 once the value
 * column's text is long. Read from the real screen, not asserted against a hard-coded pixel width.
 */
async function expectHeadingWidths(row: Locator): Promise<void> {
  for (const key of ['mathGeometry.quantityLabel', 'mathGeometry.targetsLabel', 'mathGeometry.valueLabel', 'mathGeometry.toleranceLabel']) {
    const box = await rowHeading(row, key).boundingBox();
    expect(box !== null && box.width > 0, `見出し「${m(key)}」の幅が0より大きいこと(GR-19d)`).toBe(true);
  }
}

/**
 * GR-19d: `.pcad-parameters__quantity-field` gives the "測る量" field its own left/right padding, unlike the
 * bare `.pcad-field` it used to be (flush against the panel's left edge). Compares the label's own left edge
 * to its field's, so it holds regardless of the panel's absolute position on screen.
 */
async function expectQuantityLabelInset(page: Page): Promise<void> {
  const field = panel(page).locator('.pcad-parameters__quantity-field');
  const [fieldBox, labelBox] = await Promise.all([field.boundingBox(), field.locator('.pcad-field__label').boundingBox()]);
  expect(fieldBox !== null && labelBox !== null && labelBox.x > fieldBox.x,
    '追加欄の「測る量」のラベルが欄の左端(パディング)から離れていること(GR-19d)').toBe(true);
}

/**
 * At 1440 x 900 the section with two rows (about 1120 px) is taller than the property panel. The window
 * only grows while photographing (the checked 1440 x 900 layout is restored afterwards), and only up to
 * the registry's own tall exception (`scripts/manual/captureRegistry.mjs` CAPTURE_VIEWPORT_POLICY: only
 * 1440 x 900 or 1440 x 1100). Growing further, as before, produced a non-standard size the registry never
 * accepts (measured 1440 x 1321 Chromium, 1440 x 1399 Electron) because the part scrolled out of the
 * panel's fixed, scrollable frame (`.pcad-panel__body`) photographed black under the status bar. If the
 * section still does not fit inside that frame at 1440 x 1100, it is photographed in two pieces instead:
 * from the section's own heading first, then the frame scrolled down for the second piece (2026-09-25
 * coordinator decision, GR-24/GR-24e). This runs the same way in Electron too (the removed w37a branch
 * used to skip photographing there); only the photograph itself (`captureManualDetail`, sourced from the
 * Web project) is skipped for Electron, while the resize/scroll/fit-in-view behaviour is still checked.
 */
async function captureWholeSection(page: Page, info: TestInfo, fixture: unknown, app?: ElectronApplication): Promise<void> {
  const section = panel(page), body = properties(page).locator('.pcad-panel__body');
  const viewport = page.viewportSize(), before = await section.boundingBox(), frame = await body.boundingBox();
  if (viewport === null || before === null || frame === null) throw new Error('図形の測定値の節の大きさを読めません');
  const TALL_EXCEPTION_HEIGHT = 1100;
  const needed = viewport.height + Math.max(0, Math.ceil(before.height - frame.height) + 32);
  await page.setViewportSize({ width: viewport.width, height: Math.min(needed, TALL_EXCEPTION_HEIGHT) });
  await section.scrollIntoViewIfNeeded();
  const [shown, visible] = await Promise.all([section.boundingBox(), body.boundingBox()]);
  if (shown === null || visible === null) throw new Error('図形の測定値の節の大きさを読めません');
  const fitsWhole = shown.y >= visible.y && shown.y + shown.height <= visible.y + visible.height;
  if (app === undefined) {
    if (fitsWhole) {
      await captureManualDetail(page, info, { name: 'math-geometry-reference', dialog: section, script: SCRIPT, fixture });
    } else {
      // `.pcad-panel__body` is the fixed, scrollable frame itself (appShell.css `.pcad-panel__body { overflow: auto }`),
      // so photographing it (instead of the taller section) always captures exactly what is actually rendered at
      // the current scroll position, never the black area a too-tall element screenshot produced before.
      await body.evaluate(element => { element.scrollTop = 0; });
      await captureManualDetail(page, info, { name: 'math-geometry-reference', dialog: body, script: SCRIPT, fixture });
      await body.evaluate(element => { element.scrollTop = element.scrollHeight - element.clientHeight; });
      await captureManualDetail(page, info, { name: 'math-geometry-reference-2', dialog: body, script: SCRIPT, fixture });
    }
  }
  await page.setViewportSize(viewport);
}

function coefficientFields(parameters: readonly Parameter[]) {
  return parameters.map(({ name, mathId, unit, description, value }) =>
    ({ name, mathId, unit, description, source: value.source, mathDefinition: value.mathDefinition }));
}

/**
 * §4(h) steps 1-7, 9, 10 and 12: tool first and target first, rename with Undo/Redo, "この値の係数を作る",
 * the geometry palette of a coefficient formula, a shape change that re-measures, save and reopen, a refused
 * cycle and F1. Step 11 (the refused deletion and its reason) is mathGeometryUsageFlow.
 */
export async function mathGeometryReferenceFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  const fixture = await openFixture(page, info, app);

  // Tool first (P2): nothing is selected, so the section explains what to select.
  await switchTool(page, true);
  await expect(guide(page)).toHaveText(m('statusBar.guide.mathGeometry'));
  await expect(panel(page).getByText(m('mathGeometry.empty'), { exact: true })).toBeVisible();
  await expect(quantity(page)).toBeDisabled();
  await expectQuantityLabelInset(page);
  await tree(page, box1.name).click();
  await expect(guide(page)).toHaveText(readyGuide(2));
  await expect(quantity(page).locator('option')).toHaveText([m('mathGeometry.kind.volume'), m('mathGeometry.kind.area')]);
  const first = await addFromSelection(page, 'mathGeometry.kind.volume', '体積1');
  // The first edit retires the one-time hint: the status bar now shows the section's guide.
  await expect(statusText(page)).toHaveText(readyGuide(2));
  await expect(guide(page)).toHaveText(readyGuide(2));
  await expect(rowProperty(first, 'mathGeometry.valueLabel')).toHaveText(volumeText(24000));
  await expect(rowProperty(first, 'mathGeometry.targetsLabel')).toHaveText(`${box1.name} (${BODY})`);
  await expect(rowProperty(first, 'mathGeometry.toleranceLabel')).toHaveText(toleranceText(DEFAULT_LINEAR, DEFAULT_ANGULAR));
  await expect(first.getByText(m('mathGeometry.toleranceNote'), { exact: true })).toBeVisible();
  await expect(usageMark(first)).toHaveText(m('mathGeometry.unused'));

  // Target first: end the tool, select box 2, start the tool again; its candidates are listed at once.
  await switchTool(page, false);
  await tree(page, box2.name).click();
  await switchTool(page, true);
  await expect(guide(page)).toHaveText(readyGuide(2));
  await expect(statusText(page)).toHaveText(readyGuide(2));
  const second = await addFromSelection(page, 'mathGeometry.kind.volume', '体積2');
  await rename(page, second, BOX2_VOLUME);
  await expect(rowProperty(second, 'mathGeometry.valueLabel')).toHaveText(volumeText(1000));

  // Rename with one Undo step each way.
  await rename(page, first, BOX1_VOLUME);
  await undoOrRedo(page, 'Control+z');
  await expect(nameField(first)).toHaveValue('体積1');
  await undoOrRedo(page, 'Control+y');
  await expect(nameField(first)).toHaveValue(BOX1_VOLUME);

  // "この値の係数を作る" (U3): one Undo step each way; in the same state a second one cannot be pressed.
  const create = rowButton(first, 'mathGeometry.createParameter');
  const duplicate = first.getByText(m('mathGeometry.createParameter.disabled.duplicateName'), { exact: true });
  await expect(create).toBeEnabled();
  const created = await beginRecompute(page);
  await createCoefficient(page, first, BOX1_COEFFICIENT);
  await expect(create).toBeDisabled(); await expect(duplicate).toBeVisible();
  await expect(usageMark(first)).toHaveText(`1${m('mathGeometry.usageSuffix')}`);
  await undoOrRedo(page, 'Control+z');
  await expect(create).toBeEnabled(); await expect(duplicate).toHaveCount(0);
  await expect(usageMark(first)).toHaveText(m('mathGeometry.unused'));
  await undoOrRedo(page, 'Control+y');
  await expect(create).toBeDisabled(); await expect(duplicate).toBeVisible();
  await expect(usageMark(first)).toHaveText(`1${m('mathGeometry.usageSuffix')}`);
  expect((await readRecomputeStats(page)).requestedGeneration, '作成・Undo・Redoの3世代だけ進み、押せない2回目は文書を変えないこと')
    .toBe(created.requestedGeneration + 3);

  await tab(page, 'propertyPanel.tabParameters').click();
  const coefficientRow = parameterRow(page, BOX1_COEFFICIENT);
  await expect(parameterSource(page, BOX1_COEFFICIENT)).toHaveValue(`coef("${BOX1_VOLUME}")`);
  await expect(coefficientRow.getByRole('group', { name: uiMessage('parameters', 'parameterPanel.unitLabel'), exact: true })
    .getByRole('button', { name: uiMessage('parameters', 'parameterPanel.unit.none'), exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(coefficientRow.locator('.pcad-parameter__mark').first()).toHaveText(m('mathGeometry.derived'));
  await expect(parameterMessage(page, BOX1_COEFFICIENT)).toHaveText('= 24000');

  // The coefficient formula of 幅B lists the measurement in its own palette group; 箱2体積 depends on 幅B and is left out.
  await parameterRow(page, width.name).getByRole('button', { name: uiMessage('math', 'math.open'), exact: true }).click();
  const dialog = page.locator('.pcad-math-dialog');
  await waitForMathEditorText(dialog);
  const geometryGroup = dialog.getByRole('group', { name: m('mathGeometry.palette.group'), exact: true });
  await expect(geometryGroup.getByRole('button')).toHaveText([BOX1_VOLUME]);
  await expect(geometryGroup.getByRole('button', { name: BOX1_VOLUME, exact: true })).toHaveAttribute('title',
    fill(m('mathGeometry.palette.meaning'), { name: BOX1_VOLUME, value: volumeText(24000), kind: m('mathGeometry.kind.volume') }));
  await expect(dialog.getByRole('group', { name: uiMessage('math', 'math.coefficients'), exact: true })
    .getByRole('button', { name: BOX1_COEFFICIENT, exact: true })).toBeVisible();
  await captureManualDetail(page, info, { name: 'math-geometry-palette', dialog, script: SCRIPT,
    fixture: { document: fixture, coefficient: width.name, geometry: BOX1_VOLUME } });
  await dialog.locator('textarea').fill(WIDTH_SOURCE);
  await expect(dialog.locator('.pcad-math-editor__result p').first()).toHaveText('= 24', { timeout: 60_000 });
  const apply = dialog.getByRole('button', { name: uiMessage('math', 'math.apply'), exact: true });
  await expect(apply).toBeEnabled();
  let token = await beginRecompute(page);
  await apply.click();
  await expect(dialog).toHaveCount(0);
  await settle(page, token);
  await expect(parameterSource(page, width.name)).toHaveValue(WIDTH_SOURCE);
  await expect(parameterRow(page, width.name).locator('.pcad-parameter__mark').first()).toHaveText(m('mathGeometry.derived'));
  await expect(parameterMessage(page, width.name)).toHaveText('= 24');
  await tab(page, 'propertyPanel.tabProperties').click();
  await expect(panel(page)).toBeVisible();
  await expectVolumes(page, 24000, 2400);
  await expectHeadingWidths(first); await expectHeadingWidths(second);
  await expect(usageMark(second)).toHaveText(m('mathGeometry.unused'));
  await captureWholeSection(page, info, { document: fixture, definitions: [BOX1_VOLUME, BOX2_VOLUME], coefficients: [BOX1_COEFFICIENT, width.name] }, app);
  await expectVolumes(page, 24000, 2400);

  // A shape change re-measures in the same recomputation: box 1 25 wide -> 30000, 幅B 30, box 2 3000.
  await tree(page, box1.name).click();
  const sizeX = properties(page).getByLabel(uiMessage('numericInput', 'numericInput.field.boxSizeX'), { exact: true });
  token = await beginRecompute(page);
  await sizeX.fill('25');
  await settle(page, token);
  await expectVolumes(page, 30000, 3000);
  await undoOrRedo(page, 'Control+z');
  await expectVolumes(page, 24000, 2400);
  await undoOrRedo(page, 'Control+y');
  await expectVolumes(page, 30000, 3000);
  await tab(page, 'propertyPanel.tabParameters').click();
  await expect(parameterMessage(page, width.name)).toHaveText('= 30');
  await tab(page, 'propertyPanel.tabProperties').click();

  // Only definitions and formulas are saved; reopening measures again.
  const saved = await savePart(page, info, 'math-geometry-saved.pcad', app);
  const definitions = saved.mathGeometry ?? [];
  expect(definitions.map(definition => definition.name)).toEqual([BOX1_VOLUME, BOX2_VOLUME]);
  for (const [index, box] of [box1, box2].entries()) {
    const definition = definitions[index];
    expect(Object.keys(definition ?? {}).sort()).toEqual(['documentId', 'id', 'name', 'quantity', 'tolerance']);
    expect(definition).toMatchObject({ documentId: saved.id, quantity: { kind: 'volume', body: { kind: 'body', featureId: box.id } },
      tolerance: { linearMm: 1e-6, angularRadians: 1e-6 } });
  }
  const coefficient = saved.parameters.find(parameter => parameter.name === BOX1_COEFFICIENT);
  expect(coefficient).toMatchObject({ unit: 'none', value: { source: `coef("${BOX1_VOLUME}")` },
    description: fill(m('mathGeometry.createParameter.description'), { name: BOX1_VOLUME, kind: m('mathGeometry.kind.volume'), unit: MM3 }) });
  expect(coefficient?.value.mathDefinition?.expression).toEqual({ kind: 'symbol',
    reference: { role: 'coefficient', id: mathGeometryCoefficientId(definitions[0]?.id ?? ''), label: BOX1_VOLUME } });
  expect(saved.parameters.find(parameter => parameter.name === width.name)?.value.source).toBe(WIDTH_SOURCE);
  const savedBox = saved.solids.find(solid => solid.id === box1.id);
  expect(savedBox?.kind === 'primitive' && savedBox.shape.kind === 'box' ? savedBox.shape.sizeX.value : null).toBe(25);
  await reopenPart(page, info, 'math-geometry-saved.pcad', app);
  await switchTool(page, true);
  // Nothing is selected after reopening and the hint was already shown: status bar and section give step 0.
  await expect(statusText(page)).toHaveText(m('statusBar.guide.mathGeometry'));
  await expect(guide(page)).toHaveText(m('statusBar.guide.mathGeometry'));
  await expect(rows(page)).toHaveCount(2);
  await expect(nameField(rows(page).nth(0))).toHaveValue(BOX1_VOLUME);
  await expect(nameField(rows(page).nth(1))).toHaveValue(BOX2_VOLUME);
  await expectVolumes(page, 30000, 3000);
  const reopened = await savePart(page, info, 'math-geometry-reopened.pcad', app);
  expect(reopened.mathGeometry).toEqual(saved.mathGeometry);
  expect(coefficientFields(reopened.parameters)).toEqual(coefficientFields(saved.parameters));

  // A cycle (box 1 measured by 箱1体積, which 幅B uses, is made from 幅B) fails with its reason and shows no values.
  await tree(page, box1.name).click();
  const sizeY = properties(page).getByLabel(uiMessage('numericInput', 'numericInput.field.boxSizeY'), { exact: true });
  token = await beginRecompute(page);
  await sizeY.fill(width.name);
  await settle(page, token, 'failed');
  const cycle = `係数「${width.name}」は図形の測定値「${BOX1_VOLUME}」を使っていますが、その測る形「${box1.name}」が「${width.name}」を使って作られているため循環しています。`;
  const cyclic = rows(page).nth(0);
  await expect(statusText(page)).toHaveText(`${fill(uiMessage('statusBar', 'statusBar.errorSummary'), { count: '4' })} ${cycle}`);
  await expect(cyclic.locator('.pcad-parameter__mark--circular')).toHaveText(m('mathGeometry.circular'));
  await expect(cyclic.locator('.pcad-panel__error')).toHaveText(cycle);
  // Neither measured shape can be made, so neither row shows a value (the model's reason follows the screen's).
  const unmeasured = `${m('mathGeometry.reason.failed-geometry')} 参照先の形を正しく計算できませんでした。`;
  await expect(rowProperty(cyclic, 'mathGeometry.valueLabel')).toHaveText(unmeasured);
  await expect(rowProperty(rows(page).nth(1), 'mathGeometry.valueLabel')).toHaveText(unmeasured);
  await expect(treeAlert(page, box1.name)).toHaveCount(1);
  await expect(treeAlert(page, box2.name)).toHaveCount(1);
  // 箱1(自分のsizeYが幅Bを参照)も箱2(fixtureのsizeXが幅Bを参照)も、同じ「参照する係数」の理由で計算
  // できない(evaluateDocumentMath.tsのdependentFailureMessage)。末尾はfeatureTree.errorTooltip(view.json)。
  const referencedByWidth = `参照する係数「${width.name}」を計算できません: ${cycle}`;
  const alertTitle = `${referencedByWidth} ${uiMessage('view', 'featureTree.errorTooltip')}`;
  await expect(treeAlert(page, box1.name)).toHaveAttribute('title', alertTitle);
  await expect(treeAlert(page, box2.name)).toHaveAttribute('title', alertTitle);
  await undoOrRedo(page, 'Control+z');
  await expect(cyclic.locator('.pcad-panel__error')).toHaveCount(0);
  await expect(treeAlert(page, box1.name)).toHaveCount(0);
  await expectVolumes(page, 30000, 3000);

  // F1 while the tool is active opens the math input chapter; neither F1 nor closing the help edits the document.
  const generation = (await readRecomputeStats(page)).requestedGeneration;
  const title = readFileSync(new URL('../../packages/help-content/docs/ja/math-input.md', import.meta.url), 'utf8')
    .split(/\r?\n/u)[0]?.replace(/^# /u, '') ?? '';
  const canvas = page.locator('canvas.pcad-viewport__canvas');
  await canvas.focus(); await expect(canvas).toBeFocused();
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article h1').first()).toHaveText(title);
  await page.keyboard.press('Escape');
  await expect(page.locator('.pcad-help')).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  expect((await readRecomputeStats(page)).requestedGeneration).toBe(generation);
}

/**
 * §4(h) step 11: a measurement used by a coefficient cannot be deleted, and the reason names the coefficient.
 * Uses are counted like the parameter table does (parameterUsageCounts in parameterCommands.ts): the active
 * configuration's automatic copy of the coefficient formulas is not a separate use.
 */
export async function mathGeometryUsageFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await openFixture(page, info, app);
  await switchTool(page, true);
  await tree(page, box1.name).click();
  const row = await addFromSelection(page, 'mathGeometry.kind.volume', '体積1');
  const remove = rowButton(row, 'mathGeometry.delete');
  await expect(remove).toBeEnabled();
  const coefficientName = `体積1${m('mathGeometry.createParameter.nameSuffix')}`;
  await createCoefficient(page, row, coefficientName);
  const generation = (await readRecomputeStats(page)).requestedGeneration;
  await expect(remove).toBeDisabled();
  await expect(rows(page)).toHaveCount(1);
  // The same screen counts 幅B, used by box 2 only, as one use.
  await tab(page, 'propertyPanel.tabParameters').click();
  await expect(parameterRow(page, width.name).locator('.pcad-parameter__marks')).toHaveText(`1${uiMessage('parameters', 'parameterPanel.usageSuffix')}`);
  await tab(page, 'propertyPanel.tabProperties').click();
  await expect(usageMark(row)).toHaveText(`1${m('mathGeometry.usageSuffix')}`);
  await expect(usageMark(row)).toHaveAttribute('title', coefficientName);
  await expect(row.getByText(referencedBy([coefficientName]), { exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  expect((await readRecomputeStats(page)).requestedGeneration, '削除できないときは文書を変えないこと').toBe(generation);
}

/** Select both fixture segments; the section's guide advances with each selection (P2). */
async function selectLines(page: Page): Promise<void> {
  await switchTool(page, true);
  await expect(guide(page)).toHaveText(m('statusBar.guide.mathGeometry'));
  await tree(page, line1.name).click();
  await expect(guide(page)).toHaveText(readyGuide(1));
  await tree(page, line2.name).click({ modifiers: ['Shift'] });
  await expect(tree(page, line2.name)).toHaveAttribute('aria-pressed', 'true');
  await expect(guide(page)).toHaveText(readyGuide(5));
  await expect(quantity(page).locator('option')).toHaveText(['angle', 'parallel', 'perpendicular', 'congruent', 'similar']
    .map(kind => m(`mathGeometry.kind.${kind}`)));
}

/** Opens a row's comparison widths, types one field and applies it as one undoable edit. */
async function changeTolerance(page: Page, row: Locator, field: 'linear' | 'angular', value: string): Promise<void> {
  if ((await row.locator('details').getAttribute('open')) === null) await row.getByText(m('mathGeometry.tolerance.edit'), { exact: true }).click();
  await toleranceField(row, field).fill(value);
  const apply = rowButton(row, 'mathGeometry.tolerance.apply');
  await expect(apply).toBeEnabled();
  const token = await beginRecompute(page);
  await apply.click();
  await settle(page, token);
}

/** §4(h) step 8 (T3) as its own test: the angle width decides "平行", survives Undo/Redo, saving and reopening. */
export async function mathGeometryToleranceFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  const fixture = await openFixture(page, info, app);
  await selectLines(page);
  const row = await addFromSelection(page, 'mathGeometry.kind.parallel', '平行1');
  await expect(statusText(page)).toHaveText(readyGuide(5));
  const value = rowProperty(row, 'mathGeometry.valueLabel'), tolerance = rowProperty(row, 'mathGeometry.toleranceLabel');
  await expect(value).toHaveText(m('mathGeometry.boolean.false'));
  await expect(rowProperty(row, 'mathGeometry.targetsLabel')).toHaveText(lineTargets);
  await expect(tolerance).toHaveText(toleranceText(DEFAULT_LINEAR, DEFAULT_ANGULAR));

  await row.getByText(m('mathGeometry.tolerance.edit'), { exact: true }).click();
  const linear = toleranceField(row, 'linear'), angular = toleranceField(row, 'angular');
  await expect(linear).toHaveValue(DEFAULT_LINEAR);
  await expect(angular).toHaveValue(DEFAULT_ANGULAR);
  // 45 degrees or more is refused in the field itself and cannot be applied; the reason describes the field.
  await angular.fill('45');
  await expect(angular).toHaveAttribute('aria-invalid', 'true');
  await expect(row.getByText(m('mathGeometry.tolerance.error.angular'), { exact: true })).toBeVisible();
  await expect(angular).toHaveAccessibleName(m('mathGeometry.tolerance.angularLabel'));
  await expect(angular).toHaveAccessibleDescription(m('mathGeometry.tolerance.error.angular'));
  await expect(rowButton(row, 'mathGeometry.tolerance.apply')).toBeDisabled();
  await changeTolerance(page, row, 'angular', '1');
  await expect(value).toHaveText(m('mathGeometry.boolean.true'));
  await expect(tolerance).toHaveText(toleranceText(DEFAULT_LINEAR, '1'));
  await expect(angular).toHaveValue('1');
  await expect(angular).toHaveAttribute('aria-invalid', 'false');
  await expect(row.getByText(m('mathGeometry.tolerance.error.angular'), { exact: true })).toHaveCount(0);
  await captureManualDetail(page, info, { name: 'math-geometry-tolerance', dialog: row, script: SCRIPT,
    fixture: { document: fixture, definition: '平行1', angularDegrees: 1 } });
  await undoOrRedo(page, 'Control+z');
  await expect(value).toHaveText(m('mathGeometry.boolean.false'));
  await expect(tolerance).toHaveText(toleranceText(DEFAULT_LINEAR, DEFAULT_ANGULAR));
  await expect(angular).toHaveValue(DEFAULT_ANGULAR);
  await undoOrRedo(page, 'Control+y');
  await expect(value).toHaveText(m('mathGeometry.boolean.true'));
  await expect(angular).toHaveValue('1');

  const saved = await savePart(page, info, 'math-geometry-tolerance.pcad', app);
  expect(saved.mathGeometry).toHaveLength(1);
  expect(saved.mathGeometry?.[0]).toMatchObject({ name: '平行1', tolerance: { linearMm: 1e-6, angularRadians: Math.PI / 180 },
    quantity: { kind: 'parallel', first: { kind: 'sketch-curve', sketchId: sketch.id, featureId: line1.id },
      second: { kind: 'sketch-curve', sketchId: sketch.id, featureId: line2.id } } });
  await reopenPart(page, info, 'math-geometry-tolerance.pcad', app);
  await switchTool(page, true);
  await expect(statusText(page)).toHaveText(m('statusBar.guide.mathGeometry'));
  await expect(rows(page)).toHaveCount(1);
  await expect(rowProperty(rows(page).nth(0), 'mathGeometry.valueLabel')).toHaveText(m('mathGeometry.boolean.true'));
  await expect(rowProperty(rows(page).nth(0), 'mathGeometry.toleranceLabel')).toHaveText(toleranceText(DEFAULT_LINEAR, '1'));
  expect((await savePart(page, info, 'math-geometry-tolerance-reopened.pcad', app)).mathGeometry).toEqual(saved.mathGeometry);
}

/**
 * GR-22 demonstration on the fixture's two segments: congruent / similar. The segments are 50 mm and
 * 50 / cos 0.5 deg (about 50.0019 mm) long, so they are similar but congruent only with a length width of 0.01 mm.
 */
export async function mathGeometryComparisonFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await openFixture(page, info, app);
  await selectLines(page);
  const congruent = await addFromSelection(page, 'mathGeometry.kind.congruent', '合同1');
  const similar = await addFromSelection(page, 'mathGeometry.kind.similar', '相似1');
  await expect(statusText(page)).toHaveText(readyGuide(5));
  await expect(rowProperty(congruent, 'mathGeometry.valueLabel')).toHaveText(m('mathGeometry.boolean.false'));
  await expect(rowProperty(similar, 'mathGeometry.valueLabel')).toHaveText(m('mathGeometry.boolean.true'));
  await expect(rowProperty(congruent, 'mathGeometry.targetsLabel')).toHaveText(lineTargets);
  // Booleans are shown but never become coefficients.
  await expect(rowButton(congruent, 'mathGeometry.createParameter')).toBeDisabled();
  await expect(congruent.getByText(m('mathGeometry.createParameter.disabled.booleanValue'), { exact: true })).toBeVisible();
  await changeTolerance(page, congruent, 'linear', '0.01');
  await expect(rowProperty(congruent, 'mathGeometry.valueLabel')).toHaveText(m('mathGeometry.boolean.true'));
  await expect(rowProperty(congruent, 'mathGeometry.toleranceLabel')).toHaveText(toleranceText('0.01', DEFAULT_ANGULAR));
  await undoOrRedo(page, 'Control+z');
  await expect(rowProperty(congruent, 'mathGeometry.valueLabel')).toHaveText(m('mathGeometry.boolean.false'));
  await undoOrRedo(page, 'Control+y');
  await expect(rowProperty(congruent, 'mathGeometry.valueLabel')).toHaveText(m('mathGeometry.boolean.true'));
  const saved = await savePart(page, info, 'math-geometry-comparison.pcad', app);
  const pair = { first: { kind: 'sketch-curve', sketchId: sketch.id, featureId: line1.id },
    second: { kind: 'sketch-curve', sketchId: sketch.id, featureId: line2.id } };
  expect(saved.mathGeometry?.map(definition => definition.name)).toEqual(['合同1', '相似1']);
  // Only the typed width changes; the untouched angle width keeps its stored value, not its 12-digit display.
  expect(saved.mathGeometry?.[0]).toMatchObject({ quantity: { kind: 'congruent', ...pair } });
  expect(saved.mathGeometry?.[0]?.tolerance).toEqual({ linearMm: 0.01, angularRadians: 1e-6 });
  expect(saved.mathGeometry?.[1]).toMatchObject({ quantity: { kind: 'similar', ...pair } });
  expect(saved.mathGeometry?.[1]?.tolerance).toEqual({ linearMm: 1e-6, angularRadians: 1e-6 });
  // "終了" ends the tool without editing the document and keeps the selection.
  const generation = (await readRecomputeStats(page)).requestedGeneration;
  await panel(page).getByRole('button', { name: m('mathGeometry.closeTool'), exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(tree(page, line2.name)).toHaveAttribute('aria-pressed', 'true');
  expect((await readRecomputeStats(page)).requestedGeneration).toBe(generation);
}
