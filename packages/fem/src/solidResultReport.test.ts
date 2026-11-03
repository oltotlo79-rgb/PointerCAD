import { describe, expect, it } from 'vitest';
import { solidResultReportRows } from './solidResultReport.js';
import { decodeSolidAnalysis, solidResultMatches } from './solidAnalysisResults.js';
import { solidInputSha256 } from './solidAnalysisTranslation.js';
import type { SolidAnalysisInput } from './solidAnalysisModel.js';

function inputFor(force: number): SolidAnalysisInput {
  return { schema: 'pointercad-solid-tet4/1', source: { documentId: 'report', revision: 7, meshKey: 'tet' },
    units: 'N-mm-MPa', numericBudgetBytes: 16 * 1024 * 1024,
    nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
    elements: [{ nodes: [0, 1, 2, 3], materialId: 'm' }], materials: [{ id: 'm', youngMPa: 210000, poisson: 0 }],
    constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, true, true] },
      { node: 2, fixed: [true, true, true] }, { node: 3, fixed: [true, true, true] }],
    nodalLoads: [{ node: 1, forceN: [force, 0, 0] }], surfaceLoads: [] };
}
async function fixture(force = 1) {
  const input = inputFor(force), hash = await solidInputSha256(input);
  // Independent tet with one free DOF: K = E*L/6, L=1 mm; V=1/6 mm^3.
  const result = decodeSolidAnalysis({ schema: 'pointercad-solid-tet4-native/1', source: input.source,
    displacementMm: [[0, 0, 0], [6 * force / 210000, 0, 0], [0, 0, 0], [0, 0, 0]],
    elementForcesN: [[-force, 0, 0, force, 0, 0, 0, 0, 0, 0, 0, 0]],
    reservedNumericBytes: 50000, minimumScaledPivot: 1 }, input, hash);
  return { input, result, hash };
}

describe('reproducible linear solid report', () => {
  it.each([1, -2])('keeps global coordinates, unrounded signed values and replayable acceptance for F=%s', async force => {
    const f = await fixture(force), rows = await solidResultReportRows(f.input, f.result);
    expect(rows).toContainEqual(['metadata', '', 'coordinates', 'global-XYZ-undeformed']);
    expect(rows).toContainEqual(['metadata', '', 'tensorOrder', 'xx,yy,zz,yz,xz,xy']);
    expect(rows).toContainEqual(['metadata', '', 'structuralCertification', 'false']);
    expect(rows).toContainEqual(['node', 1, 'x_mm', 1]);
    expect(rows).toContainEqual(['node', 1, 'ux_mm', 6 * force / 210000]);
    expect(rows).toContainEqual(['node', 0, 'reaction_x_N', -force]);
    expect(rows).toContainEqual(['element', 0, 'node3', 3]);
    const stress = rows.find(row => row[0] === 'element' && row[2] === 'stress_xx_MPa');
    expect(stress?.[3]).toBeCloseTo(6 * force, 12);
    const inputJson = rows.find(row => row[0] === 'input')?.[3];
    const resultJson = rows.find(row => row[0] === 'result')?.[3];
    if (typeof inputJson !== 'string' || typeof resultJson !== 'string') throw new Error('Missing replay records');
    const capturedInput: unknown = JSON.parse(inputJson), capturedResult: unknown = JSON.parse(resultJson);
    expect(capturedInput).toEqual(f.input);
    expect(solidResultMatches(capturedResult, f.input, f.hash)).toBe(true);
    expect(await solidResultReportRows(structuredClone(f.input), structuredClone(f.result))).toEqual(rows);
  });
  it('rejects changed input, forged hash and modified accepted stress rather than exporting stale data', async () => {
    const f = await fixture();
    await expect(solidResultReportRows(inputFor(2), f.result)).rejects.toThrow('does not match');
    await expect(solidResultReportRows(f.input, { ...f.result, inputSha256: '0'.repeat(64) })).rejects.toThrow('does not match');
    await expect(solidResultReportRows(f.input, { ...f.result, elements: [{ ...f.result.elements[0],
      stressMPa: [7, 0, 0, 0, 0, 0] }] })).rejects.toThrow('does not match');
  });
  it('owns the result before asynchronous hashing', async () => {
    const f = await fixture(), changed = { ...f.result, displacementMm: f.result.displacementMm.map(row => [...row] as [number, number, number]) };
    const pending = solidResultReportRows(f.input, changed);
    changed.displacementMm[1][0] = 100;
    expect(await pending).toContainEqual(['node', 1, 'ux_mm', 6 / 210000]);
  });
});
