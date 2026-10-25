/// <reference lib="dom" />
import { readFile, writeFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { readDocumentBundle, writeDocumentBundle } from '../../packages/io/src/index.js';
import {
  addComponent, createAssemblyDocument, createAssemblyDocumentBundle, createComponentFor, EMPTY_PART_LIBRARY,
  type AssemblyComponent, type AssemblyDocument,
} from '../../packages/model/src/index.js';
import type { StandardBeamContactDefinition } from '../../packages/model/src/analysis/beamInputs.js';
import { testComponent, testMember, testPlacement, TEST_EVIDENCE } from '../../packages/model/src/analysis/beamInputs.testSupport.js';
import { chooseToolMenuItem, readAssemblyStats, resetAssemblyFileGateway } from './assemblyTestSupport.js';
import { clickWorldPointChecked, componentRows, disableFilePickers, goHome, statusText } from './boltedJointTestSupport.js';
import { beginRecompute, waitForRecompute, waitForSettledRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { uiMessage } from './uiMessages.js';

/*
 * 溶接の層(有限の弾性ののど)の画面検査。形は製品の規格の平鋼 SS400 FB 50×6 の 2 本(長さ 20)。配置の窓は回転を
 * 持たないので、文書は model の公開 API で置く。ビードは製品のすみ肉溶接の窓で、ビューの面・辺・面を押して作る。
 * 梁の入力のうち材料・断面・支点・荷重・止めだけを model の型で保存し、溶接の層の行は梁の画面で入力する。
 *
 *   a(立つ材): 位置 (0,20,6)、回転なし → x 0〜50, y 20〜26, z 6〜26。部材の軸 +z、a-base は z=6。
 *   b(寝る材): 位置 (30,20,0)、X 軸まわり +90° → x 30〜80, y 0〜20, z 0〜6。部材の軸 −y、b-base は y=20。
 *   ビードの根は線 y=20, z=6 で、両部材の端の断面の上にある(cadWeldLayer.ts 89〜91 の weld-section の条件)。
 *
 * 辺の選び方(attachAssemblyInteraction.ts 102〜115、pickSubShape.ts 128〜150): 辺は画面の距離だけで選び、
 * 隠れた辺も候補になる。半径内に頂点があれば頂点を返し、溶接の 2 つ目(辺)には足されない。部品をまたいで同じ
 * 距離なら文書の前の部品が残る。a と b の辺は x 30〜50 で重なるので、そこを押すと距離の丸めで持ち主が決まる。
 * そこで b を x 30 へずらし、a の辺だけがある x 15(a の頂点 x 0 と b の頂点 x 30 から 15 mm、
 * filletWeldFlow.ts の「頂点から 10 mm 以上」と同じ考え)を押す。同じ部品の後ろの辺(y=26)は距離が 0 でない。
 *
 * 溶接線: 面の法線 (0,−1,0) × (0,0,1) = (−1,0,0)。重なりの端 x 50 から −x へ、連続で始点 5・長さ 10
 * (x 45〜35、重なり x 30〜50 の中)。脚 3(b の上)/ 4(a の面)、アルミ。予告: 脚長 3 / 4、ビード 1、合計 10、
 * 体積 3 × 4 / 2 × 10 = 60。のどの高さ 3·4/5 = 2.4 ≥ 有効のど 2。
 *
 * 独立した期待(ソルバーの値を写さない):
 *   - 層の両端の力は作用・反作用: 各状態・各軸で forceOnAN = −forceOnBN(製品の検査と同じ相対 1e-9)。
 *   - 荷重の係数 [1, −1]: 止めの隙間 10 mm は 1 N での動きよりずっと大きく開いたままなので、状態 2 = −状態 1、
 *     弾性エネルギーは等しく正。
 *   - のど厚の編集で結果が消える(BeamWeldLayers.tsx の editBeam、beamWeldLayer.test.ts の edit の場合)。この
 *     欄の編集はセッションの編集で、Undo の段には入らない。
 *   - 「適用」は組立の 1 回の編集(beamSlice.ts applyBeamInputs → applyAssembly)。開き直す前の同じ文書で、
 *     元に戻す 1 回で保存した入力から溶接の層が消え、やり直すで戻る。部品の配置はどちらでも変わらない。
 *   - 保存・開き直しで同じ行が戻り、結果は計算し直すまで無い。
 * 結果の待ちの 120 秒は、この新しい実計算に対する検査の上限で、製品の性能の保証ではない。
 */

const ROOT_Y = 20;
const ROOT_Z = 6;
const B_SHIFT = 30;
const HALF = Math.SQRT1_2;
const PICK = {
  /** a の −Y の面の中ほど。視線は +Z へ上がるので b(z ≤ 6)に遮られない。 */
  firstFace: [25, ROOT_Y, 16] as const,
  /** a の下の辺の、b と重ならない所(a の頂点 x 0 と b の頂点 x 30 から 15 mm)。 */
  edge: [15, ROOT_Y, ROOT_Z] as const,
  /** b の上面の、a より手前。 */
  secondFace: [55, 10, ROOT_Z] as const,
} as const;
const WELD = { legOnSecond: '3', legOnFirst: '4', start: '5', length: '10', material: 'aluminum' } as const;
const LAYER = { youngMPa: '1000', poisson: '0.25', throat: '2', compliance: '1',
  reference: 'Browser acceptance elastic layer constants', condition: 'Linear isotropic layer; no capacity claim' } as const;
const RELATIVE = 1e-9;
const RESULT_TIMEOUT_MS = 120_000;
const TITLE = uiMessage('assembly', 'assembly.filletWeld.title');
const STEP_EDGE = uiMessage('assembly', 'assembly.status.filletWeldStep')
  .replace('{count}', '2').replace('{total}', '3').replace('{next}', uiMessage('assembly', 'assembly.filletWeld.pickEdge'));
const STEP_SECOND = uiMessage('assembly', 'assembly.status.filletWeldStep')
  .replace('{count}', '3').replace('{total}', '3').replace('{next}', uiMessage('assembly', 'assembly.filletWeld.pickSecondFace'));

function weldDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: TITLE, exact: true });
}

