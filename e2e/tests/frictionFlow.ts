/// <reference lib="dom" />
import { readFile, writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { readDocumentBundle, writeDocumentBundle } from '../../packages/io/src/index.js';
import {
  addComponent, createAssemblyDocument, createAssemblyDocumentBundle, createComponentFor, EMPTY_PART_LIBRARY,
} from '../../packages/model/src/index.js';
import type { StandardBeamFrictionDefinition } from '../../packages/model/src/analysis/beamInputs.js';
import { testComponent, testMember, testPlacement, TEST_EVIDENCE } from '../../packages/model/src/analysis/beamInputs.testSupport.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { componentRows } from './boltedJointTestSupport.js';
import { waitForSettledRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';

const RESULT_TIMEOUT_MS = 120_000;
const CONTACT_ID = 'tip-plane';
const LOAD_ID = 'tip-load';
const FORCES = [[2, -10, 0], [5, -10, 0], [0, 0, 0], [-5, -10, 0]] as const;

/** Real saved CAD, using impactFlow's standard bar and document writer. No model or result injection.
 * The solver's plane normal points into the admissible half-space: gap = gap0 + n.u.
 * This matches fixtures/friction-native/input.json; negative Y loading closes a positive Y normal.
 * Independent Coulomb values: normal [10,10,0,10] N; friction X [-2,-3,0,3] N.
 * Those constants come from the loads and mu, never from newton-raw.json or a solver run here.
 */
export async function cantileverWithFrictionInputs(): Promise<{
  readonly bytes: Uint8Array; readonly definition: StandardBeamFrictionDefinition;
}> {
  let document = createAssemblyDocument('摩擦');
  const bar = createComponentFor(document, testComponent('a', '2000').source,
    { name: 'a', placement: testPlacement([0, 0, 0]) });
  document = addComponent(document, bar);
  const saved = document.components.find(component => component.id === bar.id);
  if (saved === undefined) throw new Error('friction bar missing');
  const definition: StandardBeamFrictionDefinition = {
    schema: 'pointercad-standard-beam/7', id: 'friction', revision: 1,
    source: { documentId: document.id, documentRevision: 1, geometryRevision: 'browser-friction' }, units: 'N-mm',
    members: [testMember(saved, [saved.id], 'a-')],
    materials: [{ id: 'elastic', youngModulus: 208000, shearModulus: 80000, densityKgM3: 7850, source: TEST_EVIDENCE }],
    sections: [{ id: 'rectangle', area: 300, iy: 900, iz: 62500, torsionConstant: 3300,
      shearFactor: 5 / 6, source: TEST_EVIDENCE }],
    supports: [{ nodeId: 'a-base', restrained: [true, true, true, true, true, true] }],
    contact: { segmentsPerMember: 1, contacts: [
      { id: CONTACT_ID, kind: 'node-plane', nodeId: 'a-tip', normal: [0, 1, 0], gapMm: 0 },
    ] },
    friction: { [CONTACT_ID]: 0.3 },
    stepLoads: FORCES.map(force => [{ id: LOAD_ID, kind: 'nodal', nodeId: 'a-tip', force, moment: [0, 0, 0] }]),
    solverOptions: { solver: 'newton', iterationLimit: 64 },
  };
  return { definition, bytes: await writeDocumentBundle(createAssemblyDocumentBundle({ ...document,
    beamAnalysisInputs: { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition }] },
  }, EMPTY_PART_LIBRARY)) };
}

function panel(page: Page): Locator { return page.getByTestId('beam-panel'); }
function frictionField(page: Page, key: string): Locator {
  return panel(page).locator(`[data-friction-field="friction:${key}"] input.pcad-field__input`);
}

