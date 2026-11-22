import { readFile } from 'node:fs/promises';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readPcadFile } from '../../packages/io/src/index.js';
import { trackFemWorkers } from './analysisResultBindingFlow.js';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { statusBar } from './fileCaptureSupport.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { clickWorldPoint, commitPopover, fillFields, popover, popoverTitle, selectionKindLabel,
  sketchTool } from './solidCaptureSupport.js';
import { uiMessage } from './uiMessages.js';

/*
 * J-03b stage 2 on the real screen: a static solid result computed in the panel is saved with the part and comes back
 * after reopening without a new run. Real box tool, real panel, real FEM worker, the product's save (web download with
 * the file pickers removed by the spec) and open (file chooser) through the shared steps saveFlowFile and openSaveFlowFile
 * (saveResponsivenessFlow.ts); no store write and no injected result.
 *   positive : closing the panel keeps the result with the part; reopening the panel shows it with the kept line, no run.
 *   positive : after saving the input and running, the saved file holds the result with its solver input (read back with
 *              the product reader in Node), and the reopened part shows the same values with the saved-result line while
 *              no FEM worker starts.
 *   negative : a material edit after reopening removes the restored result and its line.
 *   positive : saving that edit and undoing it returns to the opened part, and its saved result comes back in the open
 *              panel with the same values and line, still without a FEM run.
 * The same 40 × 30 × 10 mm box and conditions as analysisResultBindingFlow: +X face fixed, top face loaded with
 * traction Z -0.001 N/mm², E 210000 MPa, ν 0.3. Independent oracle for the loaded force: 1200 mm² × -0.001 = -1.2 N.
 */
const LOADED_AREA_MM2 = 1200;
const TRACTION_Z = -0.001;
const FILE_NAME = 'solid-saved-result.pcad';
/** The shown result rows compared before saving and after reopening (all of them, as text). */
const RESULT_KEYS = ['displacement', 'stress', 'area', 'force', 'reaction', 'energy', 'residual'] as const;

function message(key: string): string {
  return uiMessage('solidAnalysis', `solidAnalysis.${key}`);
}

function textbox(panel: Locator, name: string): Locator {
  return panel.getByRole('textbox', { name, exact: true });
}

async function shownValues(panel: Locator): Promise<readonly string[]> {
  const result = panel.getByTestId('solid-results');
  await expect(result).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
  return Promise.all(RESULT_KEYS.map(key => result.locator(':scope > dl').getByText(message(key), { exact: true })
    .locator('xpath=following-sibling::dd[1]').innerText()));
}

async function openSolidPanel(page: Page): Promise<Locator> {
  await openToolMenu(page, '解析');
  await toolMenuPanel(page, '解析').getByRole('button', { name: message('open'), exact: true }).click();
  const panel = page.getByTestId('solid-analysis-panel');
  await expect(panel).toBeVisible();
  return panel;
}

/** The app version the web build writes into the saved result (vite define = the root package.json version). */
async function appVersion(): Promise<string> {
  const manifest: unknown = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const version: unknown = typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'version') : undefined;
  if (typeof version !== 'string' || version === '') throw new Error('Missing root package version');
  return version;
}

/** The product reader accepts the saved bytes and finds the static solid result with its solver input. */
function expectSavedFile(bytes: Buffer): void {
  const read = readPcadFile(new Uint8Array(bytes));
  if (!read.ok) throw new Error(`The product reader refused the saved part: ${read.error.code}`);
  expect(read.analysisResultIssue).toBeUndefined();
  const saved = read.analysisResults?.get('solid-cad');
  expect(saved?.kind).toBe('oofem-linear-solid-tet4');
  if (saved?.kind !== 'oofem-linear-solid-tet4') return;
  expect(saved.prepared?.loadedAreaMm2).toBeCloseTo(LOADED_AREA_MM2, 6);
  expect(saved.prepared?.totalForceN[2]).toBeCloseTo(LOADED_AREA_MM2 * TRACTION_Z, 6);
  expect(saved.prepared?.input.source).toEqual(saved.result.source);
}

