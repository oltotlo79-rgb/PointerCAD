import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readPcadFile } from '../../packages/io/src/index.js';
import { fileAction } from './fileCaptureSupport.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';

/*
 * Paired strain/stress histories through the ordinary public controls of the strain-life panel, in the real web host and
 * in real Electron. Only clicks, typing and the existing file save/open paths are used; nothing writes the store.
 *
 * Expectation, derived by hand and independent of the product: manufactured, test-only coefficients (not a real
 * material) b = c = -0.5, sigma_f' = 1000 MPa, E = 200000 MPa, eps_f' = 0.995. With the existing Morrow elastic term
 * eps_a = ((sigma_f' - sigma_m) / E + eps_f') (2N) ** -0.5. The typed samples (0 s, -2u, -100 MPa) and (0.5 s, 2u,
 * 300 MPa), u = 2 ** -8, repeated 10 times, are cycles of amplitude 2u = 1 / 128 whose paired reversal stresses give
 * sigma_m = 100 MPa: (1000 - 100) / 200000 + 0.995 = 0.9995, N = 8192 * 0.9995 ** 2 cycles, damage 10 / N and the
 * input can be applied N / 10 times. The stresses are typed values; nothing computes a stress from a strain.
 *
 * The analysis is synchronous: there is no Cancel button to press. Closing the panel and replacing the document are
 * the contract under which a result disappears, and both are exercised here, as are edits and a change of kind.
 */
const u = 2 ** -8;
const LIFE_N = 8192 * 0.9995 ** 2;
const SAMPLES = `0 ${-2 * u} -100\n0.5 ${2 * u} 300`;
/** Texts copied from the Japanese strain-life message table (ja/fatigueStrain.json) of this packet; this spec cannot import that table. */
const TEXT = {
  open: 'ひずみ寿命の入力を開く',
  samplesFormat: '形式: 「0 -0.0078 -100」のように3つの数を空白かコンマで区切ります。時刻は行ごとに増やしてください。単位は書きません。',
  pairedNote: '平均応力は、入力した応力のうち、ひずみが折り返す時点の値から求めます。ひずみから応力を計算することはしません。',
  applicabilityPaired: '平均応力: 各サイクルの折り返し点の応力の平均を、Morrow の補正で使いました。',
  sampleLine: '標本の行は、時刻 [s]・全ひずみ [-]・応力 [MPa] の3つの数にしてください。場所の samples[k] は k+1 行目です。',
  input: '入力が範囲や形に合いません。場所の欄を直してください。',
  saved: '保存済みの入力と同じです。',
  close: '閉じる',
} as const;

async function openStrength(page: Page): Promise<void> {
  // The same public route as strengthFlow.ts (openStrength there is module-private).
  await page.getByRole('button', { name: /^見た目/u }).click();
  await page.getByRole('group', { name: '見た目', exact: true }).getByRole('button', { name: '簡易強度計算', exact: true }).click();
}
async function openStrainLife(page: Page): Promise<Locator> {
  await openStrength(page);
  const strength = page.getByRole('form', { name: '簡易強度計算', exact: true });
  await strength.getByTestId('fatigue-strain-open').click();
  const panel = page.getByTestId('fatigue-strain-panel');
  await expect(panel).toBeVisible();
  return panel;
}
const field = (panel: Locator, name: string): Locator => panel.locator(`[data-fatigue-strain-field="${name}"]`);
/**
 * The toolbar history buttons (shell/Toolbar.tsx 277-307: role group 「履歴」, aria-label 「元に戻す」/「やり直す」, aria-disabled
 * while unavailable; commandRegistry.ts runs the store undo/redo only when canUndo/canRedo). Scoped to that group because the
 * radial menu also offers history.undo (task177).
 */
