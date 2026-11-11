/// <reference lib="dom" />
import { readFile, writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readDocumentBundle, writeDocumentBundle } from '../../packages/io/src/index.js';
import { createAssemblyDocumentBundle, EMPTY_PART_LIBRARY } from '../../packages/model/src/index.js';
import { cadWeldSpanFixture } from '../../packages/model/src/analysis/cadWeldSpanLayer.testSupport.js';
import type { CadWeldSpanInputs } from '../../packages/model/src/analysis/weldSpanInput.js';
import { chooseToolMenuItem, resetAssemblyFileGateway } from './assemblyTestSupport.js';
import { componentRows } from './boltedJointTestSupport.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { waitForSettledRecompute } from './recompute.js';

export type WeldSpanAuthorCase = 'span-span' | 'section-span' | 'irregular-group';
const RESULT_TIMEOUT_MS = 120_000;
const RELATIVE = 1e-9;
const FORCE_MOMENT_ABSOLUTE = 1e-8;
const ZERO_ABSOLUTE = 1e-12;
const REFERENCE = 'Independent actual CAD span author acceptance';
const CONDITION = 'Linear isotropic elastic layer, no structural certification';

function panel(page: Page): Locator { return page.getByTestId('beam-panel'); }
function rows(page: Page): Locator { return page.locator('fieldset[data-weld-span-definition]'); }
function field(page: Page, name: string): Locator { return rows(page).first().locator(`[data-span-field="${name}"]`); }

async function fixture(mode: WeldSpanAuthorCase) {
  const cad = cadWeldSpanFixture(mode === 'section-span', mode === 'irregular-group'
    ? [{ start: 2, length: 3 }, { start: 10, length: 5 }] : undefined);
  const { weldLayers, ...definition } = cad.definition;
  expect(weldLayers?.schema).toBe('pointercad-cad-weld-layers/2');
  // Author the associations through controls. Only existing member/support/load inputs are prefilled.
  const document = { ...cad.document, beamAnalysisInputs: { schema: 'pointercad-beam-inputs/1' as const,
    analyses: [{ kind: 'standard-members' as const, definition }] } };
  return { bytes: await writeDocumentBundle(createAssemblyDocumentBundle(document, EMPTY_PART_LIBRARY)),
    beads: cad.associations.welds.map(w => w.beadComponentId), componentCount: document.components.length };
}

async function openPanel(page: Page): Promise<void> {
  if (await panel(page).count() > 0) {
    await panel(page).getByTestId('beam-close').click();
    await expect(panel(page)).toHaveCount(0);
  }
  if (await page.getByTestId('beam-open').count() === 0) await chooseToolMenuItem(page, '見た目', '簡易強度計算');
  await page.getByTestId('beam-open').click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByTestId('beam-analysis-type')).toHaveValue('contact');
}

async function confirmMembers(page: Page): Promise<void> {
  const members = panel(page).locator('input[data-beam-confirm]');
  await expect(members).toHaveCount(2);
  for (let at = 0; at < 2; at++) await members.nth(at).check();
}

async function author(page: Page, mode: WeldSpanAuthorCase, beads: readonly string[]): Promise<void> {
  await expect(rows(page)).toHaveCount(0);
  await panel(page).getByTestId('beam-weld-span-add').click();
  await expect(rows(page)).toHaveCount(1);
  await field(page, 'bead').selectOption({ value: beads[0] });
  await expect(rows(page)).toHaveCount(beads.length);
  for (const side of ['first', 'second'] as const) {
    const group = rows(page).first().locator(`[data-span-side="${side}"]`);
    const kind = mode === 'section-span' && side === 'first' ? 'section-node' : 'member-span';
    await group.locator('[data-span-field="kind"]').selectOption({ value: kind });
    await group.locator('[data-span-field="member"]').selectOption({ value: side === 'first' ? 'a-beam' : 'b-beam' });
    if (kind === 'section-node') await group.locator('[data-span-field="node"]').selectOption({ value: 'a-base' });
    else await expect(group.locator('[data-span-field="node"]')).toHaveCount(0);
  }
  for (const [name, value] of [['youngMPa', '1000'], ['poisson', '.25'], ['effectiveThroatMm', '2'],
    ['complianceLengthMm', '1'], ['reference', REFERENCE], ['condition', CONDITION]]) await field(page, name).fill(value);
}

