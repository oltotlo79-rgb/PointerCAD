import { expect, type Locator, type Page, type Request, type Route, type TestInfo } from '@playwright/test';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';
import { clickWorldPoint, commitPopover, fillFields, popover, popoverTitle,
  selectionKindLabel, sketchTool } from './solidCaptureSupport.js';
import { uiMessage } from './uiMessages.js';

/*
 * W72 (EX-09 WP-postprocess-verification): the real static solid analysis result is bound to the conditions it was
 * computed for. Real box tool, real panel, real FEM worker; no store write and no injected result.
 *   1 positive  : the result of the current conditions is shown (independent oracle: area x traction).
 *   1 positive  : a display-only change (shown quantity, deformation scale) keeps the same physical result.
 *   negative    : a material edit (Young's modulus) leaves 0 old results.
 *   negative    : a mesh condition edit (boundary distance tolerance) leaves 0 old results.
 *   negative    : a run cancelled while it provably cannot finish never revives: one real FEM asset request of that
 *                 run is held unanswered, the material edit cancels the run, its worker closes, the held request is
 *                 then let through with the real server bytes, and 0 results remain.
 * The store/runner rules themselves are unit-tested with scripted ports (attachSolidAnalysis.test.ts: in-flight
 * termination, shape change, mode switch; solidAnalysisSlice.test.ts: material invalidation): those prove that a late
 * reply is rejected. This spec proves the real-screen mid-run cancel with the real worker and the visible panel only.
 */



const FEM_WORKER = /\/fem\/worker\.js$/u;
// Loaded top face 40 x 30 mm, traction Z -0.001 N/mm^2: total force Z = -1.2 N (independent of the product).
const LOADED_AREA_MM2 = 1200;
const TRACTION_Z = -0.001;
const TOTAL_FORCE_Z = LOADED_AREA_MM2 * TRACTION_Z;

// The FEM worker fetches every pinned asset from /fem/assets/ (batches of 4 under Promise.all, cache 'no-store') before it
// creates the interpreter (packages/fem/src/offlineBrowser.ts runInBrowser). The page itself never requests /fem/assets/.
const FEM_ASSET_ROUTE = '**/fem/assets/**';
const FEM_ASSET = /\/fem\/assets\/[^/]+$/u;

export interface FemWorkers { readonly started: () => number; readonly closed: () => number; readonly lastClosedAt: () => number | null }

export function trackFemWorkers(page: Page): FemWorkers {
  let started = 0, closed = 0, lastClosedAt: number | null = null;
  page.on('worker', worker => {
    if (!FEM_WORKER.test(worker.url())) return;
    started += 1; worker.once('close', () => { closed += 1; lastClosedAt = performance.now(); });
  });
  return { started: () => started, closed: () => closed, lastClosedAt: () => lastClosedAt };
}

export interface AssetHold {
  /** The first FEM asset request seen after install, kept unanswered until release; null before it arrives. */
  readonly held: () => Promise<string | null>;
  /** True while the held request has not been let through. */
  readonly holding: () => Promise<boolean>;
  /** Lets the held request go to the real server (real bytes) and returns what the browser reported for it. */
  readonly release: () => Promise<string>;
  /** Releases (if still held) and removes the route; later runs are not routed. */
  readonly dispose: () => Promise<void>;
}

/** Holds exactly one real FEM asset request so that the run that made it cannot finish while it is held.
 * Same page.route hold of a real worker's runtime request as a-math-input.spec.ts (exact-math pyodide.asm.wasm). */