async function clickHistory(page: Page, name: '元に戻す' | 'やり直す'): Promise<void> {
  const button = page.getByRole('group', { name: '履歴', exact: true }).getByRole('button', { name, exact: true });
  await expect(button).toHaveAttribute('aria-disabled', 'false');
  await button.click();
}
/** The displayed number (9 significant digits) agrees with the hand-derived value to a relative 1e-8. */
async function expectNumber(locator: Locator, expected: number): Promise<void> {
  await expect.poll(async () => Math.abs(Number(await locator.textContent()) - expected) / expected).toBeLessThan(1e-8);
}
async function run(panel: Locator): Promise<void> {
  await panel.getByTestId('fatigue-strain-run').click();
}
async function expectRefusal(panel: Locator, message: string, code: string | null, path: string): Promise<void> {
  const refusal = panel.getByTestId('fatigue-strain-refusal');
  await expect(refusal).toContainText(message);
  if (code !== null) await expect(refusal.locator('code').first()).toHaveText(code);
  await expect(refusal.locator('code').last()).toHaveText(path);
  await expect(panel.getByTestId('fatigue-strain-result')).toHaveCount(0);
}
async function expectPairedResult(panel: Locator, repeats: number): Promise<void> {
  await expect(panel.getByTestId('fatigue-strain-refusal')).toHaveCount(0);
  await expect(panel.getByTestId('fatigue-strain-result')).toBeVisible();
  await expectNumber(panel.getByTestId('fatigue-strain-damage'), repeats / LIFE_N);
  await expectNumber(panel.getByTestId('fatigue-strain-life'), LIFE_N / repeats);
  await expectNumber(panel.getByTestId('fatigue-strain-minimum-life'), LIFE_N);
  const applicability = panel.getByTestId('fatigue-strain-applicability');
  await expect(applicability).toHaveAttribute('data-mean-stress', 'morrow-paired-reversal-stress');
  await expect(applicability).toHaveText(TEXT.applicabilityPaired);
  await expect(panel.getByTestId('fatigue-strain-mean-stress-h1')).toHaveText('100 〜 100');
}

