import { describe, expect, it } from 'vitest';
import { readBeamAnalysis } from './analysisValidation.js';
import { translateBeamModal } from './modalTranslation.js';
import { modalFixture } from './modal.testSupport.js';

describe('explicit bounded modal input and coupled mesh', () => {
  it('preserves original nodes, merges shared endpoints, and refines only solver data', () => {
    const document = modalFixture({ split: true, segments: 4 });
    const before = JSON.stringify(document);
    const { plan } = translateBeamModal(document);
    expect(plan.originalNodeCount).toBe(3);
    expect(plan.nodes).toHaveLength(9);
    expect(plan.members).toHaveLength(8);
    expect(plan.members[3].nodes[1]).toBe(2);
    expect(plan.members[4].nodes[0]).toBe(2);
    expect(plan.nodes.filter(node => node.fixed).map(node => node.number)).toEqual([1]);
    expect(JSON.stringify(document)).toBe(before);
  });

  it('keeps physical metre and millimetre plans equivalent including density', () => {
    const metres = translateBeamModal(modalFixture()).plan;
    const millimetres = translateBeamModal(modalFixture({ millimetres: true })).plan;
    expect(millimetres.nodes).toEqual(metres.nodes);
    expect(millimetres.materials[0].youngPa).toBeCloseTo(metres.materials[0].youngPa, 3);
    expect(millimetres.materials[0].poisson).toBeCloseTo(metres.materials[0].poisson, 14);
    expect(millimetres.materials[0].densityKgM3).toBe(metres.materials[0].densityKgM3);
    for (const key of ['areaM2', 'iyM4', 'izM4', 'torsionM4'] as const) {
      expect(millimetres.sections[0][key]).toBeCloseTo(metres.sections[0][key], 16);
    }
  });

  it.each([
    { modal: { modeCount: 0, segmentsPerMember: 8 } },
    { modal: { modeCount: 25, segmentsPerMember: 8 } },
    { modal: { modeCount: 2, segmentsPerMember: 0 } },
    { modal: { modeCount: 2, segmentsPerMember: 33 } },
    { modal: { modeCount: 2, segmentsPerMember: 1.5 } },
    { modal: { modeCount: 2, segmentsPerMember: 8, solverCode: 'execute' } },
    { schema: 'pointercad-beam/1' },
    { constraints: [{ id: 'pin', kind: 'pinned', nodeId: 'node-0' }] },
    { loads: [{ id: 'load', kind: 'nodal', nodeId: 'node-1', force: [1, 0, 0], moment: [0, 0, 0] }] },
  ])('rejects invalid settings, unsupported restraints, static reinterpretation and prestress: %j', change => {
    expect(readBeamAnalysis({ ...modalFixture(), ...change }).ok).toBe(false);
  });

  it('rejects missing/nonpositive density and unsupported disconnected restrained components before execution', () => {
    const document = modalFixture();
    for (const densityKgM3 of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(readBeamAnalysis({ ...document,
        materials: [{ ...document.materials[0], densityKgM3 }] }).ok).toBe(false);
    }
    const disconnected = { ...document,
      nodes: [...document.nodes, { id: 'other-a', position: [0, 1, 0] }, { id: 'other-b', position: [1, 1, 0] }],
      members: [...document.members, { ...document.members[0], id: 'other', componentId: 'other',
        occurrencePath: ['other'], startNodeId: 'other-a', endNodeId: 'other-b' }] };
    const checked = readBeamAnalysis(disconnected);
    expect(checked.ok).toBe(false);
    if (checked.ok) throw new Error('Restrained mechanism was accepted');
    expect(checked.issue.code).toBe('unconstrained-component');
    expect(readBeamAnalysis({ ...disconnected, constraints: [] }).ok).toBe(true);
    expect(readBeamAnalysis({ ...disconnected, constraints: [], modal: { modeCount: 13, segmentsPerMember: 1 } }).ok).toBe(false);
  });

  it('permits fixed-fixed vibration only with actual internal free finite-element nodes', () => {
    const document = modalFixture();
    const fixed = { ...document, constraints: [...document.constraints, { id: 'second-clamp', kind: 'fixed', nodeId: 'node-1' }] };
    expect(readBeamAnalysis(fixed).ok).toBe(true);
    expect(readBeamAnalysis({ ...fixed, modal: { modeCount: 2, segmentsPerMember: 1 } }).ok).toBe(false);
  });
});