export async function holdFirstFemAsset(page: Page): Promise<AssetHold> {
  let held: Request | null = null, released = false, outcome: string | null = null;
  let open = (): void => undefined;
  const gate = new Promise<void>(resolve => { open = resolve; });
  const passed: string[] = [];
  const handler = async (route: Route): Promise<void> => {
    if (held !== null) {
      // Sibling asset requests of the same batch go to the real server at once; the held one alone blocks the run.
      passed.push(new URL(route.request().url()).pathname);
      try { await route.continue(); } catch (error) { passed.push('continue failed: ' + String(error)); }
      return;
    }
    held = route.request();
    await gate;
    // The worker that made this request may already be terminated; record what actually happens, not a guess.
    try { await route.continue(); outcome = 'continued'; } catch (error) { outcome = 'continue failed: ' + String(error); }
  };
  await page.route(FEM_ASSET_ROUTE, handler);
  const release = async (): Promise<string> => {
    released = true; open();
    // Bounded by the existing kernel limit: a hung release fails here instead of blocking the test.
    await expect.poll(() => outcome, { timeout: KERNEL_TIMEOUT_MS, message: 'held FEM asset request was not released' })
      .not.toBeNull();
    const request = held;
    return `held=${request === null ? 'none' : new URL(request.url()).pathname} release=${String(outcome)}`
      + ` failure=${request?.failure()?.errorText ?? 'none'} siblings=${JSON.stringify(passed)}`;
  };
  return {
    held: async () => held?.url() ?? null, holding: async () => held !== null && !released, release,
    dispose: async () => { released = true; open(); await page.unroute(FEM_ASSET_ROUTE, handler); },
  };
}

/** Every FEM worker started so far has closed: no request of an earlier run can still reply. */
export async function expectFemQuiet(workers: FemWorkers): Promise<void> {
  expect(workers.started()).toBeGreaterThan(0);
  await expect.poll(() => workers.closed(), { timeout: KERNEL_TIMEOUT_MS }).toBe(workers.started());
}

function resultValue(result: Locator, label: string): Promise<string> {
  return result.getByText(label, { exact: true }).locator('xpath=following-sibling::dd[1]').innerText();
}

function textbox(panel: Locator, name: string): Locator {
  return panel.getByRole('textbox', { name, exact: true });
}

async function expectNoResult(panel: Locator): Promise<void> {
  await expect(panel.getByTestId('solid-results')).toHaveCount(0);
  await expect(panel.getByTestId('solid-element-probe')).toHaveCount(0);
  await expect(panel.getByTestId('solid-field-empty')).toBeVisible();
  await expect(panel.getByTestId('solid-field-legend')).toHaveCount(0);
}

/** Runs and returns the shown maximum displacement (mm) after checking the oracle force of this load. */
async function runToResult(panel: Locator): Promise<{ readonly displacement: string; readonly force: string }> {
  await panel.getByTestId('solid-run').click();
  const result = panel.getByTestId('solid-results');
  await expect(result).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
  await expect(panel.locator(':scope > [role="alert"]')).toHaveCount(0);
  const force = await resultValue(result, '荷重合力 X, Y, Z');
  const reaction = await resultValue(result, '支持反力の合計 X, Y, Z');
  expect(Number.parseFloat(await resultValue(result, '荷重面積'))).toBeCloseTo(LOADED_AREA_MM2, 6);
  expect(Number.parseFloat(force.split(',')[2])).toBeCloseTo(TOTAL_FORCE_Z, 6);
  expect(Number.parseFloat(reaction.split(',')[2])).toBeCloseTo(-TOTAL_FORCE_Z, 4);
  return { displacement: await resultValue(result, '最大変位量'), force };
}

