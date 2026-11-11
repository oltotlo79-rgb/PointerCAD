import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readPcadFile } from '../../packages/io/src/index.js';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { disableFilePickers } from './filePickers.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { clickWorldPoint, commitPopover, drawRectangle, fillFields, popover, popoverTitle, selectionKindLabel,
  sketchTool, treeRow, type WorldPoint } from './solidCaptureSupport.js';
import { waitForStartupHealth } from './startupHealth.js';
import { holdFirstFemAsset } from './analysisResultBindingFlow.js';
import { holdElectronFemAsset } from './electronFemAssetHold.js';

/*
 * rev35: the thin-sheet (shell) analysis on the real screen, the real FEM Worker, save, reopen and rerun.
 * Chromium, Firefox and Electron run this same flow (shell-analysis-connections.spec.ts,
 * electron-shell-analysis-connections.spec.ts). No store write, no injected result, no solver stand-in.
 *
 * Sheet: the only producer of a 'shell' body is the surface feature (kernel recomputeSolids 'surface'); the screen
 * route is a closed 40 x 30 rectangle of four lines on XY (drawRectangle, the same helper as solid.spec.ts) and
 * 作る / 曲面 / 作り方 = 平らに張る (shapeEditCommands.ts surfaceOperationOf 'planar').
 *
 * Independent expectation (packages/fem/src/cadShellAnalysis.test.ts lines 182-187, 254-264, 312-337, the W08
 * pure-bending case; not a product observation): plate in XY, normal +Z (top side); E = 210000 MPa, nu = 0.3,
 * t = 2 mm; +M = 100 N·mm/mm about +y on the x = 40 edge, -M on the x = 0 edge; fixes (0,0) ux uy uz,
 * (0,30) ux uz, (40,0) uz. Then every integration point has top = (+6M/t^2, 0, 0, 0, 0, 0) and
 * bottom = (-6M/t^2, 0, ...), i.e. sigma_xx = +/-150 MPa, all other components 0, relative tolerance 1e-3
 * (TOLERANCE of the source test, inherited unchanged). sigma_xx is along global X because the moment vector is
 * about Y on the edges normal to X (beam bending in the XZ plane).
 *
 * Known product gap (notice-rev35.json blocker): the real planar sheet has no tracked semantic origins
 * (makeSurface.ts passes origins only for 'extrude'), so the capture steps below are expected to show
 * shellAnalysis.untracked until the kernel gives the sheet face/edge/vertex origins. This flow is not weakened
 * for that: it fails at the first capture with the panel's own reason instead of passing.
 */

const FEM_WORKER = /\/fem\/worker\.js$/u;
const E_MPA = 210000, NU = 0.3, T_MM = 2, M_NMM_PER_MM = 100, TOLERANCE = 1e-3;
const BENDING_MPA = 6 * M_NMM_PER_MM / T_MM ** 2;
/** Same surface options as the source test (OPTIONS): the five editable split conditions. */
const SPLIT = { linear: '0.05', angular: '0.2', minimumArea: '1', minimumAngle: '20', maximumAspect: '4' } as const;
const SOURCE = { kind: 'user-supplied', reference: 'cadShellAnalysis.test.ts W08 純曲げの入力値（E=210000 MPa, ν=0.3）',
  condition: '常温・線形弾性' } as const;
const EDITED_T_MM = 4;

interface FemWorkers { readonly started: () => number; readonly closed: () => number; readonly log: readonly string[] }

/** Real FEM Worker creation/termination as the browser reports it (same method as analysisResultBindingFlow.ts). */
function trackFemWorkers(page: Page): FemWorkers {
  let started = 0, closed = 0;
  const log: string[] = [];
  page.on('worker', worker => {
    if (!FEM_WORKER.test(worker.url())) return;
    started += 1; log.push(`started ${String(started)}: ${worker.url()}`);
    worker.once('close', () => { closed += 1; log.push(`closed ${String(closed)}: ${worker.url()}`); });
  });
  return { started: () => started, closed: () => closed, log };
}