function weldField(page: Page, testId: string): Locator {
  return weldDialog(page).getByTestId(testId);
}

/** 規格の平鋼 2 本だけの組立(ビードと梁の入力はまだ無い)。 */
async function flatBarAssembly(): Promise<{ bytes: Uint8Array; a: AssemblyComponent; b: AssemblyComponent }> {
  let document: AssemblyDocument = createAssemblyDocument('溶接の層');
  const a = createComponentFor(document, testComponent('a', '20').source,
    { name: 'a', placement: testPlacement([0, ROOT_Y, ROOT_Z]) });
  document = addComponent(document, a);
  const b = createComponentFor(document, testComponent('b', '20').source,
    { name: 'b', placement: testPlacement([B_SHIFT, ROOT_Y, 0], [HALF, 0, 0, HALF]) });
  document = addComponent(document, b);
  const bytes = await writeDocumentBundle(createAssemblyDocumentBundle(document, EMPTY_PART_LIBRARY));
  return { bytes, a, b };
}

/**
 * 製品で保存した組立へ、梁の入力のうち材料・断面・支点・荷重・止めだけを足す(溶接の層の行は足さない)。
 * 版 5 の形は cadWeldLayer.testSupport.ts の定義と同じ。source の印は開いた後の reviewBeam が今の形で作り直す。
 */
async function withBeamInputs(path: string, a: AssemblyComponent, b: AssemblyComponent): Promise<Uint8Array> {
  const read = await readDocumentBundle(await readFile(path), 'assembly');
  if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('saved welded assembly did not decode');
  const document = read.bundle.document;
  expect(document.beamAnalysisInputs).toBeUndefined();
  const saved = (id: string): AssemblyComponent => {
    const found = document.components.find(component => component.id === id);
    if (found === undefined) throw new Error(`saved member ${id} missing`);
    return found;
  };
  const stamp = { documentId: document.id, documentRevision: 1, geometryRevision: 'browser-weld-layer' };
  const definition: StandardBeamContactDefinition = {
    schema: 'pointercad-standard-beam/5', id: 'weld-contact', revision: 1, source: stamp, units: 'N-mm',
    members: [testMember(saved(a.id), [a.id], 'a-'), testMember(saved(b.id), [b.id], 'b-')],
    materials: [{ id: 'elastic', youngModulus: 208000, shearModulus: 80000, densityKgM3: 7850, source: TEST_EVIDENCE }],
    sections: [{ id: 'rectangle', area: 300, iy: 900, iz: 62500, torsionConstant: 3300, shearFactor: 5 / 6, source: TEST_EVIDENCE }],
    supports: [{ nodeId: 'a-tip', restrained: [true, true, true, true, true, true] },
      { nodeId: 'b-tip', restrained: [true, true, true, true, true, true] }],
    referenceLoads: [{ id: 'force', kind: 'nodal', nodeId: 'a-base', force: [0, 0, 1], moment: [0, 0, 0] }],
    contact: { segmentsPerMember: 1, contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'b-base', normal: [0, 0, 1], gapMm: 10 }],
      loadFactors: [1, -1] },
  };
  const next: AssemblyDocument = { ...document,
    beamAnalysisInputs: { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition }] } };
  return writeDocumentBundle({ ...read.bundle, document: next });
}

