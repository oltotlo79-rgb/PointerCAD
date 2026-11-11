/// <reference lib="dom" />
import { readFile, writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { readDocumentBundle, writeDocumentBundle } from '../../packages/io/src/index.js';
import {
  addComponent, createAssemblyDocument, createAssemblyDocumentBundle, createComponentFor, EMPTY_PART_LIBRARY,
  type AssemblyDocument,
} from '../../packages/model/src/index.js';
import type { StandardBeamImpactDefinition } from '../../packages/model/src/analysis/beamInputs.js';
import { testComponent, testMember, testPlacement, TEST_EVIDENCE } from '../../packages/model/src/analysis/beamInputs.testSupport.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { componentRows } from './boltedJointTestSupport.js';
import { waitForSettledRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';

/*
 * 衝撃(弾性・摩擦なし・固定面)の画面検査の共通の試料と流れ(task171。task170 の impact-browser.spec.ts 8c337942 の
 * 流れをそのまま分けた)。Web(Chromium・Firefox)は impact-browser.spec.ts、Electron は electron-impact.spec.ts が呼ぶ。
 * 開く・保存は saveResponsivenessFlow.ts の openSaveFlowFile・saveFlowFile。app を渡すと Electron の native の
 * ダイアログ(electronAppFlow.ts openTarget・saveTarget)、渡さないと Web の file chooser と download を使う。
 *
 * 形は製品の規格の平鋼 SS400 FB 50×6、長さ 2000 の 1 本(beamInputs.testSupport.ts の testComponent)。部材の軸 +z、
 * 断面の幅 50 は x、板厚 6 は y(testMember の principalY = [1, 0, 0])。根元 a-base を 6 自由度とも止め、先端
 * a-tip が −y へ 2 m/s で動き、先端から −y へ 0.5 mm の固定面へ向かう(面の向きは節点から面へ [0, −1, 0])。
 * 材料・断面は溶接の層の画面検査と同じ試験値(E 208000、ρ 7850、A 300、弱軸 I 900)で、製品の材料の値ではない。
 *
 * 独立した期待(ソルバーの値を写さない):
 *   - 計算の長さは 200 歩 × 0.01 ms = 2 ms(入力から決まる)。
 *   - 当たる: 先端が 0.5 mm を自由に進む時間は 0.5 mm / 2 m/s = 0.25 ms で 2 ms より短い。根元を止めた片持ちの
 *     先端の振れ幅は v/ω(片持ちのばね 3EI/L³ ≈ 70 N/m、動く質量は全体 4.7 kg の一部)で 0.5 mm よりずっと大きく、
 *     戻る前に面へ届く。そのため接触の最大の力と力積は正。面は弾性の罰則接触なので、記録した隙間の最小は負(めり込み)。
 *   - 非認証の注記は常に出る(BeamImpactResults.tsx 12)。
 *   - 出力の間隔 201 は歩数 200 を超え、計算側(fem beamImpactTranslation.ts readHistory)が必ず拒む。確かめは
 *     断られ、入力は打った値のまま残り、計算も適用もできない(beamSlice.ts reviewBeam 61〜70、BeamPanel.tsx 144・148)。
 *     task167 の保存の読取の直しを組み込んだ後は、拒否の理由が impact-history になるが、画面に見えることは同じ。
 *   - 適用して保存した入力には結果が無く、開き直すと同じ入力が戻り、結果は計算し直すまで無い。
 * 時間: 1 件の上限は設定の既定 180 秒(playwright.config.ts 40 行)のまま。実計算は 2 回で、各回の結果の待ちは
 * 溶接の層の画面検査(実計算 3 回)と同じ 120 秒を上限にする。上限を延ばさない。
 */

export const IMPACT_RESULT_TIMEOUT_MS = 120_000;
const HISTORY = { stepCount: '200', validEvery: '2', rejectedEvery: '201' } as const;

/** 規格の平鋼 1 本と、根元固定・先端速度・固定面 1 枚の保存した衝撃の入力(版 6、beamImpactInput.test.ts と同じ形)。 */
export async function cantileverWithImpactInputs(): Promise<Uint8Array> {
  let document: AssemblyDocument = createAssemblyDocument('衝撃');
  const bar = createComponentFor(document, testComponent('a', '2000').source, { name: 'a', placement: testPlacement([0, 0, 0]) });
  document = addComponent(document, bar);
  const saved = document.components.find(component => component.id === bar.id);
  if (saved === undefined) throw new Error('bar missing');
  const definition: StandardBeamImpactDefinition = {
    schema: 'pointercad-standard-beam/6', id: 'impact', revision: 1,
    source: { documentId: document.id, documentRevision: 1, geometryRevision: 'browser-impact' }, units: 'N-mm',
    members: [testMember(saved, [saved.id], 'a-')],
    materials: [{ id: 'elastic', youngModulus: 208000, shearModulus: 80000, densityKgM3: 7850, source: TEST_EVIDENCE }],
    sections: [{ id: 'rectangle', area: 300, iy: 900, iz: 62500, torsionConstant: 3300, shearFactor: 5 / 6, source: TEST_EVIDENCE }],
    supports: [{ nodeId: 'a-base', restrained: [true, true, true, true, true, true] }],
    impact: { segmentsPerMember: 8, initialVelocities: [{ nodeId: 'a-tip', velocityMPerS: [0, -2, 0] }],
      planes: [{ id: 'stop', nodeId: 'a-tip', normal: [0, -1, 0], gapMm: 0.5 }],
      contactStiffnessNPerM: 1e7, history: { timeStepS: 1e-5, stepCount: 200, outputEvery: 2 } },
  };
  const next: AssemblyDocument = { ...document,
    beamAnalysisInputs: { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition }] } };
  return writeDocumentBundle(createAssemblyDocumentBundle(next, EMPTY_PART_LIBRARY));
}