interface NodalAction { readonly side: string; readonly node: number; readonly values: readonly number[] }
interface MeshMotion { readonly node: number; readonly values: readonly number[] }
interface PatchState {
  readonly id: string; readonly force: readonly number[]; readonly moment: readonly number[];
  readonly energy: number; readonly nodal: readonly NodalAction[];
}
interface SpanState { readonly factor: number; readonly patches: readonly PatchState[]; readonly mesh: readonly MeshMotion[];
  readonly stress: readonly StressPatch[] }

interface StressPoint { readonly positionM: readonly number[]; readonly tractionPa: readonly number[] }
interface StressPatch { readonly id: string; readonly points: readonly StressPoint[] }

/** Independent display precision bound: the published UI uses nine significant decimal digits. */
async function expectDisplayedSI(cell: Locator, unit: string, multiplier: number): Promise<number> {
  await expect(cell).toHaveAttribute('data-unit', unit);
  const value = Number(await cell.getAttribute('data-value') ?? 'NaN');
  const displayed = Number(await cell.innerText());
  expect(Number.isFinite(value)).toBe(true); expect(Number.isFinite(displayed)).toBe(true);
  const expected = value * multiplier;
  const quantum = expected === 0 ? 0 : .5 * 10 ** (Math.floor(Math.log10(Math.abs(expected))) - 8);
  expect(Math.abs(displayed - expected)).toBeLessThanOrEqual(quantum + Number.EPSILON * Math.abs(expected));
  return value;
}

async function readStress(page: Page, factor: number, ids: readonly string[]): Promise<readonly StressPatch[]> {
  const stress = panel(page).getByTestId('beam-weld-span-stress');
  await expect(stress).toBeVisible({ timeout: RESULT_TIMEOUT_MS });
  await expect(stress).toHaveAttribute('data-load-factor', String(factor));
  await expect(stress).toHaveAttribute('data-structural-certification', 'false');
  await expect(stress.getByRole('heading', { name: '積分点の応力', exact: true })).toBeVisible();
  const groups = stress.locator('details[data-weld-span]');
  await expect(groups).toHaveCount(ids.length);
  const patches: StressPatch[] = [];
  for (let at = 0; at < ids.length; at++) {
    const details = groups.nth(at);
    await expect(details).toHaveAttribute('data-weld-span', ids[at]);
    // Use the actual native keyboard control, never inspect a collapsed table as if it were visible.
    if (await details.getAttribute('open') === null) {
      await details.locator('summary').focus(); await details.locator('summary').press('Enter');
    }
    await expect(details).toHaveAttribute('open', '');
    const points = details.locator('tr[data-point]'), count = await points.count();
    expect(count).toBeGreaterThan(0); expect(count % 8).toBe(0); // Existing 4x2 Gauss cells, no endpoint substitution.
    const observed: StressPoint[] = [];
    for (let i = 0; i < count; i++) {
      const row = points.nth(i);
      await expect(row).toBeVisible(); await expect(row).toHaveAttribute('data-point', String(i));
      await expect(row).toHaveAttribute('data-load-factor', String(factor));
      const coordinates = row.locator('td[data-coordinate]'), stresses = row.locator('td[data-stress]');
      await expect(coordinates).toHaveCount(3); await expect(stresses).toHaveCount(3);
      const positionM: number[] = [], tractionPa: number[] = [];
      for (let axis = 0; axis < 3; axis++) {
        await expect(coordinates.nth(axis)).toHaveAttribute('data-coordinate', String(axis));
        positionM.push(await expectDisplayedSI(coordinates.nth(axis), 'm', 1000));
      }
      for (const quantity of ['normalPa', 'shearAlongPa', 'shearAcrossPa']) {
        tractionPa.push(await expectDisplayedSI(row.locator(`td[data-stress="${quantity}"]`), 'Pa', 1e-6));
      }
      observed.push({ positionM, tractionPa });
    }
    patches.push({ id: ids[at], points: observed });
  }
  return patches;
}