/** 製品のすみ肉溶接の窓で、a の面・a の辺・b の面を押して 1 本のビードを作る。各段で状態欄の数が進む。 */
async function weldThroughDialog(page: Page): Promise<void> {
  await chooseToolMenuItem(page, '組む', TITLE);
  await expect(weldDialog(page)).toBeVisible();
  await clickWorldPointChecked(page, [...PICK.firstFace]);
  await expect(statusText(page)).toHaveText(STEP_EDGE);
  await clickWorldPointChecked(page, [...PICK.edge]);
  await expect(statusText(page)).toHaveText(STEP_SECOND);
  await clickWorldPointChecked(page, [...PICK.secondFace]);
  await expect(statusText(page)).not.toContainText('/3:');
  await expect(weldField(page, 'fillet-weld-prompt')).toHaveText(uiMessage('assembly', 'assembly.filletWeld.picked'));
  await weldField(page, 'fillet-weld-leg-second').fill(WELD.legOnSecond);
  await weldField(page, 'fillet-weld-leg-first').fill(WELD.legOnFirst);
  await weldField(page, 'fillet-weld-mode').selectOption('continuous');
  await weldField(page, 'fillet-weld-start').fill(WELD.start);
  await weldField(page, 'fillet-weld-lengths').fill(WELD.length);
  await weldField(page, 'fillet-weld-material').selectOption(WELD.material);
  await expect(weldField(page, 'fillet-weld-legs')).toHaveText(`${uiMessage('assembly', 'assembly.filletWeld.legs')} 3 / 4`);
  await expect(weldField(page, 'fillet-weld-segments')).toHaveText(`${uiMessage('assembly', 'assembly.filletWeld.segmentCount')} 1`);
  await expect(weldField(page, 'fillet-weld-total')).toHaveText(`${uiMessage('assembly', 'assembly.filletWeld.totalLength')} 10`);
  await expect(weldField(page, 'fillet-weld-volume')).toHaveText(`${uiMessage('assembly', 'assembly.filletWeld.nominalVolume')} 60`);
  await expect(weldField(page, 'fillet-weld-commit')).toBeEnabled();
  const token = await beginRecompute(page);
  await weldField(page, 'fillet-weld-commit').click();
  await expect(weldDialog(page)).toHaveCount(0);
  await waitForRecompute(page, token);
  await expect(componentRows(page)).toHaveCount(3);
}

function beamPanel(page: Page): Locator {
  return page.getByTestId('beam-panel');
}

/** 梁の画面を開き直す。開いていれば閉じてから開き、openBeam が保存した入力から戻す(beamSlice.ts 30〜43)。 */
async function openBeamPanel(page: Page): Promise<void> {
  if (await beamPanel(page).count() > 0) {
    await beamPanel(page).getByTestId('beam-close').click();
    await expect(beamPanel(page)).toHaveCount(0);
  }
  if (await page.getByTestId('beam-open').count() === 0) await chooseToolMenuItem(page, '見た目', '簡易強度計算');
  await page.getByTestId('beam-open').click();
  await expect(beamPanel(page)).toBeVisible();
  await expect(beamPanel(page).getByTestId('beam-analysis-type')).toHaveValue('contact');
}

function weldRow(page: Page): Locator {
  return beamPanel(page).getByTestId('beam-weld-layer-definitions').locator('fieldset[data-weld-layer]');
}

function throatInput(page: Page): Locator {
  return weldRow(page).locator('input[type="number"]').nth(2);
}

/** 梁の画面で溶接の層の行を足し、ビード・両端・定数・出どころを入力する(利用者の操作)。 */
async function enterWeldLayer(page: Page, beadName: string): Promise<void> {
  const definitions = beamPanel(page).getByTestId('beam-weld-layer-definitions');
  await expect(weldRow(page)).toHaveCount(0);
  await definitions.locator(':scope > button').click();
  await expect(weldRow(page)).toHaveCount(1);
  const selects = weldRow(page).locator('select');
  await selects.nth(0).selectOption({ label: beadName });
  await selects.nth(1).selectOption({ label: 'a / a-base' });
  await selects.nth(2).selectOption({ label: 'b / b-base' });
  const numbers = weldRow(page).locator('input[type="number"]');
  await numbers.nth(0).fill(LAYER.youngMPa);
  await numbers.nth(1).fill(LAYER.poisson);
  await numbers.nth(2).fill(LAYER.throat);
  await numbers.nth(3).fill(LAYER.compliance);
  const texts = weldRow(page).locator('input:not([type])');
  await texts.nth(0).fill(LAYER.reference);
  await texts.nth(1).fill(LAYER.condition);
}

