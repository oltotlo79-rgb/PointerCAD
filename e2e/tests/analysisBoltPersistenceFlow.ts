/// <reference lib="dom" />
import { readFile, writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readDocumentBundle, writeDocumentBundle } from '../../packages/io/src/index.js';
import { createAssemblyDocumentBundle, EMPTY_PART_LIBRARY, partKeyOf } from '../../packages/model/src/index.js';
import { cadAxialBoltFixture } from '../../packages/model/src/analysis/cadAxialBolt.testSupport.js';
import type { CadAxialBoltInputs } from '../../packages/model/src/analysis/axialBoltInput.js';
import { expectFemQuiet, trackFemWorkers, type AssetHold } from './analysisResultBindingFlow.js';
import { resetAssemblyFileGateway } from './assemblyTestSupport.js';
import { componentRows } from './boltedJointTestSupport.js';
import { KERNEL_TIMEOUT_MS, waitForSettledRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { confirmWeldSpanMembers, openWeldSpanPanel, weldSpanPanel } from './weldSpanAuthorFlow.js';

/*
 * Axial bolt joint analysis (BeamAxialBolts) on the real UI and the real FEM Worker path, in every environment.
 * Fixture: the existing cadAxialBoltFixture (packages/model/src/analysis/cadAxialBolt.testSupport.ts) written through
 * the existing public model/io route. Only its members, supports, load and stop contact are prefilled; the bolt row
 * is added and every bolt control is typed in the real panel.
 * Independent oracle (closed form from the fixture inputs, never from product observations):
 *   members a and b: FB 50x6, E = 208000 N/mm2, A = 300 mm2, L = 10 mm  -> ka = EA/L = 6.24e9 N/m each;
 *   bolt between a-tip (z = 10 mm) and b-base (z = 20 mm): L = 10 mm; E and A typed -> kb = EA/L
 *   (E = 1000 N/mm2, A = 10 mm2 -> kb = 1e6 N/m, the value asserted by cadAxialBolt.test.ts);
 *   a-base and b-tip clamped, Fz = 1 N at a-tip, load factors [1, -1], stop at b-base n = +z, gap 10 mm (stays open).
 *   Open stop: u1 = F (ka + kb) / (ka (ka + 2 kb)) at a-tip, u2 = F kb / (ka (ka + 2 kb)) at b-base,
 *   extension = u2 - u1 = -F / (ka + 2 kb), N = kb * extension (tension positive: compression here).
 *   Equilibrium a-tip: F + N - ka u1 = 0; b-base: -N - ka u2 = 0. Gap = 0.01 m + u2 (beamBoltContact.test.ts raw()).
 * Criteria as decodeBeamBoltContact (packages/fem/src/beamBoltContact.ts): relative 1e-9.
 * Added links: incomplete input notice, stop with a held real FEM asset request (real bytes released afterwards),
 * real run, discard on condition change, saved input equality, no stale result after reopen, new real worker run.
 * Two complete solves only (initial input; changed input after save and reopen) besides the cancelled one.
 */

const FEM_ASSET = /\/fem\/assets\/[^/]+$/u;
const RESULT_TIMEOUT_MS = 120_000;
const RELATIVE = 1e-9;
const FORCE_N = 1;
const LOAD_FACTORS = [1, -1] as const;
const MEMBER_STIFFNESS_N_PER_M = 208000e6 * 300e-6 / 0.01;
const BOLT_LENGTH_M = 0.01;
const STOP_GAP_M = 0.01;
const BOLT_AREA_MM2 = 10;
const FIRST_YOUNG_MPA = 1000;
const CHANGED_YOUNG_MPA = 2000;
const REFERENCE = 'Independent cadAxialBolt.test.ts fixture: E=1000 N/mm2, A=10 mm2, L=10 mm';
const CONDITION = 'Bilateral uniform axial elastic shank; no preload, slip, buckling or certification';

function panel(page: Page): Locator { return weldSpanPanel(page); }
function status(page: Page): Locator { return panel(page).getByTestId('beam-status'); }
function definitions(page: Page): Locator { return panel(page).getByTestId('beam-axial-bolt-definitions'); }
function boltRows(page: Page): Locator { return definitions(page).locator('fieldset[data-axial-bolt]'); }
function control(page: Page, label: string, kind: 'select' | 'input'): Locator {
  return boltRows(page).first().locator('label', { hasText: label }).locator(kind);
}

async function fixture() {
  const f = cadAxialBoltFixture();
  // The association itself is authored through the controls; only the existing contact definition is saved.
  const document = { ...f.document, beamAnalysisInputs: { schema: 'pointercad-beam-inputs/1' as const,
    analyses: [{ kind: 'standard-members' as const, definition: f.definition }] } };
  const bolt = f.document.components.find(component => component.id === 'bolt');
  if (bolt === undefined) throw new Error('Existing axial bolt fixture lacks its hexBolt occurrence');
  return { bytes: await writeDocumentBundle(createAssemblyDocumentBundle(document, EMPTY_PART_LIBRARY)),
    componentCount: document.components.length, boltPartKey: partKeyOf(bolt.source) };
}

async function expectNoBoltResult(page: Page): Promise<void> {
  await expect(page.getByTestId('beam-axial-bolt-results')).toHaveCount(0);
}

async function selectEnd(select: Locator, nodeId: string): Promise<void> {
  const option = select.locator('option', { hasText: new RegExp(`/ ${nodeId}$`, 'u') });
  await expect(option).toHaveCount(1);
  const value = await option.getAttribute('value');
  if (value === null) throw new Error(`Rendered endpoint option without value: ${nodeId}`);
  await select.selectOption({ value });
  await expect(select.locator('option:checked')).toHaveText(new RegExp(`/ ${nodeId}$`, 'u'));
}

/** Adds the row; before its inputs exist the review is refused (an alert, no run). Then every control is typed. */
async function authorBolt(page: Page): Promise<string> {
  await expect(boltRows(page)).toHaveCount(0);
  await definitions(page).getByRole('button', { name: '軸部の結合を追加', exact: true }).click();
  await expect(boltRows(page)).toHaveCount(1);
  const id = await boltRows(page).first().getAttribute('data-axial-bolt');
  if (id === null || id.length === 0) throw new Error('Rendered bolt row without its id');
  // Incomplete input: the notice is shown and nothing can run. No claim that every alert is absent yet.
  await panel(page).getByTestId('beam-review').click();
  await expect(panel(page).getByRole('alert')).not.toHaveCount(0);
  await expect(panel(page).getByTestId('beam-run')).toBeDisabled();
  await control(page, '配置済みボルト', 'select').selectOption({ value: 'bolt' });
  await selectEnd(control(page, '第1部材の端点', 'select'), 'a-tip');
  await selectEnd(control(page, '第2部材の端点', 'select'), 'b-base');
  await control(page, 'ヤング率', 'input').fill(String(FIRST_YOUNG_MPA));
  await control(page, '有効断面積', 'input').fill(String(BOLT_AREA_MM2));
  await control(page, '材料・断面値の根拠', 'input').fill(REFERENCE);
  await control(page, '適用条件', 'input').fill(CONDITION);
  return id;
}

/** All required controls are filled: review raises no alert and enables the run. */
async function expectCompleteReview(page: Page): Promise<void> {
  await panel(page).getByTestId('beam-review').click();
  await expect(panel(page).getByTestId('beam-run')).toBeEnabled();
  await expect(status(page)).toHaveAttribute('data-status', 'editing');
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
}

interface NodeMotion { readonly displacementM: readonly number[]; readonly rotationRad: readonly number[] }
interface BoltState {
  readonly factor: number; readonly id: string; readonly forceN: number; readonly extensionM: number;
  readonly contactState: string | null; readonly reactionN: number; readonly gapM: number;
  readonly nodes: readonly NodeMotion[];
}

async function values(locator: Locator): Promise<number[]> {
  return locator.evaluateAll(cells => cells.map(cell => Number(cell.getAttribute('data-value') ?? 'NaN')));
}

async function readState(page: Page, index: number): Promise<BoltState> {
  const result = panel(page).getByTestId('beam-axial-bolt-results');
  await expect(result).toBeVisible({ timeout: RESULT_TIMEOUT_MS });
  const select = result.locator('select');
  await expect(select.locator('option')).toHaveCount(LOAD_FACTORS.length);
  await select.selectOption({ value: String(index) });
  await expect(select).toHaveValue(String(index));
  const tables = result.locator('table');
  await expect(tables).toHaveCount(3);
  const bolt = tables.nth(0).locator('tbody tr');
  await expect(bolt).toHaveCount(1);
  const [forceN] = await values(bolt.locator('td[data-unit="N"]'));
  const [extensionM] = await values(bolt.locator('td[data-unit="m"]'));
  const contact = tables.nth(1).locator('tbody tr');
  await expect(contact).toHaveCount(1);
  await expect(contact.locator('th')).toHaveText('stop');
  const [reactionN, gapM] = await values(contact.locator('td'));
  const displacementRows = tables.nth(2).locator('tbody tr').filter({ has: page.locator('td[data-unit="m"]') });
  // segmentsPerMember = 1 (restored from the fixture): two members, four end nodes, no internal node.
  await expect(displacementRows).toHaveCount(4);
  const nodes: NodeMotion[] = [];
  for (let at = 0; at < 4; at++) {
    const number = (await displacementRows.nth(at).locator('th').innerText()).trim();
    const displacementM = await values(displacementRows.nth(at).locator('td[data-unit="m"]'));
    const rotationRad = await values(tables.nth(2).locator('tbody tr').filter({ has: page.locator('td[data-unit="rad"]') })
      .filter({ has: page.locator('th', { hasText: new RegExp(`^${number}$`, 'u') }) }).locator('td[data-unit="rad"]'));
    expect(displacementM).toHaveLength(3); expect(rotationRad).toHaveLength(3);
    nodes.push({ displacementM, rotationRad });
  }
  return { factor: LOAD_FACTORS[index], id: (await bolt.locator('th').innerText()).trim(), forceN, extensionM,
    contactState: await contact.getAttribute('data-state'), reactionN, gapM, nodes };
}

function near(actual: number, expected: number, scale = Math.abs(expected)): void {
  expect(Number.isFinite(actual)).toBe(true);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(RELATIVE * Math.max(scale, Number.MIN_VALUE));
}

/** Independent closed form for the typed bolt modulus; see the header comment for the derivation. */
function checkPhysics(states: readonly BoltState[], boltId: string, youngMPa: number): void {
  const ka = MEMBER_STIFFNESS_N_PER_M, kb = youngMPa * 1e6 * BOLT_AREA_MM2 * 1e-6 / BOLT_LENGTH_M;
  const u1 = FORCE_N * (ka + kb) / (ka * (ka + 2 * kb)), u2 = FORCE_N * kb / (ka * (ka + 2 * kb));
  expect(states.map(s => s.factor)).toEqual([...LOAD_FACTORS]);
  for (const state of states) {
    const f = state.factor, force = f * FORCE_N;
    expect(state.id).toBe(boltId);
    // Bolt elongation/force relation: N = (E A / L) * extension, and the closed-form extension.
    near(state.extensionM, -force / (ka + 2 * kb));
    near(state.forceN, kb * state.extensionM);
    near(state.forceN, -force * kb / (ka + 2 * kb));
    expect(Math.sign(state.forceN)).toBe(-Math.sign(f));
    // Nodes: the two clamped ends stay at rest, a-tip moves u1 and b-base u2 along z; no lateral motion or rotation.
    const byZ = [...state.nodes].sort((p, q) => Math.abs(q.displacementM[2]) - Math.abs(p.displacementM[2]));
    const tipZ = byZ[0].displacementM[2], baseZ = byZ[1].displacementM[2];
    near(tipZ, f * u1); near(baseZ, f * u2);
    for (const node of byZ.slice(2)) node.displacementM.forEach(v => { expect(Math.abs(v)).toBeLessThanOrEqual(RELATIVE * u1); });
    for (const node of state.nodes) {
      expect(Math.abs(node.displacementM[0])).toBeLessThanOrEqual(RELATIVE * u1);
      expect(Math.abs(node.displacementM[1])).toBeLessThanOrEqual(RELATIVE * u1);
      node.rotationRad.forEach(v => { expect(Math.abs(v)).toBeLessThanOrEqual(RELATIVE * u1 / BOLT_LENGTH_M); });
    }
    // Displayed extension is the displayed endpoint motion difference (B minus A along +z).
    near(state.extensionM, baseZ - tipZ, Math.abs(tipZ));
    // Force equilibrium of the two connected nodes with the independent member stiffness.
    near(force + state.forceN - ka * tipZ, 0, FORCE_N);
    near(-state.forceN - ka * baseZ, 0, FORCE_N);
    // Open stop: no reaction, gap = authored gap + n . u(b-base).
    expect(state.contactState).toBe('open');
    near(state.reactionN, 0, FORCE_N);
    near(state.gapM, STOP_GAP_M + baseZ, STOP_GAP_M);
  }
  // Linear response: the reversed load reverses every value.
  const [positive, negative] = states;
  near(negative.forceN, -positive.forceN); near(negative.extensionM, -positive.extensionM);
}

async function runComplete(page: Page, boltId: string, youngMPa: number): Promise<readonly BoltState[]> {
  await expectCompleteReview(page);
  await panel(page).getByTestId('beam-run').click();
  await expect.poll(async () => status(page).getAttribute('data-status'), { timeout: RESULT_TIMEOUT_MS })
    .toMatch(/^(complete|failed|cancelled)$/u);
  await expect(status(page)).toHaveAttribute('data-status', 'complete');
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
  const states: BoltState[] = [];
  for (let index = 0; index < LOAD_FACTORS.length; index++) states.push(await readState(page, index));
  checkPhysics(states, boltId, youngMPa);
  return states;
}

async function savedBoltInputs(path: string): Promise<CadAxialBoltInputs> {
  const read = await readDocumentBundle(await readFile(path), 'assembly');
  if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('Actual saved assembly did not decode');
  const analyses = read.bundle.document.beamAnalysisInputs?.analyses ?? [];
  expect(analyses).toHaveLength(1);
  const analysis = analyses[0];
  if (analysis?.kind !== 'standard-members' || analysis.definition.schema !== 'pointercad-standard-beam/5'
    || analysis.definition.axialBolts === undefined) throw new Error('Actual saved axial bolt input missing');
  expect(analysis.definition.contact.loadFactors).toEqual([...LOAD_FACTORS]);
  expect(analysis.definition.weldLayers).toBeUndefined();
  // Inputs only: no solver result, derived world endpoint or response quantity is saved.
  expect(JSON.stringify(analysis.definition)).not.toMatch(/"(?:result|states|axialForceN|extensionM|displacementM|positionM)"/u);
  return analysis.definition.axialBolts;
}

async function expectRestoredRow(page: Page, boltId: string, youngMPa: number): Promise<void> {
  await expect(boltRows(page)).toHaveCount(1);
  await expect(boltRows(page).first()).toHaveAttribute('data-axial-bolt', boltId);
  await expect(control(page, '配置済みボルト', 'select')).toHaveValue('bolt');
  await expect(control(page, '第1部材の端点', 'select').locator('option:checked')).toHaveText(/\/ a-tip$/u);
  await expect(control(page, '第2部材の端点', 'select').locator('option:checked')).toHaveText(/\/ b-base$/u);
  await expect(control(page, 'ヤング率', 'input')).toHaveValue(String(youngMPa));
  await expect(control(page, '有効断面積', 'input')).toHaveValue(String(BOLT_AREA_MM2));
  await expect(control(page, '材料・断面値の根拠', 'input')).toHaveValue(REFERENCE);
  await expect(control(page, '適用条件', 'input')).toHaveValue(CONDITION);
}

export async function analysisBoltPersistenceFlow(page: Page, info: TestInfo,
  installHold: () => Promise<AssetHold>, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [], observations: unknown[] = [];
  const pageError = (error: Error): void => { errors.push(error.message); };
  page.on('pageerror', pageError);
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const workers = trackFemWorkers(page);
  try {
    const f = await fixture(), input = info.outputPath('bolt-input.pcada');
    await writeFile(input, f.bytes);
    await openSaveFlowFile(page, input, app);
    await expect(componentRows(page)).toHaveCount(f.componentCount);
    await openWeldSpanPanel(page);
    await expect(panel(page).getByTestId('beam-segments')).toHaveValue('1');
    await confirmWeldSpanMembers(page);
    const boltId = await authorBolt(page);
    await expectCompleteReview(page);
    const base = workers.started();
    expect(workers.closed()).toBe(base);

    // Stop during a run that cannot finish while its first real FEM asset request is held.
    const hold = await installHold();
    try {
      await panel(page).getByTestId('beam-run').click();
      await expect.poll(() => hold.held(), { timeout: KERNEL_TIMEOUT_MS,
        message: 'the hold must keep the bolt run FEM worker asset request' }).toMatch(FEM_ASSET);
      await expect.poll(() => workers.started(), { timeout: KERNEL_TIMEOUT_MS }).toBe(base + 1);
      expect(workers.closed()).toBe(base);
      await expect(status(page)).toHaveAttribute('data-status', 'running');
      await expectNoBoltResult(page);
      await expect(panel(page).getByTestId('beam-cancel')).toBeEnabled();
      await panel(page).getByTestId('beam-cancel').click();
      await expect(status(page)).toHaveAttribute('data-status', 'cancelled');
      await expectFemQuiet(workers);
      expect(await hold.holding()).toBe(true);
      await expectNoBoltResult(page);
      observations.push(`held-bolt-fem-asset ${await hold.release()}`);
    } finally {
      await hold.dispose();
    }
    expect(workers.started()).toBe(base + 1);
    await expect(status(page)).toHaveAttribute('data-status', 'cancelled');
    await expectNoBoltResult(page);

    // A real run of the typed input after the stop satisfies the independent closed form.
    observations.push({ phase: 'after-stop', states: await runComplete(page, boltId, FIRST_YOUNG_MPA) });
    expect(workers.started()).toBeGreaterThan(base + 1);
    await expectFemQuiet(workers);

    // Condition change after a complete result: the result and the review are discarded at once.
    await control(page, 'ヤング率', 'input').fill(String(CHANGED_YOUNG_MPA));
    await expectNoBoltResult(page);
    await expect(status(page)).toHaveAttribute('data-status', 'editing');
    await expect(panel(page).getByTestId('beam-run')).toBeDisabled();
    await expectFemQuiet(workers);
    // The changed input is reviewed and saved without a duplicate solve; its result is checked after reopening.
    const beforeChangedSave = workers.started();
    await expectCompleteReview(page);
    await expectNoBoltResult(page);

    // The typed inputs (not solver values) are what is saved.
    await panel(page).getByTestId('beam-apply').click();
    await waitForSettledRecompute(page);
    await expectNoBoltResult(page);
    expect(workers.started()).toBe(beforeChangedSave);
    const saved = info.outputPath('bolt-changed.pcada');
    await saveFlowFile(page, saved, app);
    const inputs = await savedBoltInputs(saved);
    expect(inputs.bolts).toEqual([{ id: boltId, boltComponentId: 'bolt', expectedPartKey: f.boltPartKey,
      expectedMaterialId: null, first: { memberId: 'a-beam', nodeId: 'a-tip' }, second: { memberId: 'b-beam', nodeId: 'b-base' },
      youngMPa: CHANGED_YOUNG_MPA, effectiveAreaMm2: BOLT_AREA_MM2,
      propertySource: { kind: 'user-supplied', reference: REFERENCE, condition: CONDITION },
      idealization: 'bilateral-uniform-axial-elastic' }]);

    // Reopen: no stale result anywhere, the same inputs come back, and nothing runs before a new review.
    await openSaveFlowFile(page, saved, app);
    await expectNoBoltResult(page);
    await openWeldSpanPanel(page);
    await expectRestoredRow(page, boltId, CHANGED_YOUNG_MPA);
    await expectNoBoltResult(page);
    await expect(panel(page).getByTestId('beam-run')).toBeDisabled();
    await expectFemQuiet(workers);
    await confirmWeldSpanMembers(page);
    const beforeReopenRun = workers.started();
    observations.push({ phase: 'reopened', states: await runComplete(page, boltId, CHANGED_YOUNG_MPA) });
    expect(workers.started()).toBeGreaterThan(beforeReopenRun);
    await expectFemQuiet(workers);
    expect(errors).toEqual([]);
  } finally {
    try {
      await info.attach('bolt-observations', { contentType: 'application/json',
        body: JSON.stringify({ observations, errors, started: workers.started(), closed: workers.closed() }, null, 2) });
    } finally {
      await resetAssemblyFileGateway(page);
      page.off('pageerror', pageError);
    }
  }
}