export async function analysisResultBindingFlow(page: Page, info: TestInfo, desktop: boolean, desktopHold?: () => Promise<AssetHold>,
  stopObservation?: (elapsedMs: number) => void,
  dofObservation?: (counts: { nodes: number; nodeLimit: number; total: number; fixed: number; free: number }) => void): Promise<void> {
  const errors: string[] = [];
  const observations: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); observations.push(`pageerror: ${error.message}`); });
  page.on('console', message => { observations.push(`console ${message.type()}: ${message.text()}`); });
  page.on('worker', worker => {
    if (!FEM_WORKER.test(worker.url())) return;
    observations.push(`FEM worker started: ${worker.url()}`);
    worker.once('close', () => { observations.push(`FEM worker closed: ${worker.url()}`); });
  });
  try {
    if (!desktop) await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
    // The actual box tool creates 40 x 30 x 10 mm centred at the origin (as solidBoundaryAuthoringFlow).
    await openToolMenu(page, '作る');
    await toolMenuPanel(page, '作る').getByRole('button', { name: '箱', exact: true }).click();
    await expect(popoverTitle(page)).toHaveText('箱を置く');
    await fillFields(page, ['40', '30', '10']);
    const recompute = await beginRecompute(page);
    await commitPopover(page);
    await expect(popover(page)).toHaveCount(0);
    await waitForRecompute(page, recompute);
    await sketchTool(page, '選択').click();
    await page.keyboard.press('3');
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');

    await openToolMenu(page, '解析');
    await toolMenuPanel(page, '解析').getByRole('button', { name: '現在の立体を解析', exact: true }).click();
    const panel = page.getByTestId('solid-analysis-panel');
    await expect(panel).toBeVisible();
    await clickWorldPoint(page, [20, 0, 0]);
    await panel.getByTestId('solid-fixed').click();
    await expect(panel.getByTestId('solid-fixed')).toHaveText('選択面を固定 (1)');
    await clickWorldPoint(page, [0, 0, 5]);
    await panel.getByTestId('solid-loaded').click();
    await expect(panel.getByTestId('solid-loaded')).toHaveText('選択面に荷重 (1)');
    await textbox(panel, '面荷重 Z (N/mm²)').fill(String(TRACTION_Z));
    await textbox(panel, 'ヤング率 E (MPa)').fill('210000');
    await textbox(panel, 'ポアソン比 ν').fill('0.3');
    await textbox(panel, '曲面の最大体積差 (mm³)').fill('1');
    await expectNoResult(panel);

    // Negative: a run cancelled while it provably cannot finish. One real asset request of its first FEM worker is held
    // unanswered, so that worker cannot create the interpreter and no later stage can start. The material edit then
    // cancels the run; the worker must close while the request is still held, and after the held request is let through
    // with the real server bytes no result may appear.
    const workers = trackFemWorkers(page);
    const hold = desktop ? await (desktopHold ?? (() => { throw new Error('Electron FEM asset hold required'); }))() : await holdFirstFemAsset(page);
    try {
      await panel.getByTestId('solid-run').click();
      await expect.poll(() => hold.held(),
        { timeout: KERNEL_TIMEOUT_MS, message: 'the route must hold the FEM worker asset request' }).toMatch(FEM_ASSET);
      // Exactly one FEM worker exists (the next stage needs this one to finish) and it is alive while the request is held.
      await expect.poll(() => workers.started(), { timeout: KERNEL_TIMEOUT_MS }).toBe(1);
      expect(workers.closed()).toBe(0);
      // The panel's own running line only (yield, export and support rows have their own status elements).
      const running = panel.locator(':scope > [role="status"]');
      await expect(running).toHaveAttribute('data-stage', 'meshing');
      await expect(panel.getByTestId('solid-results')).toHaveCount(0);
      if (stopObservation === undefined) {
        await textbox(panel, 'ヤング率 E (MPa)').fill('105000');
        await expect(running).toHaveCount(0);
        await expectFemQuiet(workers);
      } else {
        const startedAt = performance.now();
        await panel.getByRole('button', { name: '計算を中止', exact: true }).click();
        await expectFemQuiet(workers);
        const closedAt = workers.lastClosedAt();
        if (closedAt === null || closedAt < startedAt) throw new Error('Missing worker close timestamp after stop');
        const elapsedMs = closedAt - startedAt;
        stopObservation(elapsedMs);
        expect(elapsedMs).toBeLessThanOrEqual(1000);
        await expect(running).toHaveCount(0);
        await textbox(panel, 'ヤング率 E (MPa)').fill('105000');
      }
      // Still held: the run was cancelled, it did not complete.
      expect(await hold.holding()).toBe(true);
      await expectNoResult(panel);
      info.annotations.push({ type: 'w72-held-fem-asset', description: await hold.release() });
    } finally {
      await hold.dispose();
    }
    // After the held request was let through, the cancelled run started nothing and left no result.
    expect(workers.started()).toBe(1);
    await expectNoResult(panel);

    // Positive: the result of the current conditions (E = 105000 MPa) is shown with the oracle force.
    const half = await runToResult(panel);
    if (dofObservation !== undefined) {
      const raw = await panel.getByTestId('solid-results').evaluate(element => [
        element.getAttribute('data-solid-nodes'), element.getAttribute('data-solid-node-limit'), element.getAttribute('data-solid-dof-total'),
        element.getAttribute('data-solid-dof-fixed'), element.getAttribute('data-solid-dof-free'),
      ]);
      if (raw.some(value => value === null || !/^(0|[1-9]\d*)$/u.test(value))) throw new Error('Missing current tet4 DOF counts');
      const [nodes, nodeLimit, total, fixed, free] = raw.map(Number);
      if (nodes < 1 || nodes > nodeLimit || total !== nodes * 3 || fixed + free !== total) throw new Error('Invalid current tet4 DOF counts');
      dofObservation({ nodes, nodeLimit, total, fixed, free });
    }
    await expectFemQuiet(workers);
    const probe = panel.getByTestId('solid-element-probe');
    const elementNumber = probe.getByRole('spinbutton', { name: '要素番号（1から）', exact: true });
    await expect(elementNumber).toHaveValue('1');
    await expect(probe.getByRole('listitem')).toHaveCount(4);
    const actualNodeValues = await probe.getByRole('listitem').allTextContents();
    expect(actualNodeValues.every(text => /節点 [1-9]\d*:.*座標.* mm;.*実変位.* mm;.*反力.* N/u.test(text))).toBe(true);
    expect(actualNodeValues.join(' ')).not.toMatch(/NaN|Infinity/u);
    await elementNumber.fill('0');
    await expect(probe.getByRole('listitem')).toHaveCount(0);
    await expect(probe.getByRole('status')).toHaveText('要素の値を確認できません');
    await elementNumber.fill('1');
    await expect(probe.getByRole('listitem')).toHaveCount(4);
    expect(await probe.getByRole('listitem').allTextContents()).toEqual(actualNodeValues);
    // W64 (EX-09): the probe states its coordinate system, equivalent strain and element energy with the message-table
    // texts, and every shown result warning is one of the three message-table conditions.
    const message = (key: string): string => uiMessage('solidAnalysis', `solidAnalysis.${key}`);
    await expect(probe.locator('[data-coordinates="global-XYZ-undeformed"]')).toHaveText(message('probeCoordinates'));
    await expect(probe).toContainText(`${message('probeEquivalentStrain')}: `);
    await expect(probe).toContainText(`${message('probeEnergy')}: `);
    await expect(probe).toContainText(` ${message('unitEnergy')}`);
    const warningItems = panel.getByTestId('solid-result-warnings').getByRole('listitem');
    const warnings = await warningItems.allTextContents();
    const known = ['warningSingular', 'warningNotConverged', 'warningAveraging'].map(name => message(name));
    expect(warnings.every(text => known.includes(text)), JSON.stringify(warnings)).toBe(true);
    info.annotations.push({ type: 'w64-result-warnings', description: JSON.stringify({ warnings,
      residual: await resultValue(panel.getByTestId('solid-results'), '相対つり合い残差') }) });

    // Positive: display-only settings keep the same physical result (same displayed values, legend still drawn).
    await panel.getByTestId('solid-field-quantity').selectOption('xx');
    await panel.getByTestId('solid-field-scale').fill('2');
    const shown = panel.getByTestId('solid-results');
    await expect(shown).toBeVisible();
    await expect(panel.getByTestId('solid-field-legend')).toBeVisible();
    expect(await resultValue(shown, '最大変位量')).toBe(half.displacement);
    expect(await resultValue(shown, '荷重合力 X, Y, Z')).toBe(half.force);
    await expect(probe.getByRole('listitem')).toHaveCount(4);
    expect(await probe.getByRole('listitem').allTextContents()).toEqual(actualNodeValues);
    expect(await warningItems.allTextContents()).toEqual(warnings);

    // Negative: material edit. The old result is gone at once and stays gone after every worker has closed.
    await textbox(panel, 'ヤング率 E (MPa)').fill('210000');
    await expectNoResult(panel);
    await expectFemQuiet(workers);
    await expectNoResult(panel);
    // The re-run shows the current material, not a revived old reply: linear static, same mesh, force-controlled load,
    // so doubling E halves the displacement (old value 1x vs current 0.5x).
    const full = await runToResult(panel);
    expect(Number.parseFloat(half.displacement) / Number.parseFloat(full.displacement)).toBeCloseTo(2, 3);

    // Negative: mesh condition edit (boundary distance tolerance) leaves no old result.
    await textbox(panel, '境界の距離公差 (mm)').fill('0.05');
    await expectNoResult(panel);
    await expectFemQuiet(workers);
    await expectNoResult(panel);
    expect(errors).toEqual([]);
  } finally {
    await info.attach('w72-host-worker-console', { contentType: 'application/json', body: JSON.stringify(observations) });
  }
}
