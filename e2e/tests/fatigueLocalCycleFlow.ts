import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readPcadFile } from '../../packages/io/src/index.js';
import { fileAction } from './fileCaptureSupport.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';

/*
 * One constant-amplitude local cycle (FatigueLocalCyclePanel) through the ordinary public controls, in the real web host
 * and in real Electron (task177, successor of the task176 flow 10b00c11; same opening and file routes as
 * fatigueStrainPairedFlow.ts). Only clicks, typing, the toolbar Undo/Redo buttons and the existing file save/open paths
 * are used; nothing writes the store.
 *
 * Expectation, derived by hand and independent of the product: the same manufactured, test-only coefficients as the paired
 * strain-life flow (not a real material) b = c = -0.5, sigma_f' = 1000 MPa, E = 200000 MPa, eps_f' = 0.995. The typed
 * cycle strain 2u .. -2u (u = 2 ** -8) has eps_a = 2u = 1 / 128; the stress 300 .. -100 MPa has sigma_m = 100 MPa.
 *   Morrow: eps_a = ((sigma_f' - sigma_m) / E + eps_f') (2N) ** -0.5, so N = 8192 * 0.9995 ** 2; with stressMin -200 MPa,
 *   sigma_m = 50 MPa and N = 8192 * 0.99975 ** 2 (a lower mean stress, a longer life).
 *   SWT: sigma_max eps_a = (sigma_f' ** 2 / E) (2N) ** 2b + sigma_f' eps_f' (2N) ** (b + c) = (5 + 995) / (2N), so with
 *   sigma_max eps_a = 300 / 128, N = 1000 * 128 / (2 * 300) = 640 / 3.
 * All lie inside the typed calibrated range 1 .. 1000000.
 *
 * The estimate is synchronous (fatigueLocalCycleSlice.ts: "A pure synchronous estimate (no Worker)"): there is no Cancel.
 * Saving the input is one Undo step of the owner document; the result is never stored or restored.
 */
const u = 2 ** -8;
const LIFE_N = 8192 * 0.9995 ** 2;
const LIFE_N_LOWER_MEAN = 8192 * 0.99975 ** 2;
const LIFE_N_SWT = 640 / 3;
/** Texts copied from the Japanese message tables (ja/fatigueLocalCycle.json, ja/toolbar.json); this spec cannot import them. */
const TEXT = {
  errorCorrection: '平均応力の補正（Morrow または SWT）を選んでください。',
  saved: '保存済みの入力と同じです。',
  close: '閉じる',
  history: '履歴',
} as const;

async function openStrength(page: Page): Promise<void> {
  // The same public route as fatigueStrainPairedFlow.ts and strengthFlow.ts.
  await page.getByRole('button', { name: /^見た目/u }).click();
  await page.getByRole('group', { name: '見た目', exact: true }).getByRole('button', { name: '簡易強度計算', exact: true }).click();
}
async function openLocalCycle(page: Page): Promise<Locator> {
  await openStrength(page);
  const strength = page.getByRole('form', { name: '簡易強度計算', exact: true });
  await strength.getByTestId('fatigue-local-cycle-open').click();
  const panel = page.getByTestId('fatigue-local-cycle-panel');
  await expect(panel).toBeVisible();
  return panel;
}
const field = (panel: Locator, name: string): Locator => panel.locator(`[data-fatigue-local-cycle-field="${name}"]`);
/** The displayed number (9 significant digits) agrees with the hand-derived value to a relative 1e-8. */
async function expectNumber(locator: Locator, expected: number): Promise<void> {
  await expect.poll(async () => Math.abs(Number(await locator.textContent()) - expected) / expected).toBeLessThan(1e-8);
}
async function expectLife(panel: Locator, cycles: number): Promise<void> {
  await expect(panel.getByTestId('fatigue-local-cycle-refusal')).toHaveCount(0);
  await expect(panel.getByTestId('fatigue-local-cycle-result')).toBeVisible();
  await expectNumber(panel.getByTestId('fatigue-local-cycle-cycles'), cycles);
}
async function run(panel: Locator): Promise<void> {
  await panel.getByTestId('fatigue-local-cycle-run').click();
}
/**
 * The toolbar history buttons (shell/Toolbar.tsx 277-307: role group 「履歴」, aria-label 「元に戻す」/「やり直す」, aria-disabled
 * while unavailable; commandRegistry.ts runs the store undo/redo only when canUndo/canRedo). Scoped to that group because the
 * radial menu also offers history.undo.
 */
async function clickHistory(page: Page, name: '元に戻す' | 'やり直す'): Promise<void> {
  const button = page.getByRole('group', { name: TEXT.history, exact: true }).getByRole('button', { name, exact: true });
  await expect(button).toHaveAttribute('aria-disabled', 'false');
  await button.click();
}