export async function openPanel(page: Page): Promise<void> {
  if (await panel(page).count() > 0) {
    await panel(page).getByTestId('beam-close').click();
    await expect(panel(page)).toHaveCount(0);
  }
  if (await page.getByTestId('beam-open').count() === 0) await chooseToolMenuItem(page, '見た目', '簡易強度計算');
  await page.getByTestId('beam-open').click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByTestId('beam-analysis-type')).toHaveValue('friction');
  await expect(panel(page).getByTestId('beam-friction-results')).toHaveCount(0);
  await expect(panel(page).getByTestId('beam-run')).toBeDisabled();
}

/** Inspect the restored controls, including all zero unloading components, before reviewing anything. */
export async function checkSettings(page: Page): Promise<void> {
  await expect(panel(page).getByTestId('beam-segments')).toHaveValue('1');
  await expect(panel(page).getByTestId('beam-friction-solver')).toHaveValue('newton');
  await expect(frictionField(page, 'iterationLimit')).toHaveValue('64');
  await expect(frictionField(page, `coefficient:${CONTACT_ID}`)).toHaveValue('0.3');
  await expect(panel(page).locator('[data-friction-input-step]')).toHaveCount(4);
  await expect(panel(page).locator(`[data-friction-load-node="${LOAD_ID}"]`)).toHaveValue('a-tip');
  const contact = panel(page).locator(`[data-beam-contact="${CONTACT_ID}"]`);
  await expect(contact.locator('[data-beam-contact-kind]')).toHaveValue('node-plane');
  await expect(contact.locator('[data-beam-contact-node]')).toHaveValue('a-tip');
  for (const [name, value] of [['normalX', '0'], ['normalY', '1'], ['normalZ', '0'], ['gap', '0']] as const) {
    await expect(contact.locator(`[data-beam-contact-field="contact:${CONTACT_ID}:${name}"] input.pcad-field__input`)).toHaveValue(value);
  }
  for (const [step, force] of FORCES.entries()) {
    for (const axis of [0, 1, 2] as const) {
      await expect(frictionField(page, `step:${step}:load:0:force:${axis}`)).toHaveValue(String(force[axis]));
      await expect(frictionField(page, `step:${step}:load:0:moment:${axis}`)).toHaveValue('0');
    }
  }
  const member = panel(page).locator('[data-beam-member="a-beam"]');
  await expect(member).toHaveCount(1);
  for (const [field, value] of [['young', '208000'], ['shear', '80000'], ['density', '7850'],
    ['area', '300'], ['iy', '900'], ['iz', '62500'], ['torsion', '3300']] as const) {
    await expect(member.locator(`[data-beam-field="${field}"] input.pcad-field__input`)).toHaveValue(value);
  }
  for (const end of ['start', 'end'] as const) {
    const supports = member.locator(`[data-beam-buckling-supports="${end}"] input[data-beam-restraint]`);
    await expect(supports).toHaveCount(6);
    for (let axis = 0; axis < 6; axis += 1) {
      if (end === 'start') await expect(supports.nth(axis)).toBeChecked();
      else await expect(supports.nth(axis)).not.toBeChecked();
    }
  }
}

export async function checkResults(page: Page): Promise<void> {
  const results = panel(page).getByTestId('beam-friction-results');
  await expect(results).toBeVisible({ timeout: RESULT_TIMEOUT_MS });
  const steps = results.locator('[data-friction-step]');
  await expect(steps).toHaveCount(4);
  const normal = [10, 10, 0, 10], frictionX = [-2, -3, 0, 3];
  // Compare rendered values at 6 decimal places (the shared display retains 9 significant digits).
  const number = async (cell: Locator): Promise<number> => Number((await cell.textContent() ?? '').replaceAll(',', ''));
  for (let index = 0; index < 4; index += 1) {
    await expect(steps.nth(index)).toHaveAttribute('data-friction-step', String(index));
    const table = steps.nth(index).locator(`[data-friction-contact="${CONTACT_ID}"]`);
    expect(await number(table.locator('[data-quantity="normalReaction"] td'))).toBeCloseTo(normal[index], 6);
    const friction = table.locator('[data-quantity="frictionForce"] td');
    await expect(friction).toHaveCount(3);
    expect(await number(friction.nth(0))).toBeCloseTo(frictionX[index], 6);
    expect(await number(friction.nth(1))).toBeCloseTo(0, 6);
    expect(await number(friction.nth(2))).toBeCloseTo(0, 6);
    expect(await number(table.locator('[data-quantity="gap"] td'))).toBeCloseTo(0, 6);
  }
}