/** Homogeneous linear elasticity: no preload, so the zero-load traction vanishes and reversing load reverses it. */
function checkStress(states: readonly SpanState[]): void {
  expect(states.map(s => s.factor)).toEqual([1, 0, -1]);
  expect(Math.max(...states[0].stress.flatMap(w => w.points.flatMap(p => p.tractionPa.map(Math.abs))))).toBeGreaterThan(0);
  for (let at = 0; at < states[0].stress.length; at++) {
    const [positive, zero, negative] = states.map(s => s.stress[at]);
    expect(zero.id).toBe(positive.id); expect(negative.id).toBe(positive.id);
    expect(zero.points).toHaveLength(positive.points.length); expect(negative.points).toHaveLength(positive.points.length);
    positive.points.forEach((point, i) => {
      expect(zero.points[i].positionM).toEqual(point.positionM);
      expect(negative.points[i].positionM).toEqual(point.positionM);
      point.tractionPa.forEach((value, axis) => {
        expect(Math.abs(zero.points[i].tractionPa[axis])).toBeLessThanOrEqual(ZERO_ABSOLUTE);
        expect(Math.abs(negative.points[i].tractionPa[axis] + value))
          .toBeLessThanOrEqual(RELATIVE * Math.max(Math.abs(value), ZERO_ABSOLUTE));
      });
    });
  }
}



async function numbers(locator: Locator): Promise<number[]> {
  return locator.evaluateAll(cells => cells.map(cell => Number(cell.getAttribute('data-value') ?? 'NaN')));
}