function beamPanel(page: Page): Locator {
  return page.getByTestId('beam-panel');
}

/** weld-layer-browser.spec.ts の openBeamPanel と同じ開き方。保存した版 6 から衝撃の画面で戻る。 */
async function openBeamPanel(page: Page): Promise<void> {
  if (await beamPanel(page).count() > 0) {
    await beamPanel(page).getByTestId('beam-close').click();
    await expect(beamPanel(page)).toHaveCount(0);
  }
  if (await page.getByTestId('beam-open').count() === 0) await chooseToolMenuItem(page, '見た目', '簡易強度計算');
  await page.getByTestId('beam-open').click();
  await expect(beamPanel(page)).toBeVisible();
  await expect(beamPanel(page).getByTestId('beam-analysis-type')).toHaveValue('impact');
}

/** 開いた部材の断面の向きは確認し直す(restoreBeamSession は確認を戻さない)。 */
async function confirmMember(page: Page): Promise<void> {
  const boxes = beamPanel(page).locator('input[data-beam-confirm]');
  await expect(boxes).toHaveCount(1);
  await boxes.nth(0).check();
}

/** 衝撃の履歴の欄(BeamImpactDefinitions.tsx 97〜100 の data-beam-impact-field の中の式の欄)。 */
function historyInput(page: Page, name: 'stepCount' | 'outputEvery'): Locator {
  return beamPanel(page).locator(`[data-beam-impact-field="impact:${name}"] input.pcad-field__input`);
}

function shownNumber(text: string | null): number {
  return Number((text ?? 'NaN').replaceAll(',', ''));
}

/** 確かめて実計算し、入力から決まる期待だけで結果を見る。 */
async function runAndCheck(page: Page): Promise<void> {
  await beamPanel(page).getByTestId('beam-review').click();
  await expect(beamPanel(page).getByTestId('beam-run')).toBeEnabled();
  await beamPanel(page).getByTestId('beam-run').click();
  const results = beamPanel(page).getByTestId('beam-impact-results');
  await expect(results).toBeVisible({ timeout: IMPACT_RESULT_TIMEOUT_MS });
  await expect(results.getByTestId('beam-impact-not-certified')).toBeVisible();
  expect(shownNumber(await results.locator('[data-beam-impact-value="duration"]').textContent())).toBeCloseTo(2, 9);
  const row = results.locator('tr[data-beam-impact-contact="a-tip"]').locator('td');
  await expect(row).toHaveCount(5);
  expect(shownNumber(await row.nth(1).textContent())).toBeGreaterThan(0);
  expect(shownNumber(await row.nth(3).textContent())).toBeGreaterThan(0);
  expect(shownNumber(await row.nth(4).textContent())).toBeLessThan(0);
}