export async function solidSavedResultFlow(page: Page, info: TestInfo): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); });
  await page.goto('/');
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  await openToolMenu(page, '作る');
  await toolMenuPanel(page, '作る').getByRole('button', { name: '箱', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('箱を置く');
  await fillFields(page, ['40', '30', '10']);
  const built = await beginRecompute(page);
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
  await waitForRecompute(page, built);
  await sketchTool(page, '選択').click();
  await page.keyboard.press('3');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');

  let panel = await openSolidPanel(page);
  await clickWorldPoint(page, [20, 0, 0]);
  await panel.getByTestId('solid-fixed').click();
  await clickWorldPoint(page, [0, 0, 5]);
  await panel.getByTestId('solid-loaded').click();
  await textbox(panel, '面荷重 Z (N/mm²)').fill(String(TRACTION_Z));
  await textbox(panel, 'ヤング率 E (MPa)').fill('210000');
  await textbox(panel, 'ポアソン比 ν').fill('0.3');
  await textbox(panel, '曲面の最大体積差 (mm³)').fill('1');
  // Only a result of the input saved in the document is saved with the part.
  await panel.getByTestId('solid-save').click();
  await panel.getByTestId('solid-run').click();
  const before = await shownValues(panel);
  expect(Number.parseFloat(before[2] ?? '')).toBeCloseTo(LOADED_AREA_MM2, 6);
  await expect(panel.getByTestId('solid-saved-result')).toHaveCount(0);

  // Closing the panel keeps the result with the part (J-03b remaining): reopening the panel shows it again with the
  // kept line and no FEM run, and the save after closing still writes it.
  const workers = trackFemWorkers(page);
  await panel.getByRole('button', { name: message('close'), exact: true }).click();
  await expect(panel).toHaveCount(0);
  panel = await openSolidPanel(page);
  expect(await shownValues(panel)).toEqual(before);
  await expect(panel.getByTestId('solid-saved-result')).toHaveText(message('savedResult.kept'));
  await panel.getByRole('button', { name: message('close'), exact: true }).click();
  await expect(panel).toHaveCount(0);

  // The product's save (the shared save step: Shift+保存, answered with a download in the web build, until the save completes).
  const path = info.outputPath(FILE_NAME);
  const bytes = await saveFlowFile(page, path);
  // The saved notice is set before the save completes; a left-out result would name its reason there (ui2b).
  for (const key of ['file.savedWithoutResult.invalid', 'file.savedWithoutResult.tooLarge']) {
    await expect(statusBar(page)).not.toContainText(uiMessage('file', key));
  }
  expectSavedFile(bytes);

  // Reopen the saved part (the shared open step). The panel is already closed, so it opens on the reopened, recomputed part.
  await openSaveFlowFile(page, path);
  panel = await openSolidPanel(page);
  expect(await shownValues(panel)).toEqual(before);
  await expect(panel.getByTestId('solid-saved-result'))
    .toHaveText(message('savedResult.status').replace('{version}', await appVersion()));
  expect(workers.started(), 'the reopened result is shown without a new FEM run').toBe(0);

  // Negative: a material edit drops the restored result and its line, as for a computed one.
  await textbox(panel, 'ヤング率 E (MPa)').fill('105000');
  await expect(panel.getByTestId('solid-results')).toHaveCount(0);
  await expect(panel.getByTestId('solid-saved-result')).toHaveCount(0);

  // Positive without reopening the panel: saving the edited input and undoing it returns to the opened part, whose saved
  // result comes back with its line (attachSolidAnalysis restores after a history step), still without a FEM run.
  await panel.getByTestId('solid-save').click();
  await expect(panel.getByTestId('solid-results')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(textbox(panel, 'ヤング率 E (MPa)')).toHaveValue('210000');
  expect(await shownValues(panel)).toEqual(before);
  await expect(panel.getByTestId('solid-saved-result'))
    .toHaveText(message('savedResult.status').replace('{version}', await appVersion()));
  expect(workers.started(), 'the result restored after Undo is not computed again').toBe(0);
  expect(errors).toEqual([]);
}