async function readState(page: Page, factor: number, beadCount: number): Promise<SpanState> {
  const result = panel(page).getByTestId('beam-weld-span-results');
  await expect(result).toHaveAttribute('data-load-factor', String(factor));
  await expect(result).toHaveAttribute('data-structural-certification', 'false');
  await expect(result.getByTestId('beam-contact-table').locator('tr[data-state="open"]')).toHaveCount(1);
  const wrenches = result.getByTestId('beam-weld-span-wrenches');
  const ids = await wrenches.locator('tr[data-quantity="forceOnFirstN"]').evaluateAll(nodes => nodes.map(node => {
    const id = node.getAttribute('data-weld-span');
    if (id === null) throw new Error('Missing actual span id');
    return id;
  }));
  expect(ids).toHaveLength(beadCount);
  const mesh: MeshMotion[] = [];
  const displacements = result.getByTestId('beam-weld-span-mesh').locator('tr[data-quantity="displacement"]');
  await expect(displacements).toHaveCount(6); // Two members, two elements each: four authored ends and two real internal nodes.
  for (let i = 0; i < 6; i++) {
    const number = Number(await displacements.nth(i).getAttribute('data-node'));
    expect(number).toBe(i + 1);
    const u = await numbers(displacements.nth(i).locator('td[data-unit="m"]'));
    const r = await numbers(result.getByTestId('beam-weld-span-mesh')
      .locator(`tr[data-node="${number}"][data-quantity="rotation"] td[data-unit="rad"]`));
    expect(u).toHaveLength(3); expect(r).toHaveLength(3);
    mesh.push({ node: number, values: [...u, ...r] });
  }
  const patches: PatchState[] = [];
  for (const id of ids) {
    // IDs come from the rendered controls; no CSS interpolation of arbitrary document data.
    const at = ids.indexOf(id);
    const force = await numbers(wrenches.locator('tr[data-quantity="forceOnFirstN"]').nth(at).locator('td[data-unit="N"]'));
    const moment = await numbers(wrenches.locator('tr[data-quantity="momentAtCenterNm"]').nth(at).locator('td[data-unit="N m"]'));
    const energyValues = await numbers(wrenches.locator('tr[data-quantity="energyJ"]').nth(at).locator('td[data-unit="J"]'));
    expect(force).toHaveLength(3); expect(moment).toHaveLength(3); expect(energyValues).toHaveLength(1);
    const nodal: NodalAction[] = [];
    const allNodal = result.getByTestId('beam-weld-span-nodal-loads').locator('tr[data-weld-span]');
    for (let i = 0; i < await allNodal.count(); i++) {
      const row = allNodal.nth(i);
      if (await row.getAttribute('data-weld-span') !== id) continue;
      const side = await row.getAttribute('data-side');
      expect(['first', 'second']).toContain(side);
      const values = await numbers(row.locator('td[data-component]'));
      expect(values).toHaveLength(6);
      expect(await row.locator('td[data-unit="N"]').count()).toBe(3);
      expect(await row.locator('td[data-unit="N m"]').count()).toBe(3);
      nodal.push({ side: side ?? '', node: Number(await row.getAttribute('data-node')), values });
    }
    expect(nodal).toHaveLength(12);
    patches.push({ id, force, moment, energy: energyValues[0], nodal });
  }
  const all = [...mesh.flatMap(m => m.values), ...patches.flatMap(p => [...p.force, ...p.moment, p.energy, ...p.nodal.flatMap(n => n.values)])];
  expect(all.length).toBeGreaterThan(0); expect(all.every(Number.isFinite)).toBe(true);
  const stress = await readStress(page, factor, ids);
  return { factor, patches, mesh, stress };
}

function checkPhysics(states: readonly SpanState[]): void {
  expect(states.map(s => s.factor)).toEqual([1, 0, -1]);
  expect(Math.max(...states[0].patches.flatMap(p => p.force.map(Math.abs)))).toBeGreaterThan(0);
  expect(states[0].patches.reduce((sum, p) => sum + p.energy, 0)).toBeGreaterThan(0);
  for (const state of states) for (const patch of state.patches) {
    let work = 0, workScale = 0;
    for (const action of patch.nodal) {
      const motion = state.mesh.find(m => m.node === action.node);
      if (motion === undefined) throw new Error('Nodal force has no actual mesh motion');
      for (let axis = 0; axis < 6; axis++) {
        const term = action.values[axis] * motion.values[axis]; work += term; workScale += Math.abs(term);
      }
    }
    // Physical forces act on the two members: their work is -2U for a linear elastic layer, including rotation work.
    expect(Math.abs(work + 2 * patch.energy)).toBeLessThanOrEqual(RELATIVE * Math.max(workScale, 2 * patch.energy, Number.MIN_VALUE));
    for (let axis = 0; axis < 3; axis++) {
      const first = patch.nodal.filter(n => n.side === 'first').reduce((sum, n) => sum + n.values[axis], 0);
      const second = patch.nodal.filter(n => n.side === 'second').reduce((sum, n) => sum + n.values[axis], 0);
      expect(Math.abs(first + second)).toBeLessThanOrEqual(FORCE_MOMENT_ABSOLUTE);
      expect(Math.abs(first - patch.force[axis])).toBeLessThanOrEqual(FORCE_MOMENT_ABSOLUTE);
    }
  }
  for (let at = 0; at < states[0].patches.length; at++) {
    const [positive, zero, negative] = states.map(s => s.patches[at]);
    const signed = (p: PatchState): readonly number[] => [...p.force, ...p.moment, ...p.nodal.flatMap(n => n.values)];
    signed(positive).forEach((v, i) => {
      expect(Math.abs(signed(negative)[i] + v)).toBeLessThanOrEqual(FORCE_MOMENT_ABSOLUTE);
      expect(Math.abs(signed(zero)[i])).toBeLessThanOrEqual(ZERO_ABSOLUTE);
    });
    expect(zero.energy).toBeLessThanOrEqual(ZERO_ABSOLUTE);
    expect(Math.abs(positive.energy - negative.energy)).toBeLessThanOrEqual(RELATIVE * positive.energy);
  }
  states[0].mesh.forEach((m, i) => m.values.forEach((v, axis) => {
    expect(Math.abs(states[1].mesh[i].values[axis])).toBeLessThanOrEqual(ZERO_ABSOLUTE);
    expect(Math.abs(states[2].mesh[i].values[axis] + v)).toBeLessThanOrEqual(RELATIVE * Math.max(Math.abs(v), ZERO_ABSOLUTE));
  }));
}