async function expectFemQuiet(workers: FemWorkers): Promise<void> {
  await expect.poll(() => workers.closed(), { timeout: KERNEL_TIMEOUT_MS }).toBe(workers.started());
}

function shellPanel(page: Page): Locator { return page.getByTestId('shell-analysis-panel'); }
function field(scope: Locator, label: string): Locator { return scope.getByRole('textbox', { name: label, exact: true }); }

async function openShellPanel(page: Page): Promise<Locator> {
  await openToolMenu(page, '解析');
  await toolMenuPanel(page, '解析').getByRole('button', { name: '薄板の解析', exact: true }).click();
  const panel = shellPanel(page);
  await expect(panel).toBeVisible();
  return panel;
}

async function expectNotComputed(panel: Locator): Promise<void> {
  await expect(panel.getByTestId('shell-results')).toHaveCount(0);
  await expect(panel.getByTestId('shell-empty')).toBeVisible();
  await expect(panel.getByTestId('shell-running')).toHaveCount(0);
}

async function expectNoPanelError(panel: Locator): Promise<void> {
  await expect(panel.getByTestId('shell-error')).toHaveCount(0);
  await expect(panel.getByTestId('shell-input-problem')).toHaveCount(0);
}

/** "min … max MPa" of the shown component as two numbers (the panel writes String(value): full precision). */
async function stressRange(panel: Locator, testId: 'shell-top-stress' | 'shell-bottom-stress'): Promise<readonly [number, number]> {
  const text = await panel.getByTestId(testId).innerText();
  const [low, high] = text.replace('MPa', '').split('…').map(part => Number.parseFloat(part.trim()));
  if (!Number.isFinite(low) || !Number.isFinite(high)) throw new Error(`Not a finite stress range: ${text}`);
  return [low, high];
}

/** Both ends of the shown range against the independent value, relative to the bending scale (source test rule). */
async function expectRange(panel: Locator, testId: 'shell-top-stress' | 'shell-bottom-stress', exact: number,
  scale: number): Promise<void> {
  const [low, high] = await stressRange(panel, testId);
  expect(Math.abs(low - exact) / scale, `${testId} minimum ${String(low)} vs ${String(exact)}`).toBeLessThanOrEqual(TOLERANCE);
  expect(Math.abs(high - exact) / scale, `${testId} maximum ${String(high)} vs ${String(exact)}`).toBeLessThanOrEqual(TOLERANCE);
}

interface Shown { readonly top: string; readonly bottom: string; readonly displacement: string }