/** 開いた部材の断面の向きは確認し直す(restoreBeamSession は確認を戻さない、beamWeldLayer.test.ts 42)。 */
async function confirmMembers(page: Page): Promise<void> {
  const boxes = beamPanel(page).locator('input[data-beam-confirm]');
  await expect(boxes).toHaveCount(2);
  for (let index = 0; index < 2; index += 1) await boxes.nth(index).check();
}

interface WeldState { readonly forceA: readonly number[]; readonly forceB: readonly number[]; readonly energy: number }

async function readState(page: Page): Promise<WeldState> {
  const results = beamPanel(page).getByTestId('beam-weld-layer-results');
  const values = async (key: string): Promise<number[]> =>
    (await results.locator(`td[data-quantity="${key}"]`).evaluateAll(cells =>
      cells.map(cell => cell.getAttribute('data-value') ?? 'NaN'))).map(Number);
  const energies = (await results.locator('p[data-unit="J"]').evaluateAll(rows =>
    rows.map(row => row.getAttribute('data-value') ?? 'NaN'))).map(Number);
  expect(energies).toHaveLength(1);
  return { forceA: await values('forceOnAN'), forceB: await values('forceOnBN'), energy: energies[0] ?? Number.NaN };
}

function expectRelative(actual: number, expected: number, scale: number): void {
  expect(Number.isFinite(actual)).toBe(true);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(RELATIVE * scale);
}

/** 確かめて実計算し、2 つの状態を独立した期待で比べる。 */
async function runAndCheck(page: Page): Promise<void> {
  await beamPanel(page).getByTestId('beam-review').click();
  await expect(beamPanel(page).getByTestId('beam-run')).toBeEnabled();
  await beamPanel(page).getByTestId('beam-run').click();
  const results = beamPanel(page).getByTestId('beam-weld-layer-results');
  await expect(results).toBeVisible({ timeout: RESULT_TIMEOUT_MS });
  const stateSelect = results.locator('select').first();
  await expect(stateSelect.locator('option')).toHaveCount(2);
  const first = await readState(page);
  await stateSelect.selectOption({ index: 1 });
  const second = await readState(page);
  for (const state of [first, second]) {
    expect(state.forceA).toHaveLength(3);
    expect(state.forceB).toHaveLength(3);
  }
  const scale = Math.max(...first.forceA.map(Math.abs), ...first.forceB.map(Math.abs));
  expect(scale).toBeGreaterThan(0);
  for (const state of [first, second]) {
    state.forceA.forEach((value, axis) => expectRelative(value, -(state.forceB[axis] ?? Number.NaN), scale));
  }
  first.forceA.forEach((value, axis) => expectRelative(second.forceA[axis] ?? Number.NaN, -value, scale));
  expect(first.energy).toBeGreaterThan(0);
  expectRelative(second.energy, first.energy, first.energy);
}

/** 製品の保存で落としたファイルの溶接の層の行。 */
async function savedWelds(path: string): Promise<readonly unknown[]> {
  const read = await readDocumentBundle(await readFile(path), 'assembly');
  if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('saved assembly did not decode');
  const analysis = read.bundle.document.beamAnalysisInputs?.analyses[0];
  if (analysis?.kind !== 'standard-members' || analysis.definition.schema !== 'pointercad-standard-beam/5') {
    throw new Error('saved contact beam inputs missing');
  }
  expect(analysis.definition.supports.map(support => support.nodeId)).toEqual(['a-tip', 'b-tip']);
  return analysis.definition.weldLayers?.welds ?? [];
}

async function clickHistory(page: Page, name: '元に戻す' | 'やり直す'): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click();
  await waitForSettledRecompute(page);
}

function resolvedPlacements(stats: Awaited<ReturnType<typeof readAssemblyStats>>): readonly unknown[] {
  return stats.components.map(component => component.resolved);
}