/** Refresh the physical identity before checking whether the authored rows are blocked. */
export async function reviewWeldSpanInput(page: Page): Promise<void> {
  await panel(page).getByTestId('beam-review').click();
  await expect(panel(page).getByTestId('beam-weld-span-blocked')).toHaveCount(0);
  await expect(panel(page).getByTestId('beam-run')).toBeEnabled();
}

async function run(page: Page, beadCount: number): Promise<readonly SpanState[]> {
  await reviewWeldSpanInput(page);
  await panel(page).getByTestId('beam-run').click();
  await expect.poll(async () => panel(page).getByTestId('beam-status').getAttribute('data-status'),
    { timeout: RESULT_TIMEOUT_MS }).toMatch(/^(complete|failed|cancelled)$/u);
  await expect(panel(page).getByTestId('beam-status')).toHaveAttribute('data-status', 'complete');
  await expect(panel(page).getByTestId('beam-weld-span-results')).toBeVisible({ timeout: RESULT_TIMEOUT_MS });
  const states: SpanState[] = [];
  for (const [index, factor] of [1, 0, -1].entries()) {
    const select = panel(page).getByTestId('beam-contact-state');
    await select.selectOption({ value: String(index) });
    await expect(select).toHaveValue(String(index));
    states.push(await readState(page, factor, beadCount));
  }
  checkPhysics(states);
  checkStress(states);
  return states;
}

async function savedInputs(path: string): Promise<CadWeldSpanInputs> {
  const read = await readDocumentBundle(await readFile(path), 'assembly');
  if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('Actual saved assembly did not decode');
  const analysis = read.bundle.document.beamAnalysisInputs?.analyses[0];
  if (analysis?.kind !== 'standard-members' || analysis.definition.schema !== 'pointercad-standard-beam/5'
    || analysis.definition.weldLayers?.schema !== 'pointercad-cad-weld-layers/2') throw new Error('Actual saved span input missing');
  expect(analysis.definition.contact.loadFactors).toEqual([1, 0, -1]);
  return analysis.definition.weldLayers;
}

// Reused unchanged by analysisConnectionsPersistenceFlow.ts (same fixture, controls and independent oracles).
export {
  author as authorWeldSpan, confirmMembers as confirmWeldSpanMembers, field as weldSpanField, fixture as weldSpanFixture,
  openPanel as openWeldSpanPanel, panel as weldSpanPanel, rows as weldSpanRows, run as runWeldSpan,
  savedInputs as savedWeldSpanInputs,
};