export async function fatigueLocalCycleFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Browser flows exercise download/file-input; Electron retains its native save/open gateway.
  if (app === undefined) {
    await page.evaluate(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    });
  }
  await expect(fileAction(page, '開く')).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof window.pcadRecomputeStats)).toBe('function');
  const panel = await openLocalCycle(page);

  // Precondition of a fresh panel: no method is pre-selected, nothing is saved, no result; running refuses visibly.
  await expect(field(panel, 'correction')).toHaveValue('');
  await expect(field(panel, 'derivation')).toHaveValue('');
  await expect(panel.getByTestId('fatigue-local-cycle-saved')).toHaveCount(0);
  await run(panel);
  await expect(panel.getByTestId('fatigue-local-cycle-refusal')).toContainText(TEXT.errorCorrection);
  await expect(panel.getByTestId('fatigue-local-cycle-result')).toHaveCount(0);

  // Material coefficients and one stable cycle, typed as a user would; the method is chosen explicitly.
  for (const [name, value] of [['materialId', 'manufactured'], ['elasticModulusMpa', '200000'],
    ['fatigueStrengthCoefficientMpa', '1000'], ['fatigueStrengthExponent', '-0.5'], ['fatigueDuctilityCoefficient', '0.995'],
    ['fatigueDuctilityExponent', '-0.5'], ['minimumCycles', '1'], ['maximumCycles', '1000000'],
    ['materialReference', 'Test-only manufactured coefficients; not a material value'],
    ['materialCondition', 'Hand-derived example'], ['strainMax', String(2 * u)], ['strainMin', String(-2 * u)],
    ['stressMax', '300'], ['stressMin', '-100'], ['cycleReference', 'Test-only local cycle'],
    ['cycleCondition', 'Hand-derived example']] as const) await field(panel, name).fill(value);
  await field(panel, 'correction').selectOption('morrow');
  await field(panel, 'derivation').selectOption('elastic-plastic-analysis');
  await run(panel);
  await expectLife(panel, LIFE_N);

  // An edit drops the result at once; running again gives the life of the new input only (lower mean, longer life).
  await field(panel, 'stressMin').fill('-200');
  await expect(panel.getByTestId('fatigue-local-cycle-result')).toHaveCount(0);
  await run(panel);
  await expectLife(panel, LIFE_N_LOWER_MEAN);
  await field(panel, 'stressMin').fill('-100');
  await expect(panel.getByTestId('fatigue-local-cycle-result')).toHaveCount(0);
  await run(panel);
  await expectLife(panel, LIFE_N);

  // The SWT method on the same cycle: changing the method drops the result; its own hand-derived life follows.
  await field(panel, 'correction').selectOption('swt');
  await expect(panel.getByTestId('fatigue-local-cycle-result')).toHaveCount(0);
  await run(panel);
  await expectLife(panel, LIFE_N_SWT);
  await field(panel, 'correction').selectOption('morrow');
  await expect(panel.getByTestId('fatigue-local-cycle-result')).toHaveCount(0);
  await run(panel);
  await expectLife(panel, LIFE_N);

  // Saving is one Undo step of the document: Undo removes the saved input (the typed draft stays), Redo brings it back.
  await panel.getByTestId('fatigue-local-cycle-save').click();
  await expect(panel.getByTestId('fatigue-local-cycle-saved')).toHaveText(TEXT.saved);
  await clickHistory(page, '元に戻す');
  await expect(panel.getByTestId('fatigue-local-cycle-saved')).toHaveCount(0);
  await expect(field(panel, 'stressMax')).toHaveValue('300');
  await clickHistory(page, 'やり直す');
  await expect(panel.getByTestId('fatigue-local-cycle-saved')).toHaveText(TEXT.saved);

  // The document goes to a file through the existing save path; the file holds the typed input and no result.
  const path = info.outputPath('fatigue-local-cycle.pcad');
  const read = readPcadFile(new Uint8Array(await saveFlowFile(page, path, app)));
  if (!read.ok) throw new Error(read.error.message);
  const saved = read.document.beamAnalysisInputs?.analyses.find(input => input.kind === 'fatigue-local-cycle');
  const definition = saved?.kind === 'fatigue-local-cycle' ? saved.definition : null;
  expect(definition?.input.correction).toBe('morrow');
  expect(definition?.input.cycle).toMatchObject({ derivation: 'elastic-plastic-analysis', strainMax: 2 * u, strainMin: -2 * u,
    stressMax: 300, stressMin: -100 });
  expect(JSON.stringify(read.document.beamAnalysisInputs)).not.toMatch(/"(?:cyclesToFailure|reversalsToFailure|strainAmplitude|meanStressMpa|result)"/u);

  // Replacing the document closes the panel; a fresh panel has no input and no result.
  await fileAction(page, '新規').click();
  await expect(panel).toHaveCount(0);
  const fresh = await openLocalCycle(page);
  await expect(field(fresh, 'stressMax')).toHaveValue('');
  await expect(field(fresh, 'correction')).toHaveValue('');
  await expect(fresh.getByTestId('fatigue-local-cycle-result')).toHaveCount(0);
  await fresh.getByRole('button', { name: TEXT.close, exact: true }).click();
  await expect(fresh).toHaveCount(0);
  const strength = page.getByRole('form', { name: '簡易強度計算', exact: true });
  await strength.getByRole('button', { name: '計算を閉じる', exact: true }).click();
  await expect(strength).toHaveCount(0);

  // Reopen the saved file: the typed input comes back with the chosen method, without any result, as saved.
  await openSaveFlowFile(page, path, app);
  const reopened = await openLocalCycle(page);
  await expect(field(reopened, 'correction')).toHaveValue('morrow');
  await expect(field(reopened, 'derivation')).toHaveValue('elastic-plastic-analysis');
  await expect(field(reopened, 'stressMin')).toHaveValue('-100');
  await expect(field(reopened, 'elasticModulusMpa')).toHaveValue('200000');
  await expect(reopened.getByTestId('fatigue-local-cycle-result')).toHaveCount(0);
  await expect(reopened.getByTestId('fatigue-local-cycle-saved')).toHaveText(TEXT.saved);
  await run(reopened);
  await expectLife(reopened, LIFE_N);
}