/** 製品の保存で落としたファイルの衝撃の入力。 */
async function savedImpact(path: string): Promise<StandardBeamImpactDefinition['impact']> {
  const read = await readDocumentBundle(await readFile(path), 'assembly');
  if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('saved assembly did not decode');
  const analysis = read.bundle.document.beamAnalysisInputs?.analyses[0];
  if (analysis?.kind !== 'standard-members' || analysis.definition.schema !== 'pointercad-standard-beam/6') {
    throw new Error('saved impact beam inputs missing');
  }
  expect(JSON.stringify(analysis.definition)).not.toMatch(/"(?:samples|contactPeaks|energyJ|gapM|directionUnit)"/u);
  return analysis.definition.impact;
}

/**
 * 断られた入力を残して直し、実計算し、適用・保存・開き直しで入力が戻り結果は計算し直すまで無い。
 * pathFor は各環境の残るファイルの置き場所(Web は info.outputPath、Electron は launchDesktop の native)。
 */
export async function impactLifecycleFlow(page: Page, pathFor: (name: string) => string, app?: ElectronApplication): Promise<void> {
  // 1) 保存した衝撃の入力を持つ組立を製品の「開く」で開き、梁の画面を開く。保存した値が欄に戻る。
  const presetPath = pathFor('impact-inputs.pcada');
  await writeFile(presetPath, await cantileverWithImpactInputs());
  await openSaveFlowFile(page, presetPath, app);
  await expect(componentRows(page)).toHaveCount(1);
  await openBeamPanel(page);
  await expect(historyInput(page, 'stepCount')).toHaveValue(HISTORY.stepCount);
  await expect(historyInput(page, 'outputEvery')).toHaveValue(HISTORY.validEvery);
  await expect(beamPanel(page).getByTestId('beam-impact-results')).toHaveCount(0);
  await confirmMember(page);

  // 2) 出力の間隔を歩数より長い 201 にすると確かめが断る。打った値は残り、計算も適用もできない。
  await historyInput(page, 'outputEvery').fill(HISTORY.rejectedEvery);
  await beamPanel(page).getByTestId('beam-review').click();
  await expect(beamPanel(page).getByRole('alert')).toBeVisible();
  await expect(beamPanel(page).getByTestId('beam-run')).toBeDisabled();
  await expect(beamPanel(page).getByTestId('beam-apply')).toBeDisabled();
  await expect(historyInput(page, 'outputEvery')).toHaveValue(HISTORY.rejectedEvery);
  await expect(historyInput(page, 'stepCount')).toHaveValue(HISTORY.stepCount);
  await expect(beamPanel(page).getByTestId('beam-impact-results')).toHaveCount(0);

  // 3) その欄だけを 2 に直すと、ほかを打ち直さずに確かめが通り、実計算の結果が出る(実計算 1 回目)。
  await historyInput(page, 'outputEvery').fill(HISTORY.validEvery);
  await runAndCheck(page);

  // 4) 適用して保存すると、入力した履歴があり結果は無い。
  await beamPanel(page).getByTestId('beam-review').click();
  await expect(beamPanel(page).getByTestId('beam-apply')).toBeEnabled();
  await beamPanel(page).getByTestId('beam-apply').click();
  await waitForSettledRecompute(page);
  const appliedPath = pathFor('impact-applied.pcada');
  await saveFlowFile(page, appliedPath, app);
  const applied = await savedImpact(appliedPath);
  expect(applied.history).toEqual({ timeStepS: 1e-5, stepCount: 200, outputEvery: 2 });
  expect(applied.planes).toEqual([{ id: 'stop', nodeId: 'a-tip', normal: [0, -1, 0], gapMm: 0.5 }]);

  // 5) 開き直すと同じ入力が戻り、結果は無い。部材を確認し直して計算すると同じ期待を満たす(実計算 2 回目)。
  await openSaveFlowFile(page, appliedPath, app);
  await expect(componentRows(page)).toHaveCount(1);
  await openBeamPanel(page);
  await expect(historyInput(page, 'outputEvery')).toHaveValue(HISTORY.validEvery);
  await expect(beamPanel(page).getByTestId('beam-impact-results')).toHaveCount(0);
  await confirmMember(page);
  await runAndCheck(page);
}