/** One real run: exactly one new FEM Worker, a complete result, no error; returns the shown texts. */
async function runOnce(panel: Locator, workers: FemWorkers): Promise<Shown> {
  const before = workers.started();
  await expect(panel.getByTestId('shell-run')).toBeEnabled();
  await panel.getByTestId('shell-run').click();
  await expect(panel.getByTestId('shell-results')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
  await expectNoPanelError(panel);
  await expect(panel.getByTestId('shell-cancelled')).toHaveCount(0);
  await expect(panel.getByTestId('shell-not-finite')).toHaveCount(0);
  expect(workers.started()).toBe(before + 1);
  await expectFemQuiet(workers);
  return { top: await panel.getByTestId('shell-top-stress').innerText(),
    bottom: await panel.getByTestId('shell-bottom-stress').innerText(),
    displacement: await panel.getByTestId('shell-max-displacement').innerText() };
}

async function expectBending(panel: Locator, thicknessMm: number): Promise<void> {
  const surface = 6 * M_NMM_PER_MM / thicknessMm ** 2;
  await expect(panel.getByTestId('shell-stress-component')).toHaveValue('xx');
  await expectRange(panel, 'shell-top-stress', surface, surface);
  await expectRange(panel, 'shell-bottom-stress', -surface, surface);
}

/** Selects one sub-shape on the screen and adds it through the panel's own capture button. */
async function capture(page: Page, panel: Locator, at: WorldPoint, button: 'shell-capture-midsurface'
  | 'shell-capture-support' | 'shell-capture-load'): Promise<void> {
  await clickWorldPoint(page, at);
  await panel.getByTestId(button).click();
  // Capturing geometry is allowed while material and support fields are still incomplete.
  // Full input validity is checked after filling every field and again after each solver run.
  await expect(panel.getByTestId('shell-error')).toHaveCount(0);
}

/** Real planar sheet 40 x 30 on XY through the screen: four lines, then 曲面 / 平らに張る. */
async function makePlanarSheet(page: Page): Promise<void> {
  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await treeRow(page, '線分1').click();
  for (const name of ['線分2', '線分3', '線分4']) await treeRow(page, name).click({ modifiers: ['Shift'] });
  await openToolMenu(page, '作る');
  await toolMenuPanel(page, '作る').getByRole('button', { name: '曲面', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('曲面の作り方');
  // Six options (not more than LONG_CHOICE_OPTION_THRESHOLD = 6): a segmented group, not a menu.
  const operation = popover(page).getByRole('group', { name: '作り方', exact: true });
  await expect(operation.getByRole('button', { name: '掛ける', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await operation.getByRole('button', { name: '平らに張る', exact: true }).click();
  await expect(operation.getByRole('button', { name: '平らに張る', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const recompute = await beginRecompute(page);
  await popover(page).getByRole('button', { name: '決定', exact: true }).click();
  await expect(popover(page)).toHaveCount(0);
  await waitForRecompute(page, recompute);
  await expect(treeRow(page, '曲面1')).toBeVisible();
}

async function fillInputs(panel: Locator, thicknessMm: number): Promise<void> {
  await field(panel, '板厚 t').fill(String(thicknessMm));
  await field(panel, '中央面のずらし').fill('0');
  await field(panel, 'ヤング率 E').fill(String(E_MPA));
  await field(panel, 'ポアソン比 ν').fill(String(NU));
  await panel.getByTestId('shell-source-kind').selectOption(SOURCE.kind);
  await panel.getByTestId('shell-source-reference').fill(SOURCE.reference);
  await panel.getByTestId('shell-source-condition').fill(SOURCE.condition);
  await field(panel, '表面分割の線形精度').fill(SPLIT.linear);
  await field(panel, '表面分割の角度精度').fill(SPLIT.angular);
  await field(panel, '三角形の最小面積').fill(SPLIT.minimumArea);
  await field(panel, '三角形の最小角度').fill(SPLIT.minimumAngle);
  await field(panel, '三角形の最大縦横比').fill(SPLIT.maximumAspect);
}

async function addSupports(page: Page, panel: Locator): Promise<void> {
  const rows = panel.getByTestId('shell-support-row');
  const fixes: readonly { readonly at: WorldPoint; readonly dofs: readonly string[] }[] = [
    { at: [0, 0, 0], dofs: ['ux', 'uy', 'uz'] }, { at: [0, 30, 0], dofs: ['ux', 'uz'] }, { at: [40, 0, 0], dofs: ['uz'] }];
  await panel.getByRole('button', { name: '頂点を選ぶ', exact: true }).click();
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 頂点');
  for (const [index, fix] of fixes.entries()) {
    await capture(page, panel, fix.at, 'shell-capture-support');
    await expect(rows).toHaveCount(index + 1);
    for (const dof of fix.dofs) await rows.nth(index).getByTestId(`shell-support-${dof}`).check();
    // A support row that fixes nothing shows its own alert; every row here fixes at least one direction.
    await expect(rows.nth(index).getByRole('alert')).toHaveCount(0);
  }
}

async function addMoments(page: Page, panel: Locator): Promise<void> {
  const rows = panel.getByTestId('shell-load-row');
  const loads: readonly { readonly at: WorldPoint; readonly my: number }[] = [
    { at: [40, 15, 0], my: M_NMM_PER_MM }, { at: [0, 15, 0], my: -M_NMM_PER_MM }];
  await panel.getByRole('button', { name: '辺を選ぶ', exact: true }).click();
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 辺');
  for (const [index, load] of loads.entries()) {
    await capture(page, panel, load.at, 'shell-capture-load');
    await expect(rows).toHaveCount(index + 1);
    const row = rows.nth(index);
    for (const [label, value] of [['力 X', 0], ['力 Y', 0], ['力 Z', 0], ['モーメント X', 0], ['モーメント Y', load.my],
      ['モーメント Z', 0]] as const) await field(row, label).fill(String(value));
  }
}

type SavedShell = NonNullable<ReturnType<typeof savedShellOf>>;
function savedShellOf(bytes: Uint8Array) {
  const read = readPcadFile(bytes);
  if (!read.ok) throw new Error(read.error.message);
  const found = read.document.beamAnalysisInputs?.analyses.find(value => value.kind === 'shell-cad-analysis');
  return found?.kind === 'shell-cad-analysis' ? found.definition : null;
}

/** Saved document holds every physical input exactly as entered (material, source, thickness, loads, fixes, split). */
function expectSavedInput(saved: SavedShell, thicknessMm: number): void {
  expect(saved.material.youngMPa).toBe(E_MPA);
  expect(saved.material.poisson).toBe(NU);
  expect(saved.material.source).toEqual(SOURCE);
  expect(saved.geometry.thicknessMm).toBe(thicknessMm);
  expect(saved.geometry.offsetMm).toBe(0);
  expect(saved.geometry.midsurfaceFaces).toHaveLength(1);
  expect(saved.supports.map(row => [row.kind, row.fixed])).toEqual([
    ['vertex', [true, true, true, false, false, false]], ['vertex', [true, false, true, false, false, false]],
    ['vertex', [false, false, true, false, false, false]]]);
  expect(saved.edgeLoads.map(row => [row.forceNPerMm, row.momentNmmPerMm])).toEqual([
    [[0, 0, 0], [0, M_NMM_PER_MM, 0]], [[0, 0, 0], [0, -M_NMM_PER_MM, 0]]]);
  const surface = saved.surface;
  expect([surface.linearDeflection, surface.angularDeflection, surface.minimumTriangleAreaMm2, surface.minimumAngleDeg,
    surface.maximumAspectRatio]).toEqual([SPLIT.linear, SPLIT.angular, SPLIT.minimumArea, SPLIT.minimumAngle,
    SPLIT.maximumAspect].map(Number));
  expect(Number.isSafeInteger(surface.maximumNodes) && surface.maximumNodes > 0).toBe(true);
  expect(Number.isSafeInteger(surface.maximumTriangles) && surface.maximumTriangles > 0).toBe(true);
}

/** The shown inputs after reopening are the saved ones (not defaults). */
async function expectRestoredFields(panel: Locator, thicknessMm: number): Promise<void> {
  await expect(field(panel, '板厚 t')).toHaveValue(String(thicknessMm));
  await expect(field(panel, 'ヤング率 E')).toHaveValue(String(E_MPA));
  await expect(field(panel, 'ポアソン比 ν')).toHaveValue(String(NU));
  await expect(panel.getByTestId('shell-source-kind')).toHaveValue(SOURCE.kind);
  await expect(panel.getByTestId('shell-source-reference')).toHaveValue(SOURCE.reference);
  await expect(panel.getByTestId('shell-source-condition')).toHaveValue(SOURCE.condition);
  for (const [label, value] of [['表面分割の線形精度', SPLIT.linear], ['表面分割の角度精度', SPLIT.angular],
    ['三角形の最小面積', SPLIT.minimumArea], ['三角形の最小角度', SPLIT.minimumAngle], ['三角形の最大縦横比', SPLIT.maximumAspect]] as const) {
    await expect(field(panel, label)).toHaveValue(value);
  }
  await expect(panel.getByTestId('shell-support-row')).toHaveCount(3);
  await expect(panel.getByTestId('shell-load-row')).toHaveCount(2);
}

async function startPage(page: Page, info: TestInfo, url: string, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  if (app === undefined) await disableFilePickers(page);
  await page.goto(url);
  await waitForStartupHealth(page, info);
}

/** Positive: real sheet -> inputs -> real Worker -> 6M/t^2 -> save -> reopen not computed -> rerun same -> edits. */
export async function shellAnalysisPersistenceFlow(page: Page, info: TestInfo, url = '/', app?: ElectronApplication):
  Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const workers = trackFemWorkers(page);
  const cancellationLog: string[] = [];
  try {
    await startPage(page, info, url, app);
    await sketchTool(page, '選択').click();
    await makePlanarSheet(page);

    const panel = await openShellPanel(page);
    await expectNotComputed(panel);
    // The panel opens in face selection; the midsurface is the sheet's single face.
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
    await capture(page, panel, [20, 15, 0], 'shell-capture-midsurface');
    await expect(panel.getByTestId('shell-midsurface')).toContainText('中央面の数: 1');
    await fillInputs(panel, T_MM);
    await addSupports(page, panel);
    await addMoments(page, panel);
    await expectNoPanelError(panel);
    await expectNotComputed(panel);
    expect(workers.started()).toBe(0);

    // One real asset response prevents the first real worker from completing before the explicit stop.
    const hold = app === undefined ? await holdFirstFemAsset(page) : await holdElectronFemAsset(app);
    try {
      await panel.getByTestId('shell-run').click();
      await expect.poll(() => hold.held(), { timeout: KERNEL_TIMEOUT_MS,
        message: 'the real FEM worker asset must be held' }).toMatch(/\/fem\/assets\/[^/]+$/u);
      await expect.poll(() => workers.started(), { timeout: KERNEL_TIMEOUT_MS }).toBe(1);
      expect(workers.closed()).toBe(0);
      await expect(panel.getByTestId('shell-running')).toBeVisible();
      await expect(panel.getByTestId('shell-results')).toHaveCount(0);
      expect(await hold.holding()).toBe(true);
      cancellationLog.push('asset held; worker started=1 closed=0; running visible');
      await panel.getByTestId('shell-cancel').click();
      await expect(panel.getByTestId('shell-cancelled')).toBeVisible();
      await expectFemQuiet(workers);
      expect(workers.started()).toBe(1);
      expect(workers.closed()).toBe(1);
      expect(await hold.holding()).toBe(true);
      await expectNotComputed(panel);
      cancellationLog.push('cancelled; worker started=1 closed=1; asset still held');
      cancellationLog.push(`asset released: ${await hold.release()}`);
      expect(workers.started()).toBe(1);
      expect(workers.closed()).toBe(1);
      await expectNotComputed(panel);
    } finally {
      await hold.dispose();
    }

    // (1) Real Worker run: sigma_xx top = +150, bottom = -150 MPa within 1e-3 (independent formula 6M/t^2).
    const first = await runOnce(panel, workers);
    expect(workers.started()).toBe(2);
    await expectBending(panel, T_MM);

    // (2) Display only: another component shows ~0 (the exact other components are 0), the xx result returns
    // unchanged, and no Worker is started.
    const component = panel.getByTestId('shell-stress-component');
    await component.selectOption('yy');
    await expectRange(panel, 'shell-top-stress', 0, BENDING_MPA);
    await expectRange(panel, 'shell-bottom-stress', 0, BENDING_MPA);
    await component.selectOption('xx');
    await expect(panel.getByTestId('shell-top-stress')).toHaveText(first.top);
    await expect(panel.getByTestId('shell-bottom-stress')).toHaveText(first.bottom);
    await expect(panel.getByTestId('shell-max-displacement')).toHaveText(first.displacement);
    expect(workers.started()).toBe(2);

    // (3) Save the input into the part document (the result is not saved), then the file.
    await panel.getByTestId('shell-save').click();
    await expectNoPanelError(panel);
    const savedBytes = await saveFlowFile(page, info.outputPath('shell-analysis-saved.pcad'), app);
    const saved = savedShellOf(savedBytes);
    if (saved === null) throw new Error('The saved document has no shell-cad-analysis input');
    expectSavedInput(saved, T_MM);

    // (4) Reopen: the restored input, no result (not computed), no Worker started by opening.
    await panel.getByRole('button', { name: '閉じる', exact: true }).click();
    await expect(shellPanel(page)).toHaveCount(0);
    await openSaveFlowFile(page, info.outputPath('shell-analysis-saved.pcad'), app);
    const reopened = await openShellPanel(page);
    await expectNotComputed(reopened);
    await expectNoPanelError(reopened);
    await expectRestoredFields(reopened, T_MM);
    expect(workers.started()).toBe(2);

    // (5) Rerun after reopening: the same shown values as before saving.
    const rerun = await runOnce(reopened, workers);
    expect(workers.started()).toBe(3);
    expect(rerun).toEqual(first);
    await expectBending(reopened, T_MM);

    // (6) Physical edit (thickness): the old result disappears at once and stays gone after every Worker closed.
    await field(reopened, '板厚 t').fill(String(EDITED_T_MM));
    await expectNotComputed(reopened);
    await expectFemQuiet(workers);
    await expectNotComputed(reopened);
    // The run of the edited input follows 6M/t^2 for t = 4 (37.5 MPa), not the old 150 MPa.
    await runOnce(reopened, workers);
    await expectBending(reopened, EDITED_T_MM);
    expect(workers.started()).toBe(4);

    // (7) The re-saved file holds the edited thickness and every other input unchanged.
    await reopened.getByTestId('shell-save').click();
    await expectNoPanelError(reopened);
    const edited = savedShellOf(await saveFlowFile(page, info.outputPath('shell-analysis-edited.pcad'), app));
    if (edited === null) throw new Error('The re-saved document has no shell-cad-analysis input');
    expectSavedInput(edited, EDITED_T_MM);
    expect(edited.surface.maximumNodes).toBe(saved.surface.maximumNodes);
    expect(edited.surface.maximumTriangles).toBe(saved.surface.maximumTriangles);
    expect(edited.material.id).toBe(saved.material.id);
    expect(errors).toEqual([]);
  } finally {
    await info.attach('shell-analysis-fem-workers', { contentType: 'application/json', body: JSON.stringify(workers.log) });
    await info.attach('shell-analysis-cancellation-order', { contentType: 'application/json', body: JSON.stringify(cancellationLog) });
  }
}

/** Refusal: a solid box is not a sheet. The panel shows its reason and no FEM Worker is ever started. */
export async function shellAnalysisSolidRefusalFlow(page: Page, info: TestInfo, url = '/', app?: ElectronApplication):
  Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const workers = trackFemWorkers(page);
  try {
    await startPage(page, info, url, app);
    // The actual box tool creates 40 x 30 x 10 mm centred at the origin (as analysisResultBindingFlow.ts).
    await openToolMenu(page, '作る');
    await toolMenuPanel(page, '作る').getByRole('button', { name: '箱', exact: true }).click();
    await expect(popoverTitle(page)).toHaveText('箱を置く');
    await fillFields(page, ['40', '30', '10']);
    const recompute = await beginRecompute(page);
    await commitPopover(page);
    await expect(popover(page)).toHaveCount(0);
    await waitForRecompute(page, recompute);
    await sketchTool(page, '選択').click();

    const panel = await openShellPanel(page);
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
    await clickWorldPoint(page, [0, 0, 5]);
    await panel.getByTestId('shell-capture-midsurface').click();
    await expect(panel.getByTestId('shell-error'))
      .toHaveText('選んだ立体は面（シート）の立体ではありません。ソリッドの中央面は推定しません。');
    await expect(panel.getByTestId('shell-midsurface')).toContainText('中央面の数: 0');
    // Without a midsurface the input is incomplete: the run cannot start.
    await expect(panel.getByTestId('shell-run')).toBeDisabled();
    await expectNotComputed(panel);
    expect(workers.started()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await info.attach('shell-analysis-refusal-fem-workers', { contentType: 'application/json', body: JSON.stringify(workers.log) });
  }
}