export async function savedDefinition(path: string): Promise<StandardBeamFrictionDefinition> {
  const read = await readDocumentBundle(await readFile(path), 'assembly');
  if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('saved friction assembly did not decode');
  const inputs = read.bundle.document.beamAnalysisInputs;
  expect(inputs?.analyses).toHaveLength(1);
  const entry = inputs?.analyses[0];
  if (entry?.kind !== 'standard-members' || entry.definition.schema !== 'pointercad-standard-beam/7') {
    throw new Error('saved schema7 friction input missing');
  }
  expect(JSON.stringify(inputs)).not.toMatch(/"(?:result|states|normalReactionN|frictionForceN|displacementM|inputSha256)"/u);
  expect(entry.definition.source.documentId).toBe(read.bundle.document.id);
  return entry.definition;
}

/** Real file open -> invalid input -> review -> native Worker -> apply -> real save/read -> reopen untrusted. */
export async function frictionLifecycleFlow(page: Page, pathFor: (name: string) => string, app?: ElectronApplication): Promise<void> {
  const fixture = await cantileverWithFrictionInputs();
  const inputPath = pathFor('friction-inputs.pcada');
  await writeFile(inputPath, fixture.bytes);
  // The fixture itself goes through the same real reader used to inspect the saved output.
  expect(await savedDefinition(inputPath)).toEqual(fixture.definition);
  await openSaveFlowFile(page, inputPath, app);
  await expect(componentRows(page)).toHaveCount(1);
  await openPanel(page);
  await checkSettings(page);
  const confirmation = panel(page).locator('input[data-beam-confirm]');
  await expect(confirmation).toHaveCount(1);
  await confirmation.check();
  const coefficient = frictionField(page, `coefficient:${CONTACT_ID}`);
  await coefficient.fill('-0.3');
  await panel(page).getByTestId('beam-review').click();
  await expect(panel(page).getByRole('alert')).toBeVisible();
  await expect(coefficient).toHaveValue('-0.3');
  await expect(panel(page).getByTestId('beam-run')).toBeDisabled();
  await expect(panel(page).getByTestId('beam-apply')).toBeDisabled();
  await expect(panel(page).getByTestId('beam-friction-results')).toHaveCount(0);
  await coefficient.fill('0.3');
  await panel(page).getByTestId('beam-review').click();
  await expect(panel(page).getByTestId('beam-run')).toBeEnabled();
  await panel(page).getByTestId('beam-run').click();
  await checkResults(page);
  await expect(panel(page).getByTestId('beam-status')).toHaveAttribute('data-status', 'complete');
  await expect(panel(page).getByTestId('beam-apply')).toBeEnabled();
  await panel(page).getByTestId('beam-apply').click();
  await waitForSettledRecompute(page);
  const outputPath = pathFor('friction-applied.pcada');
  await saveFlowFile(page, outputPath, app);
  const applied = await savedDefinition(outputPath);
  // Only current source/revision are refreshed by explicit review; every saved physical field and original ID is exact.
  expect(applied).toEqual({ ...fixture.definition, source: applied.source, revision: applied.revision });
  await openSaveFlowFile(page, outputPath, app);
  await expect(componentRows(page)).toHaveCount(1);
  await openPanel(page);
  await checkSettings(page);
  await expect(panel(page).locator('input[data-beam-confirm]')).not.toBeChecked();
  await expect(panel(page).getByTestId('beam-apply')).toBeDisabled();
  expect(await savedDefinition(outputPath)).toEqual(applied);
}