export async function weldSpanAuthorFlow(page: Page, info: TestInfo, mode: WeldSpanAuthorCase,
  app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [], observations: { phase: string; states: readonly SpanState[] }[] = [];
  const pageError = (error: Error): void => { errors.push(error.message); };
  page.on('pageerror', pageError);
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    const f = await fixture(mode), input = info.outputPath('span-author-input.pcada');
    await writeFile(input, f.bytes);
    await openSaveFlowFile(page, input, app);
    await expect(componentRows(page)).toHaveCount(f.componentCount);
    await openPanel(page); await confirmMembers(page); await author(page, mode, f.beads);
    observations.push({ phase: 'authored', states: await run(page, f.beads.length) });
    await panel(page).getByTestId('beam-apply').click();
    await waitForSettledRecompute(page);
    const saved = info.outputPath('span-author-saved.pcada');
    await saveFlowFile(page, saved, app);
    const before = await savedInputs(saved);
    expect(before.welds.map(w => w.beadComponentId)).toEqual(f.beads);
    for (const weld of before.welds) {
      expect(weld).toMatchObject({ youngMPa: 1000, poisson: .25, effectiveThroatMm: 2, complianceLengthMm: 1,
        propertySource: { kind: 'user-supplied', reference: REFERENCE, condition: CONDITION } });
      expect(weld.first).toEqual(mode === 'section-span' ? { kind: 'section-node', memberId: 'a-beam', nodeId: 'a-base' }
        : { kind: 'member-span', memberId: 'a-beam' });
      expect(weld.second).toEqual({ kind: 'member-span', memberId: 'b-beam' });
    }
    await openSaveFlowFile(page, saved, app);
    await expect(page.getByTestId('beam-weld-span-results')).toHaveCount(0);
    await expect(page.getByTestId('beam-weld-span-stress')).toHaveCount(0);
    await openPanel(page);
    await expect(rows(page)).toHaveCount(f.beads.length);
    await expect(panel(page).getByTestId('beam-weld-span-results')).toHaveCount(0);
    await expect(panel(page).getByTestId('beam-weld-span-stress')).toHaveCount(0);
    await expect(panel(page).getByTestId('beam-run')).toBeDisabled();
    await confirmMembers(page);
    // Requires the separately reviewed reopen fix: explicit review validates current physical identities; no silent rebind.
    observations.push({ phase: 'explicit-reopen-review', states: await run(page, f.beads.length) });
    await panel(page).getByTestId('beam-apply').click(); await waitForSettledRecompute(page);
    const resaved = info.outputPath('span-author-reopened.pcada');
    await saveFlowFile(page, resaved, app);
    const after = await savedInputs(resaved);
    expect(after.welds).toEqual(before.welds);
    expect(after.analysisId).toBe(before.analysisId);
    expect(after.source.documentId).toBe(before.source.documentId);
    expect(after.analysisRevision).toBeGreaterThanOrEqual(before.analysisRevision);
    expect(errors).toEqual([]);
  } finally {
    const raw = info.outputPath('span-author-observations.json');
    try {
      // Preserve the actual DOM values even if a new stress assertion fails before a state is appended.
      const stressAtExit = await page.getByTestId('beam-weld-span-stress').evaluateAll(elements => elements.map(element => ({
        factor: element.getAttribute('data-load-factor'),
        beads: Array.from(element.querySelectorAll('details[data-weld-span]'), detail => ({
          id: detail.getAttribute('data-weld-span'), open: detail.hasAttribute('open'),
          cells: Array.from(detail.querySelectorAll('td[data-value]'), cell => ({
            unit: cell.getAttribute('data-unit'), value: cell.getAttribute('data-value'), text: cell.textContent,
            quantity: cell.getAttribute('data-stress'), coordinate: cell.getAttribute('data-coordinate'),
          })),
        })),
      }))).catch((error: unknown) => ({ readFailure: error instanceof Error ? error.message : String(error) }));
      await writeFile(raw, JSON.stringify({ mode, collector: 'actual-ui-native-span-result', observations, stressAtExit, errors }, null, 2));
      await info.attach('span-author-observations', { path: raw, contentType: 'application/json' });
    } finally {
      await resetAssemblyFileGateway(page);
      page.off('pageerror', pageError);
    }
  }
}
