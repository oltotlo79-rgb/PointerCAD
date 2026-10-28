/// <reference lib="dom" />
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { readDocumentBundle, writeAssemblyDocument, writePcadaFile } from '../../packages/io/src/index.js';
import { withBeamAnalysisInputs } from '../../packages/model/src/analysis/beamInputs.js';
import { savedBoltFixture } from '../../packages/model/src/analysis/cadNativeBoltPreloadInput.testSupport.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute, waitForSettledRecompute } from './recompute.js';
import { assertRenderedControlDescriptions } from './controlDescriptions.js';
import type { BeamWorkerStatistics } from '../../packages/ui/src/beam/attachBeamAnalysis.js';

declare global { interface Window { pcadBeamWorkers?: () => BeamWorkerStatistics } }

const SAVED_AT = '2026-10-27T00:00:00.000Z';
const FIXTURE_SHA256 = '125d8c98eb2422f9ca48d5f48691dfb0127aff4926e0476b130a961719526dcb';
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
/** Real serializable input only. No world positions/results/Worker tokens are introduced into saved inputs.
 * Independent approved fixture: two FB50x6/50mm members, E200000MPa/A300mm²;
 * 100mm bolt E200000MPa/A100mm² plus explicit 2+1+2nm/N. Fi4000N, cm=1/600000000m/N, cb=1e-8m/N. */
