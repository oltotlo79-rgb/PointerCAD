import { readFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { diskFile, saveTarget } from './electronAppFlow.js';
import { uiMessage } from './uiMessages.js';

/*
 * The linear solid result CSV, written by the ordinary result-panel button through the real save path (web download
 * with the file pickers removed by the calling flow, or the Electron save dialog) from the native result on screen.
 * Nothing is injected into the store and no solver output is replaced. Independent expectations come from the values
 * typed in solidBoundaryAuthoringFlow: a 40 × 30 × 10 mm box centred at the origin, supports on the +X face (X = 0.2 mm),
 * the -Y face (Y = 0) and the +Z face (Z = 0), 7800 kg/m³ under -9.81 m/s² in Z, E 210000 MPa and ν 0.3, no face loads.
 * Numerical acceptance reuses the existing conditions: fixed translations equal their prescribed values exactly and
 * maximumRelativeEquilibriumResidual ≤ 1e-8 (packages/fem/src/solidAnalysisResults.ts), and the reactions balance the
 * gravity load to the same 4 decimals as the on-screen check; coordinates use the flow's 6-decimal precision.
 */
const FILE_NAME = 'solid-analysis.csv';
const HEADER = ['record', 'index', 'field', 'value'];
const HALF_SIZE_MM = [20, 15, 5] as const;
const VOLUME_MM3 = 40 * 30 * 10;
// 12000 mm³ × 1e-9 m³/mm³ × 7800 kg/m³ × -9.81 m/s² = -0.918216 N, the same oracle as the panel check.
const GRAVITY_N = [0, 0, VOLUME_MM3 * 1e-9 * 7800 * -9.81] as const;
/** Constrained axis = index: face coordinate on that axis and the typed displacement after the saved edit. */
const SUPPORTS = [{ face: 20, valueMm: 0.2 }, { face: -15, valueMm: 0 }, { face: 5, valueMm: 0 }] as const;
/** |a - b| < 5e-7 is Playwright's toBeCloseTo(b, 6), used for a coordinate on a face. */
const COORDINATE_CLOSE_MM = 5e-7;
const RESIDUAL_LIMIT = 1e-8;
const AXES = ['x', 'y', 'z'] as const;
const TENSOR = ['xx', 'yy', 'zz', 'yz', 'xz', 'xy'] as const;
const METADATA = { schema: 'pointercad-solid-result-report/1', coordinates: 'global-XYZ-undeformed', units: 'N-mm-MPa',
  indexBase: '0', tensorOrder: 'xx,yy,zz,yz,xz,xy', shearStrain: 'engineering', structuralCertification: 'false' };

interface ScreenValues { readonly displacement: string; readonly reaction: string; readonly energy: string; readonly residual: string }

/** RFC 4180 reader independent of the serializer (quoted fields, doubled quotes, CRLF records). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\r' && text[index + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; index += 1; }
    else field += char;
  }
  expect(!quoted && field === '' && row.length === 0, 'CSV ends with CRLF outside a quoted field').toBe(true);
  return rows;
}

function member(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) throw new Error(`CSV JSON lacks ${key}`);
  return Reflect.get(value, key);
}
function list(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not a list`);
  const items: readonly unknown[] = value;
  return items;
}
function vectors(value: unknown, width: number, label: string): number[][] {
  return list(value, label).map(row => list(row, label).map(item => {
    if (typeof item !== 'number' || !Number.isFinite(item)) throw new Error(`${label} has a non-finite value`);
    return item;
  })).map(row => { expect(row, label).toHaveLength(width); return row; });
}
function jsonRecord(rows: readonly string[][], record: 'input' | 'result'): unknown {
  const found = rows.filter(row => row[0] === record);
  expect(found.map(row => [row[1], row[2]]), `${record} record`).toEqual([['', 'json']]);
  return JSON.parse(found[0]?.[3] ?? '');
}

/** Geometry, units, material, gravity and supports of the captured input, against the typed values. */
function expectInput(input: unknown, displacement: readonly number[][]): number[][] {
  expect(member(input, 'units')).toBe('N-mm-MPa');
  expect(member(input, 'nodalLoads')).toEqual([]);
  expect(member(input, 'surfaceLoads')).toEqual([]);
  const materials = list(member(input, 'materials'), 'materials');
  expect(materials).toHaveLength(1);
  expect([member(materials[0], 'youngMPa'), member(materials[0], 'poisson')]).toEqual([210000, 0.3]);
  expect(member(input, 'gravity')).toEqual({ accelerationMps2: [0, 0, -9.81],
    densities: [{ materialId: member(materials[0], 'id'), densityKgM3: 7800 }] });
  const nodes = vectors(member(input, 'nodes'), 3, 'nodes');
  HALF_SIZE_MM.forEach((half, axis) => {
    const values = nodes.map(node => node[axis] ?? Number.NaN);
    expect(values.reduce((low, value) => Math.min(low, value), Infinity)).toBeCloseTo(-half, 6);
    expect(values.reduce((high, value) => Math.max(high, value), -Infinity)).toBeCloseTo(half, 6);
  });
  const fixed: string[] = [];
  for (const constraint of list(member(input, 'constraints'), 'constraints')) {
    const node = Number(member(constraint, 'node')), flags = list(member(constraint, 'fixed'), 'fixed');
    const prescribed = member(constraint, 'prescribedMm');
    const values = prescribed === undefined ? [0, 0, 0] : vectors([prescribed], 3, 'prescribedMm')[0] ?? [];
    flags.forEach((flag, axis) => {
      if (flag !== true) { expect(values[axis]).toBe(0); return; }
      fixed.push(`${String(node)}:${String(axis)}`);
      expect(nodes[node]?.[axis]).toBeCloseTo(SUPPORTS[axis]?.face ?? Number.NaN, 6);
      expect(values[axis]).toBe(SUPPORTS[axis]?.valueMm);
      // Existing acceptance (solidAnalysisResults.ts, `!==`): a fixed translation equals its prescribed value exactly.
      expect(displacement[node]?.[axis] === values[axis], `node ${String(node)} axis ${String(axis)} prescribed`).toBe(true);
    });
  }
  // Every node on a supported face is constrained along that face's axis, and no other translation is.
  const onFaces = nodes.flatMap((node, index) => SUPPORTS.flatMap((support, axis) =>
    Math.abs((node[axis] ?? Number.NaN) - support.face) < COORDINATE_CLOSE_MM ? [`${String(index)}:${String(axis)}`] : []));
  expect(fixed.sort()).toEqual(onFaces.sort());
  return nodes;
}

/** The meshed volume of the typed box, from the captured nodes and tetrahedra. */
function expectVolume(input: unknown, nodes: readonly number[][]): readonly unknown[] {
  const elements = list(member(input, 'elements'), 'elements');
  const point = (index: number): number[] => nodes[index] ?? [Number.NaN, Number.NaN, Number.NaN];
  const volume = elements.reduce<number>((sum, element) => {
    const [a, b, c, d] = vectors([member(element, 'nodes')], 4, 'element nodes')[0]?.map(point) ?? [];
    if (a === undefined || b === undefined || c === undefined || d === undefined) throw new Error('element without 4 nodes');
    const u = b.map((value, axis) => value - (a[axis] ?? 0)), v = c.map((value, axis) => value - (a[axis] ?? 0));
    const w = d.map((value, axis) => value - (a[axis] ?? 0));
    const [u0 = 0, u1 = 0, u2 = 0] = u, [v0 = 0, v1 = 0, v2 = 0] = v, [w0 = 0, w1 = 0, w2 = 0] = w;
    return sum + Math.abs(u0 * (v1 * w2 - v2 * w1) - u1 * (v0 * w2 - v2 * w0) + u2 * (v0 * w1 - v1 * w0)) / 6;
  }, 0);
  expect(volume).toBeCloseTo(VOLUME_MM3, 6);
  return elements;
}

/** Node, element and summary records repeat the captured native result in full precision and fixed order. */
function expectRecords(rows: readonly string[][], output: unknown, nodes: readonly number[][], elements: readonly unknown[],
  results: { readonly displacement: readonly number[][]; readonly reaction: readonly number[][] }): void {
  expect(rows.filter(row => row[0] === 'node')).toEqual(nodes.flatMap((node, index) => AXES.flatMap((axis, component) => [
    ['node', String(index), `${axis}_mm`, String(node[component])],
    ['node', String(index), `u${axis}_mm`, String(results.displacement[index]?.[component])],
    ['node', String(index), `reaction_${axis}_N`, String(results.reaction[index]?.[component])]])));
  const solved = list(member(output, 'elements'), 'result elements');
  expect(solved).toHaveLength(elements.length);
  expect(rows.filter(row => row[0] === 'element')).toEqual(elements.flatMap((element, index) => {
    const stress = vectors([member(solved[index], 'stressMPa')], 6, 'stress')[0] ?? [];
    const strain = vectors([member(solved[index], 'strain')], 6, 'strain')[0] ?? [];
    const corners = vectors([member(element, 'nodes')], 4, 'element nodes')[0] ?? [];
    return [['element', String(index), 'materialId', String(member(element, 'materialId'))],
      ...corners.map((node, local) => ['element', String(index), `node${String(local)}`, String(node)]),
      ...TENSOR.flatMap((component, position) => [
        ['element', String(index), `stress_${component}_MPa`, String(stress[position])],
        ['element', String(index), `strain_${component}`, String(strain[position])]])];
  }));
  const residual = Number(member(output, 'maximumRelativeEquilibriumResidual'));
  expect(residual).toBeLessThanOrEqual(RESIDUAL_LIMIT);
  expect(rows.filter(row => row[0] === 'summary')).toEqual([
    ['summary', '', 'strainEnergy_Nmm', String(member(output, 'strainEnergyNmm'))],
    ['summary', '', 'maximumRelativeEquilibriumResidual', String(residual)]]);
  expect(rows).toHaveLength(1 + Object.keys(METADATA).length + 2 + 2 + 9 * nodes.length + 17 * elements.length + 2);
}

/** Checks the saved bytes; returns nothing, the caller already saw the success notice. */
function expectSolidResultCsv(bytes: Buffer, screen: ScreenValues): void {
  expect([...bytes.subarray(0, 3)], 'UTF-8 BOM').toEqual([0xef, 0xbb, 0xbf]);
  const text = bytes.subarray(3).toString('utf8');
  // Valid UTF-8 only: a replacement character would not re-encode to the same bytes.
  expect(Buffer.from(text, 'utf8').equals(bytes.subarray(3)), 'valid UTF-8').toBe(true);
  expect(/[\r\n]/u.test(text.replaceAll('\r\n', '')), 'only CRLF line breaks').toBe(false);
  const rows = parseCsv(text);
  expect(rows.every(row => row.length === HEADER.length), 'every record has 4 fields').toBe(true);
  expect(rows[0]).toEqual(HEADER);
  const metadata = Object.fromEntries(rows.filter(row => row[0] === 'metadata').map(row => [row[2], row[3]]));
  expect(metadata).toEqual({ ...METADATA, inputSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    method: 'oofem-ltrspace-isole-native-ldlt/1' });
  const input = jsonRecord(rows, 'input'), output = jsonRecord(rows, 'result');
  expect([member(output, 'inputSha256'), member(output, 'units'), member(output, 'structuralCertification')])
    .toEqual([metadata.inputSha256, 'N-mm-MPa', false]);
  const displacement = vectors(member(output, 'displacementMm'), 3, 'displacementMm');
  const reaction = vectors(member(output, 'reactionN'), 3, 'reactionN');
  const nodes = expectInput(input, displacement);
  expect([displacement.length, reaction.length]).toEqual([nodes.length, nodes.length]);
  expectRecords(rows, output, nodes, expectVolume(input, nodes), { displacement, reaction });
  // The on-screen values are computed from the same session result: same summation order, same number text.
  const total = reaction.reduce((sum, vector) => sum.map((value, axis) => value + (vector[axis] ?? Number.NaN)), [0, 0, 0]);
  expect(screen.reaction).toBe(`${total.join(', ')} N`);
  total.forEach((value, axis) => { expect(value + (GRAVITY_N[axis] ?? Number.NaN)).toBeCloseTo(0, 4); });
  expect(screen.energy).toBe(`${String(member(output, 'strainEnergyNmm'))} N·mm`);
  expect(screen.residual).toBe(String(member(output, 'maximumRelativeEquilibriumResidual')));
  const largest = displacement.reduce((maximum, vector) => Math.max(maximum, Math.hypot(...vector)), 0);
  expect(screen.displacement.endsWith(' mm')).toBe(true);
  expect(Number.parseFloat(screen.displacement)).toBeCloseTo(largest, 12);
}

async function screenValue(result: Locator, key: string): Promise<string> {
  return result.locator(':scope > dl').getByText(uiMessage('solidAnalysis', key), { exact: true })
    .locator('xpath=following-sibling::dd[1]').innerText();
}

/** Same native result, independent serialized values: no result/store injection and no new solver run. */
async function expectStrainFields(result: Locator, bytes: Buffer): Promise<void> {
  const output = jsonRecord(parseCsv(bytes.subarray(3).toString('utf8')), 'result');
  const strains = vectors(list(member(output, 'elements'), 'elements').map(element => member(element, 'strain')), 6, 'strain');
  expect(strains.length).toBeGreaterThan(0);
  const quantity = result.getByTestId('solid-field-quantity'), legend = result.getByTestId('solid-field-legend');
  const names = ['strainXx', 'strainYy', 'strainZz', 'strainYz', 'strainXz', 'strainXy'] as const;
  for (const [component, name] of names.entries()) {
    await quantity.selectOption(name);
    await expect(quantity).toHaveValue(name);
    const values = strains.map(row => row[component]);
    const low = values.reduce((minimum, value) => Math.min(minimum, value), Infinity);
    const high = values.reduce((maximum, value) => Math.max(maximum, value), -Infinity);
    await expect(legend).toHaveAttribute('aria-label', uiMessage('solidAnalysis', 'solidAnalysis.legendDimensionless'));
    await expect(legend.getByText(uiMessage('solidAnalysis', 'solidAnalysis.legendMinimum'), { exact: true })
      .locator('xpath=following-sibling::dd[1]')).toHaveText(`${low} 無次元`);
    await expect(legend.getByText(uiMessage('solidAnalysis', 'solidAnalysis.legendMaximum'), { exact: true })
      .locator('xpath=following-sibling::dd[1]')).toHaveText(`${high} 無次元`);
    await expect(result.getByTestId('solid-field-ramp')).toHaveAttribute('aria-label',
      `${uiMessage('solidAnalysis', 'solidAnalysis.legendRampDimensionless')} ${low} 無次元 - ${high} 無次元`);
  }
  await quantity.selectOption('vonMises');
  await expect(legend).toHaveAttribute('aria-label', uiMessage('solidAnalysis', 'solidAnalysis.legend'));
}

/** Saves the current result through the panel button and checks the actual file bytes. */
export async function solidResultCsvFlow(page: Page, result: Locator, info: TestInfo, app?: ElectronApplication): Promise<void> {
  const button = result.getByRole('button', { name: uiMessage('solidAnalysis', 'solidAnalysis.exportCsv'), exact: true });
  const saved = result.getByRole('status').filter({ hasText: uiMessage('solidAnalysis', 'solidAnalysis.exportCsvSaved') });
  await expect(button).toBeEnabled();
  const path = info.outputPath(FILE_NAME);
  let bytes: Buffer;
  if (app === undefined) {
    const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
    expect(download.suggestedFilename()).toBe(FILE_NAME);
    await download.saveAs(path);
    await expect(saved).toBeVisible();
    bytes = await readFile(path);
  } else {
    await saveTarget(app, path);
    await button.click();
    // The notice follows the gateway's completed write and close; read the file only after it.
    await expect(saved).toBeVisible();
    bytes = await diskFile(path);
  }
  expectSolidResultCsv(bytes, {
    displacement: await screenValue(result, 'solidAnalysis.displacement'),
    reaction: await screenValue(result, 'solidAnalysis.reaction'),
    energy: await screenValue(result, 'solidAnalysis.energy'),
    residual: await screenValue(result, 'solidAnalysis.residual'),
  });
  await expectStrainFields(result, bytes);
}
