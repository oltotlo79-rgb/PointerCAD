/// <reference lib="dom" />
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { readArchive, readDocumentBundle, writeAssemblyDocument, writePcadaFile } from '../../packages/io/src/index.js';
import { withBeamAnalysisInputs } from '../../packages/model/src/analysis/beamInputs.js';
import { savedBoltFixture } from '../../packages/model/src/analysis/cadNativeBoltPreloadInput.testSupport.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute, waitForSettledRecompute } from './recompute.js';
import { assertRenderedControlDescriptions } from './controlDescriptions.js';
import { collectFailedRequests, recordRequestFailures } from './networkFailureEvidence.js';
import { uiMessage } from './uiMessages.js';
import type { BeamWorkerStatistics } from '../../packages/ui/src/beam/attachBeamAnalysis.js';

declare global { interface Window { pcadBeamWorkers?: () => BeamWorkerStatistics } }

const SAVED_AT = '2026-10-27T00:00:00.000Z';
const FIXTURE_ARCHIVES = {
  legacy: { bytes: 2998, sha256: 'e1434dab8e19653c1d7f84e82a9019057c47e963d8b268068f471afb48133943' },
  current: { bytes: 3055, sha256: '83f68a95be7085ef0d2c7748b7422418c8e71c949f66c23db487e1e7de898d0b' },
};
const FIXTURE_ENTRIES = [
  { name: 'document.json', bytes: 26033, sha256: '3a6fd525ce594b5db25dddfb6ee6dc5195b11ff6b62a5284754bdbf683e1dfb8' },
];
// Previous writer output from 7844f265, captured before the ZIP layout change.
const LEGACY_FIXTURE_BASE64 = `
UEsDBBQAAAAIAABgIgBVV8iBOgsAALFlAAANAAAAZG9jdW1lbnQuanNvbu1dzW/kthW/718h6FztamZ27LUDA7E32GCTeGHEaYC2
yIEjcWa40UgqpXHsrffQQw9FDwUKFD310PbQHhr0sD20QG/9W5yP/yKP1Mfo45Gi/Lnxyth4d0iKj3rv8UfyvR8nv3pgWXbiLemK
2LvWePwT8flLFvrwySZJQlez4MyWpSSOReFRxMKU8qf7H2TFCTmh/n4qqsbueMsZuc54+zPX3ZV/Hrqu+/OsoR956xUNRUshFUpm
lKz2QxKcJSx5HsbrNCnrqqOy40ykR3xHPOIw2fbRSPYr2xLZCxXP/yIvs8qeZIvinZKUhD7hvrOCV6M8KfuQrXw6ZyFLWRRWRlLI
OGUkOIiC2ijLWnS04j/5mDMTz1VGvHkuWnOPIj1WNPa8Zg2n3Uul7af0hCXZ+LeRZgsarWjKzyrNyjJnNLYbT7xujTfTNNhLjilK
l5Q7RVn77YqaijjpYrVGUjc1yxU/bZ1AcyYlp4wiash7exqt4igsNZfQgHopBe+BOvwpehrLJkeEpx/TM/HUkp4Ka7//kiWO9Gx3
x3GfOHz0aLR7ONo69xnoW7zUMeWMJnskDOnpR/vnAQ0X6XJv5Lrn6ZJT4uf1XkR4ohh0If6QgOeAv8hxh+sgQFvPGU8206hVnXl2
7jRyxqBCoWUY+bRsR2BwSLOWC2RuS71ITiiDMcwMxzBzUhabD+EsWoeLwyOJW4Ayrotrdj4HzbITug+mOFyNoTVYBm0a8yimPD07
Vk/JGpSsE/D9ZB3HAaO+6vU4nVNOQ9mf/Tz0aUzhV5haHIZFwsU6INxKaZJaoFIBPBbgk0UDkqTMs0DJArDS5D0rjFKLhdAZp741
59HKItaCE59aAZnRQCVfmKkANPsTFlIQx5IohXeF/qXgVe5071keDIxHzCeBFXMWeiyGf5FTKsVbHomJx9IzywsIW5kbivmUBOwV
KUYxY4GQCKi4Dtk84qscI/OXbnf8ulHyRe1zQyiOxCXsC1d8NG1oK8cULZqBJVUYpgZxcwg3AvB+8N1UDGhb4qz9wlk1p2M+YTEY
RhamTF1KbLEjz1uDn4LXH5F0iUK7WBzalv4C6QyB5jk40AHh77+MwbCUBhk+w84D/gA+T/JSmNBzFlBntPvswJq6///T1nk5HfaW
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
`;
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
async function readBoltFixture(bytes: Uint8Array, expected: { readonly bytes: number; readonly sha256: string }) {
  expect({ bytes: bytes.byteLength, sha256: hash(bytes) }).toEqual(expected);
  const archive = readArchive(bytes, { shouldExtract: () => true });
  if (!archive.ok) throw new Error(`The bolt fixture ZIP was rejected: ${archive.error.reason}`);
  expect([...archive.entries].map(([name, entry]) => ({ name, bytes: entry.byteLength, sha256: hash(entry) })))
    .toEqual(FIXTURE_ENTRIES);
  const read = await readDocumentBundle(bytes, 'assembly');
  if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('The actual PCAD decoder refused the explicit fixture');
  expect(read.savedAt).toBe(SAVED_AT);
  return read.bundle.document;
}
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
  const read = await readBoltFixture(bytes, FIXTURE_ARCHIVES.current);
  const legacy = await readBoltFixture(Buffer.from(LEGACY_FIXTURE_BASE64, 'base64'), FIXTURE_ARCHIVES.legacy);
  expect(read.beamAnalysisInputs).toEqual(document.beamAnalysisInputs);
  expect(read.components).toEqual(document.components);
  expect(legacy).toEqual(read);
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
  // Worker の資産の取得を含む失敗した要求を集める(run 43711424272 は python_stdlib.zip の net::ERR_NO_BUFFER_SPACE で断られた)。
  const failed = collectFailedRequests(page);
  const fixture = await boltPreloadFixture();
  const path = info.outputPath('explicit-bolt-input.pcada'); await writeFile(path, fixture.bytes, { flag: 'wx' });
  await info.attach('bolt-fixture-provenance', { body: Buffer.from(JSON.stringify({ fixtureSHA256: FIXTURE_ARCHIVES.current.sha256,
    fixtureArchives: FIXTURE_ARCHIVES, fixtureEntries: FIXTURE_ENTRIES,
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
  const preloadDraft = panel.locator('[data-preload-draft-number="preloadN"]');
  await preloadDraft.fill('４０００'); await expect(preloadDraft).toHaveValue('４０００');
  await expect(panel.getByTestId('preload-run')).toBeDisabled(); await confirmReview(page);
  await expect(preloadDraft).toHaveValue('４０００');
  const initialWorkers = await workers(page); await panel.getByTestId('preload-run').click();
  await expect.poll(async () => (await workers(page)).created, { timeout: KERNEL_TIMEOUT_MS }).toBeGreaterThan(initialWorkers.created);
  await panel.getByTestId('preload-cancel').click(); await expect(panel.getByTestId('preload-status')).toHaveText('解析を中止しました。結果はありません。');
  await expect.poll(async () => (await workers(page)).live, { timeout: KERNEL_TIMEOUT_MS }).toBe(0);
  await expect(panel.getByTestId('preload-result')).toHaveCount(0);
  expect((await saved(page, info, 'native-cancel', app)).canonical).toBe(before.canonical);
  await expect(panel.getByTestId('preload-result')).toHaveCount(0);
  await confirmReview(page); const completedBefore = await workers(page); await panel.getByTestId('preload-run').click();
  // 断られた(終わりの)状態のまま上限まで待たず、判定の前に失敗した要求と通信の状態を残す。成功の条件と上限は変えない。
  const status = panel.getByTestId('preload-status'), completeText = uiMessage('beam', 'beam.preload.complete');
  const endTexts = [completeText, uiMessage('beam', 'beam.preload.failed'), uiMessage('strength', 'strength.femFailure.assetMissing'),
    uiMessage('strength', 'strength.femFailure.assetCorrupt')];
  await expect(status).toHaveText(new RegExp(`^(?:${endTexts.map(escapeRegExp).join('|')})$`, 'u'), { timeout: KERNEL_TIMEOUT_MS });
  const finalStatus = await status.textContent();
  if (finalStatus !== completeText) await recordRequestFailures(info, { label: 'bolt preload real native run', failed,
    errors: [`preload-status: ${String(finalStatus)}`, `workers: ${JSON.stringify(await workers(page))}`] });
  expect(finalStatus, 'bolt preload real native run status').toBe('計算結果を表示');
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