export async function boltPreloadFixture() {
  const f = savedBoltFixture(), bolts = f.saved.cadDefinition.axialBolts;
  if (bolts === undefined) throw new Error('Approved CAD fixture lacks explicit bolt geometry');
  const document = withBeamAnalysisInputs(f.document, { schema: 'pointercad-beam-inputs/1', analyses: [
    { kind: 'standard-members', definition: { ...f.saved.cadDefinition, id: 'other-analysis', axialBolts: { ...bolts, analysisId: 'other-analysis' } } },
    { kind: 'native-bolt-preload', definition: f.saved },
  ] });
  const bytes = await writePcadaFile(document, { savedAt: SAVED_AT });
  const read = await readDocumentBundle(bytes, 'assembly');
  if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('The actual PCAD decoder refused the explicit fixture');
  expect(read.bundle.document.beamAnalysisInputs).toEqual(document.beamAnalysisInputs);
  return { document, bytes };
}
async function workers(page: Page) {
  return page.evaluate(() => {
    const read = window.pcadBeamWorkers;
    if (read === undefined) throw new Error('Read-only existing beam worker statistics are unavailable');
    return read();
  });
}
async function saved(page: Page, info: TestInfo, step: string, app?: ElectronApplication) {
  const bytes = await saveFlowFile(page, info.outputPath(`bolt-${step}.pcada`), app);
  const read = await readDocumentBundle(bytes, 'assembly');
  if (!read.ok || read.bundle.kind !== 'assembly') throw new Error(`${step}: saved assembly could not be decoded`);
  await info.attach(`bolt-${step}-saved`, { body: bytes, contentType: 'application/octet-stream' });
  return { document: read.bundle.document, canonical: writeAssemblyDocument(read.bundle.document, { savedAt: SAVED_AT }) };
}
const numericalFields = {
  young0: '200000', shear0: String(200000 / 2.6), density0: '7850', area0: '300', iy0: '900', iz0: '62500', torsion0: '3300', factor0: String(5 / 6),
  young1: '200000', shear1: String(200000 / 2.6), density1: '7850', area1: '300', iy1: '900', iz1: '62500', torsion1: '3300', factor1: String(5 / 6),
  boltYoung: '200000', boltArea: '100', preloadN: '4000', threadCompliance: '2e-9', headCompliance: '1e-9', bearingCompliance: '2e-9', memberCompliance: String(1 / 600000000),
};
async function explicitAssociation(page: Page): Promise<void> {
  const panel = page.getByTestId('bolt-preload-panel'); await panel.getByTestId('preload-reassociate').click();
  const author = panel.getByTestId('bolt-preload-author'); await expect(author).toBeVisible();
  await author.getByTestId('preload-member-0').selectOption('["a"]'); await author.getByTestId('preload-member-1').selectOption('["b"]');
  await author.getByTestId('preload-bolt').selectOption('selected-bolt'); await author.getByTestId('preload-contact').selectOption('interface');
  expect(Object.keys(numericalFields)).toHaveLength(23);
  for (const [key, value] of Object.entries(numericalFields)) {
    const field = author.locator(`[data-preload-number="${key}"]`); await expect(field).toHaveValue(''); await field.fill(value);
  }
  const evidence = author.locator('fieldset'); await expect(evidence).toHaveCount(13);
  for (const field of await evidence.all()) {
    await field.getByRole('combobox', { name: '出典の種類', exact: true }).selectOption('user-supplied');
    await field.getByRole('textbox', { name: '根拠・参照先', exact: true }).fill('Explicit FB50x6 50+50mm / series-compliance oracle');
    await field.getByRole('textbox', { name: '適用条件', exact: true }).fill('Axial linear elasticity; no general contact or capacity claim');
  }
  await author.getByTestId('preload-author-loads').fill('1000\n0'); await author.getByTestId('preload-geometry-confirm').check();
  await assertRenderedControlDescriptions(author);
  await author.getByTestId('preload-preview').click(); await expect(author.getByTestId('preload-adopt')).toBeVisible();
  await expect(panel.getByTestId('preload-result')).toHaveCount(0);
}
async function confirmReview(page: Page): Promise<void> {
  const panel = page.getByTestId('bolt-preload-panel'); await panel.getByTestId('preload-confirm').check();
  await panel.getByTestId('preload-review').click(); await expect(panel.getByTestId('preload-run')).toBeEnabled();
}
/** Normal file open, visible controls, real native Worker dispatch; read-only diagnostics are never setters. */
export async function boltPreloadFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await boltPreloadFixture(); expect(hash(fixture.bytes)).toBe(FIXTURE_SHA256);
  const path = info.outputPath('explicit-bolt-input.pcada'); await writeFile(path, fixture.bytes, { flag: 'wx' });
  await info.attach('bolt-fixture-provenance', { body: Buffer.from(JSON.stringify({ fixtureSHA256: FIXTURE_SHA256,
    source: 'cadNativeBoltPreloadInput.testSupport.ts:savedBoltFixture / beamInputs.testSupport.ts',
    cmMPerN: 1 / 600000000, cbMPerN: 1e-8, preloadN: 4000, shorteningM: 7 / 150000,
    at1000: { boltN: 29000 / 7, contactN: 22000 / 7 }, realNativeRequired: true })), contentType: 'application/json' });
  await openSaveFlowFile(page, path, app); await waitForSettledRecompute(page);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
  const before = await saved(page, info, 'opened', app);
  expect(before.document.beamAnalysisInputs).toEqual(fixture.document.beamAnalysisInputs);
  await page.getByRole('button', { name: /^見た目/u }).click();
  await page.getByRole('group', { name: '見た目', exact: true }).getByRole('button', { name: '簡易強度計算', exact: true }).click();
  const panel = page.getByTestId('bolt-preload-panel'); await expect(panel).toBeVisible();
  await panel.locator('[data-preload-open="axial"]').click();
  await panel.getByTestId('preload-reassociate').click();
  await panel.getByTestId('preload-preview').click(); await expect(panel.getByRole('alert')).toBeVisible();
  await expect(panel.getByTestId('preload-adopt')).toHaveCount(0);
  await panel.getByTestId('preload-author-cancel').click();
  expect((await saved(page, info, 'insufficient-cancel', app)).canonical).toBe(before.canonical);
  await explicitAssociation(page);
  // Validation is not consent, and neither action is a document commit.
  expect((await saved(page, info, 'no-consent', app)).canonical).toBe(before.canonical);
  await panel.getByTestId('preload-adopt').click(); await expect(panel.getByTestId('preload-confirm')).not.toBeChecked();
  await assertRenderedControlDescriptions(panel);
  await expect(panel.getByTestId('preload-run')).toBeDisabled(); await confirmReview(page);
  const initialWorkers = await workers(page); await panel.getByTestId('preload-run').click();
  await expect.poll(async () => (await workers(page)).created, { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(initialWorkers.created);
  await panel.getByTestId('preload-cancel').click(); await expect(panel.getByTestId('preload-status')).toHaveText('解析を中止しました。結果はありません。');
  await expect.poll(async () => (await workers(page)).live, { timeout: KERNEL_TIMEOUT_MS }).toBe(0);
  await expect(panel.getByTestId('preload-result')).toHaveCount(0);
  expect((await saved(page, info, 'native-cancel', app)).canonical).toBe(before.canonical);
  await expect(panel.getByTestId('preload-result')).toHaveCount(0);
  await confirmReview(page); const completedBefore = await workers(page); await panel.getByTestId('preload-run').click();
  await expect(panel.getByTestId('preload-status')).toHaveText('計算結果を表示', { timeout: KERNEL_TIMEOUT_MS });
  const rows = panel.getByTestId('preload-result').locator('tbody tr'); await expect(rows).toHaveCount(3);
  const force = Number(await rows.nth(1).locator('td').nth(1).textContent()), contact = Number(await rows.nth(1).locator('td').nth(2).textContent());
  expect(Math.abs(force - 29000 / 7) / (29000 / 7)).toBeLessThanOrEqual(1e-9);
  expect(Math.abs(contact - 22000 / 7) / (22000 / 7)).toBeLessThanOrEqual(1e-9);
  expect(await workers(page)).toMatchObject({ created: completedBefore.created + 1, live: 0 });
  const token = await beginRecompute(page); await panel.getByTestId('preload-save').click(); await waitForRecompute(page, token);
  await expect(panel.getByTestId('preload-confirm')).not.toBeChecked(); await expect(panel.getByTestId('preload-result')).toHaveCount(0);
  const after = await saved(page, info, 'input-applied', app);
  expect(after.document.beamAnalysisInputs?.analyses[0]).toEqual(before.document.beamAnalysisInputs?.analyses[0]);
  const entry = after.document.beamAnalysisInputs?.analyses.find(row => row.kind === 'native-bolt-preload');
  if (entry?.kind !== 'native-bolt-preload') throw new Error('Input-only native preload save is missing');
  expect(entry.definition.revision).toBeGreaterThan(fixture.document.beamAnalysisInputs?.analyses[1].kind === 'native-bolt-preload'
    ? fixture.document.beamAnalysisInputs.analyses[1].definition.revision : 0);
  expect(entry.definition.input.declaration.preloadN.value).toBe(4000);
  expect(entry.definition.input.memberIds).toEqual(['a-beam', 'b-beam']);
  expect(JSON.stringify(entry)).not.toMatch(/"(?:result|wire|token|states|positionM)"/u);
  const undo = await beginRecompute(page); await page.getByRole('button', { name: '元に戻す', exact: true }).click(); await waitForRecompute(page, undo);
  expect((await saved(page, info, 'undo-once', app)).canonical).toBe(before.canonical);
  await info.attach('bolt-real-native-observation', { body: Buffer.from(JSON.stringify({ forceN: force, contactN: contact,
    workers: await workers(page), nativeWasMocked: false, inputSaveOneUndo: true })), contentType: 'application/json' });
}