export async function fatigueStrainPairedFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Browser flows exercise download/file-input; Electron retains its native save/open gateway.
  if (app === undefined) {
    await page.evaluate(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    });
  }
  await expect(fileAction(page, '開く')).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof window.pcadRecomputeStats)).toBe('function');
  const panel = await openStrainLife(page);

  // Material coefficients typed as a user would.
  for (const [name, value] of [['materialId', 'manufactured'], ['elasticModulusMpa', '200000'],
    ['fatigueStrengthCoefficientMpa', '1000'], ['fatigueStrengthExponent', '-0.5'], ['fatigueDuctilityCoefficient', '0.995'],
    ['fatigueDuctilityExponent', '-0.5'], ['minimumCycles', '1'], ['maximumCycles', '1000000'],
    ['materialReference', 'Test-only manufactured coefficients; not a material value'],
    ['materialCondition', 'Hand-derived example']] as const) await field(panel, name).fill(value);

  // The paired kind: the zero-mean statement disappears, the sample field shows its units and format.
  await expect(field(panel, 'historyKind')).toHaveValue('strain-only');
  await field(panel, 'historyKind').selectOption('paired-stress');
  await expect(panel.locator('input[type="checkbox"]')).toHaveCount(0);
  await expect(panel.getByTestId('fatigue-strain-paired-note')).toHaveText(TEXT.pairedNote);
  await expect(panel.getByTestId('fatigue-strain-samples-format-0')).toHaveText(TEXT.samplesFormat);
  await expect(field(panel, 'histories[0].strain')).toHaveCount(0);
  await field(panel, 'histories[0].id').fill('h1');
  await field(panel, 'histories[0].derivation').selectOption('elastic-plastic-analysis');
  await field(panel, 'histories[0].sequence').selectOption('repeated-periodic');
  await field(panel, 'histories[0].repeats').fill('10');
  await field(panel, 'histories[0].reference').fill('Test-only paired history');
  await field(panel, 'histories[0].condition').fill('Hand-derived example');
  const samples = field(panel, 'histories[0].samples');

  // Refusals with their message and the failing sample: a typed unit, a repeated time, a stress in Pa.
  await samples.fill(`0 ${-2 * u} -100MPa\n0.5 ${2 * u} 300`);
  await run(panel);
  await expectRefusal(panel, TEXT.sampleLine, null, 'histories[0].samples[0]');
  await expect(samples).toHaveAttribute('aria-invalid', 'true');
  await samples.fill(`0 ${-2 * u} -100\n0 ${2 * u} 300`);
  await run(panel);
  await expectRefusal(panel, TEXT.input, 'fatigue-strain', 'histories[0].samples[1].timeSeconds');
  await samples.fill(`0 ${-2 * u} -100e6\n0.5 ${2 * u} 300`);
  await run(panel);
  await expectRefusal(panel, TEXT.input, 'fatigue-strain', 'histories[0].samples[0].stressMpa');

  // The valid paired input gives the hand-derived Morrow damage and states its applicability.
  await samples.fill(SAMPLES);
  await expect(panel.getByTestId('fatigue-strain-refusal')).toHaveCount(0);
  await run(panel);
  await expectPairedResult(panel, 10);

  // An edit drops the result at once; running again gives the result of the new input only.
  await field(panel, 'histories[0].repeats').fill('20');
  await expect(panel.getByTestId('fatigue-strain-result')).toHaveCount(0);
  await run(panel);
  await expectPairedResult(panel, 20);
  await field(panel, 'histories[0].repeats').fill('10');
  await expect(panel.getByTestId('fatigue-strain-result')).toHaveCount(0);

  // A change of kind drops the result; going back keeps the typed samples but never brings an old result back.
  await run(panel);
  await expectPairedResult(panel, 10);
  await field(panel, 'historyKind').selectOption('strain-only');
  await expect(panel.getByTestId('fatigue-strain-result')).toHaveCount(0);
  await expect(field(panel, 'meanStress')).not.toBeChecked();
  await field(panel, 'historyKind').selectOption('paired-stress');
  await expect(samples).toHaveValue(SAMPLES);
  await expect(panel.getByTestId('fatigue-strain-result')).toHaveCount(0);
  await run(panel);
  await expectPairedResult(panel, 10);

  // Save the input into the document, then the document to a file through the existing save path.
  await panel.getByTestId('fatigue-strain-save').click();
  await expect(panel.getByTestId('fatigue-strain-saved')).toHaveText(TEXT.saved);
  // Saving is one Undo step of the document (fatigueStrainSlice.ts 57-58): Undo removes the saved input while the typed
  // samples stay in the panel, Redo brings the same saved input back (the panel derives the mark from the document).
  await clickHistory(page, '元に戻す');
  await expect(panel.getByTestId('fatigue-strain-saved')).toHaveCount(0);
  await expect(samples).toHaveValue(SAMPLES);
  await clickHistory(page, 'やり直す');
  await expect(panel.getByTestId('fatigue-strain-saved')).toHaveText(TEXT.saved);
  const path = info.outputPath('fatigue-paired.pcad');
  const read = readPcadFile(new Uint8Array(await saveFlowFile(page, path, app)));
  if (!read.ok) throw new Error(read.error.message);
  const saved = read.document.beamAnalysisInputs?.analyses.find(input => input.kind === 'fatigue-strain-life');
  const definition = saved?.kind === 'fatigue-strain-life' ? saved.definition : null;
  expect(definition?.schema).toBe('pointercad-fatigue-strain-stress-saved/1');
  expect(definition?.input.meanStress).toBe('morrow-paired-reversal-stress');
  expect(definition?.schema === 'pointercad-fatigue-strain-stress-saved/1' ? definition.input.histories[0]?.samples : null)
    .toEqual([{ timeSeconds: 0, strain: -2 * u, stressMpa: -100 }, { timeSeconds: 0.5, strain: 2 * u, stressMpa: 300 }]);
  expect(JSON.stringify(read.document.beamAnalysisInputs)).not.toMatch(/"(?:damage|life|cycles|cyclesToFailure|meanStressMpa|result)"/u);

  // Replacing the document closes the panel with its result; a fresh panel has no input and no result.
  await fileAction(page, '新規').click();
  await expect(panel).toHaveCount(0);
  const fresh = await openStrainLife(page);
  await expect(field(fresh, 'historyKind')).toHaveValue('strain-only');
  await expect(field(fresh, 'elasticModulusMpa')).toHaveValue('');
  await expect(fresh.getByTestId('fatigue-strain-result')).toHaveCount(0);
  await fresh.getByRole('button', { name: TEXT.close, exact: true }).click();
  await expect(fresh).toHaveCount(0);
  // Closing the strain-life panel returns to the strength form; close it too so the next route starts from a closed panel.
  const strength = page.getByRole('form', { name: '簡易強度計算', exact: true });
  await strength.getByRole('button', { name: '計算を閉じる', exact: true }).click();
  await expect(strength).toHaveCount(0);

  // Reopen the saved file: the exact typed data comes back as the paired kind, without any result.
  await openSaveFlowFile(page, path, app);
  const reopened = await openStrainLife(page);
  await expect(field(reopened, 'historyKind')).toHaveValue('paired-stress');
  await expect(field(reopened, 'histories[0].samples')).toHaveValue(SAMPLES);
  await expect(field(reopened, 'histories[0].repeats')).toHaveValue('10');
  await expect(field(reopened, 'histories[0].derivation')).toHaveValue('elastic-plastic-analysis');
  await expect(field(reopened, 'elasticModulusMpa')).toHaveValue('200000');
  await expect(reopened.getByTestId('fatigue-strain-result')).toHaveCount(0);
  await expect(reopened.getByTestId('fatigue-strain-saved')).toHaveText(TEXT.saved);
  await run(reopened);
  await expectPairedResult(reopened, 10);
}
