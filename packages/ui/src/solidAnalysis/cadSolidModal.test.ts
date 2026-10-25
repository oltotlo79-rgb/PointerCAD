import type { prepareCadSolidAnalysis } from '@pointercad/fem';
import { describe, expect, it } from 'vitest';
import { cadSolidModalInput } from './cadSolidModal.js';

const prepared: ReturnType<typeof prepareCadSolidAnalysis> = {
  input: {
    schema: 'pointercad-solid-tet4/1', source: { documentId: 'doc-1', revision: 3, meshKey: 'mesh-a' }, units: 'N-mm-MPa',
    numericBudgetBytes: 1000, nodes: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]],
    elements: [{ nodes: [0, 1, 2, 3], materialId: 'material' }],
    materials: [{ id: 'material', youngMPa: 205000, poisson: 0.3 }],
    constraints: [{ node: 0, fixed: [true, true, true] }, { node: 2, fixed: [true, true, true] }],
    nodalLoads: [], surfaceLoads: [{ nodes: [0, 2, 1], tractionMPa: [0, 0, 0] }],
  },
  loadedAreaMm2: 50, totalForceN: [0, 0, 0],
};
const request = (freeFree: boolean) => ({ material: { id: 'material', youngMPa: 205000, poisson: 0.3, densityKgM3: 7850 },
  modeCount: 4, numericBudgetBytes: 2_000_000, freeFree });

describe('cadSolidModalInput', () => {
  it('keeps the static source, nodes, elements and restrained nodes, with density and no load', () => {
    const input = cadSolidModalInput(prepared, request(false));
    expect(input.source).toBe(prepared.input.source);
    expect(input.nodes).toBe(prepared.input.nodes);
    expect(input.elements).toEqual(prepared.input.elements);
    expect(input.constraints).toEqual([{ node: 0, fixed: [true, true, true] }, { node: 2, fixed: [true, true, true] }]);
    expect(input.materials).toEqual([{ id: 'material', youngMPa: 205000, poisson: 0.3, densityKgM3: 7850 }]);
    expect([input.schema, input.units, input.modeCount, input.numericBudgetBytes]).toEqual(['pointercad-solid-tet4-modal/1', 'N-mm-MPa', 4, 2_000_000]);
    // Exactly the r150 input fields: no load, no static-only key leaks into the modal request.
    expect(Object.keys(input).sort()).toEqual(['constraints', 'elements', 'materials', 'modeCount', 'nodes', 'numericBudgetBytes', 'schema', 'source', 'units']);
  });

  it('drops every constraint for free-free', () => {
    expect(cadSolidModalInput(prepared, request(true)).constraints).toEqual([]);
  });

  it('does not mutate the prepared static input', () => {
    const before = JSON.stringify(prepared);
    cadSolidModalInput(prepared, request(false));
    expect(JSON.stringify(prepared)).toBe(before);
  });
});