test.describe('溶接の層: 規格の平鋼の実形とすみ肉溶接の窓', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.afterEach(async ({ page }) => { await resetAssemblyFileGateway(page); });

  test('梁の画面で溶接の層を入力して実計算し、釣り合い・反転・無効化・適用の Undo/Redo・保存・開き直しを確かめる', async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await disableFilePickers(page);
    await page.goto('/');

    // 1) 規格の平鋼 2 本の組立を製品の「開く」で開き、ホーム視点で溶接の窓からビードを作る。
    const bars = await flatBarAssembly();
    const barsPath = info.outputPath('flat-bars.pcada');
    await writeFile(barsPath, bars.bytes);
    await openSaveFlowFile(page, barsPath);
    await expect(componentRows(page)).toHaveCount(2);
    await goHome(page);
    await weldThroughDialog(page);
    const welded = await readAssemblyStats(page);
    const bead = welded.components.find(component => component.id !== bars.a.id && component.id !== bars.b.id);
    if (bead === undefined) throw new Error('actual bead missing');

    // 2) 製品の保存の後、材料・断面・支点・荷重・止めだけを保存の形で足して開き直す。形と配置は同じ。
    const weldedPath = info.outputPath('welded.pcada');
    await saveFlowFile(page, weldedPath);
    const presetPath = info.outputPath('welded-inputs.pcada');
    await writeFile(presetPath, await withBeamInputs(weldedPath, bars.a, bars.b));
    await openSaveFlowFile(page, presetPath);
    await expect(componentRows(page)).toHaveCount(3);
    expect(resolvedPlacements(await readAssemblyStats(page))).toEqual(resolvedPlacements(welded));

    // 3) 梁の画面で溶接の層を入力し、ブラウザーの実計算の結果を独立した期待で確かめる。
    await openBeamPanel(page);
    await confirmMembers(page);
    await enterWeldLayer(page, bead.name);
    await runAndCheck(page);

    // 4) のど厚を変えると結果が消える。元の値に戻して計算し直すと同じ期待を満たす。
    await throatInput(page).fill('1.5');
    await expect(beamPanel(page).getByTestId('beam-weld-layer-results')).toHaveCount(0);
    await throatInput(page).fill(LAYER.throat);
    await runAndCheck(page);

    // 5) 適用は組立の 1 回の編集。保存すると入力した行がある。
    //    「適用」は確かめた入力だけを押せる(BeamPanel.tsx 137 の disabled={!reviewed || running})。
    const beforeApply = resolvedPlacements(await readAssemblyStats(page));
    await beamPanel(page).getByTestId('beam-review').click();
    await expect(beamPanel(page).getByTestId('beam-apply')).toBeEnabled();
    await beamPanel(page).getByTestId('beam-apply').click();
    await waitForSettledRecompute(page);
    const appliedPath = info.outputPath('applied.pcada');
    await saveFlowFile(page, appliedPath);
    const applied = await savedWelds(appliedPath);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ beadComponentId: bead.id, expectedMaterialId: WELD.material,
      first: { memberId: 'a-beam', nodeId: 'a-base' }, second: { memberId: 'b-beam', nodeId: 'b-base' },
      youngMPa: 1000, poisson: 0.25, effectiveThroatMm: 2, complianceLengthMm: 1,
      propertySource: { kind: 'user-supplied', reference: LAYER.reference, condition: LAYER.condition } });

    // 6) 開き直す前の同じ文書で、元に戻す 1 回 → 保存すると溶接の層が無い(材料・支点などの入力は残る)。
    //    やり直す → 保存すると同じ行が戻る。部品の配置はどちらでも変わらない。
    await clickHistory(page, '元に戻す');
    expect(resolvedPlacements(await readAssemblyStats(page))).toEqual(beforeApply);
    const undonePath = info.outputPath('undone.pcada');
    await saveFlowFile(page, undonePath);
    expect(await savedWelds(undonePath)).toEqual([]);
    await clickHistory(page, 'やり直す');
    expect(resolvedPlacements(await readAssemblyStats(page))).toEqual(beforeApply);
    const redonePath = info.outputPath('redone.pcada');
    await saveFlowFile(page, redonePath);
    expect(await savedWelds(redonePath)).toEqual(applied);

    // 7) 開き直すと同じ行が戻り、結果は無い。部材を確認し直して計算すると同じ期待を満たす。
    await openSaveFlowFile(page, redonePath);
    await expect(componentRows(page)).toHaveCount(3);
    await openBeamPanel(page);
    await expect(weldRow(page)).toHaveCount(1);
    await expect(throatInput(page)).toHaveValue(LAYER.throat);
    await expect(beamPanel(page).getByTestId('beam-weld-layer-results')).toHaveCount(0);
    await confirmMembers(page);
    await runAndCheck(page);

    expect(errors).toEqual([]);
  });
});
