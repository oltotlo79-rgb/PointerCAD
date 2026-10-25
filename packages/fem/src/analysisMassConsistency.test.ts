import { describe, expect, it } from 'vitest';
import { densityGPerCm3ToKgM3, findDensityMaterial } from '../../model/src/appearance/densityMaterials.js';
import { beamCadFixture, testComponent, testMember, testPlacement } from '../../model/src/analysis/beamInputs.testSupport.js';
import { standardMembersToBeamAnalysis } from '../../model/src/analysis/standardBeamAdapter.js';
import { partKeyOf } from '../../model/src/assembly/resolveAssembly.js';
import { createStandardPartSource } from '../../model/src/assembly/standard/buildStandardPart.js';
import type { AssemblyComponent } from '../../model/src/assembly/types.js';
import { createFilletWeldSource } from '../../model/src/assembly/welding/filletWeldPart.js';
import { weldTestBody } from '../../model/src/assembly/welding/filletWeld.testSupport.js';
import type { SolidBody } from '../../model/src/kernelBridge.js';
import { massFromVolume } from '../../model/src/measure/massProperties.js';
import { translateBeamAnalysis, type OofemBeamPlan } from './analysisTranslation.js';
import { modalFixture } from './modal.testSupport.js';
import { translateBeamModal } from './modalTranslation.js';
import type { SolidModalInput } from './solidModalModel.js';
import { translateSolidModal } from './solidModalTranslation.js';

function relative(actual: number, expected: number, tolerance = 1e-6): void {
  expect(Number.isFinite(actual)).toBe(true);
  expect(Math.abs(actual - expected) / expected).toBeLessThanOrEqual(tolerance);
}

function density(): number {
  const material = findDensityMaterial('steel');
  if (material === undefined) throw new Error('Missing explicitly selected CAD density');
  return material.density;
}

function beamPlanMass(plan: Pick<OofemBeamPlan, 'members' | 'materials' | 'sections'>): number {
  return plan.members.reduce((sum, member) => {
    const material = plan.materials.find(item => item.number === member.material);
    const section = plan.sections.find(item => item.number === member.section);
    if (material === undefined || section === undefined) throw new Error('Missing solver material or section');
    return sum + member.frame.lengthM * section.areaM2 * material.densityKgM3;
  }, 0);
}

function frame(extra: readonly AssemblyComponent[] = [], extraBodies: ReadonlyMap<string, readonly SolidBody[]> = new Map()) {
  const fixture = beamCadFixture();
  const a = testComponent('a', '1000');
  const b = { ...testComponent('b', '1000'), placement: testPlacement([0, 0, 1000]) };
  const document = { ...fixture.document, components: [a, b, ...extra] };
  const definition = { ...fixture.definition,
    members: [{ ...testMember(a), endNodeId: 'joint' }, { ...testMember(b), id: 'second', startNodeId: 'joint' }],
    materials: [{ ...fixture.definition.materials[0], densityKgM3: densityGPerCm3ToKgM3(density()) }] };
  // Independent finished CAD volumes: each rectangular bar is 50 x 6 x 1000 = 300000 mm3.
  const bodies: ReadonlyMap<string, readonly SolidBody[]> = new Map([
    [partKeyOf(a.source), [{ ...weldTestBody([], []), volume: 300000 }]], ...extraBodies,
  ]);
  return { document, definition, context: { currentSource: fixture.stamp, bodies, assemblyOptions: {} } };
}

function solid(): SolidModalInput {
  // Right tetrahedron: 100 x 60 x 50 / 6 = 50000 mm3 = 50 cm3.
  return { schema: 'pointercad-solid-tet4-modal/1', source: { documentId: 'mass-solid', revision: 1, meshKey: 'right-tet' },
    units: 'N-mm-MPa', numericBudgetBytes: 16 * 1024 * 1024,
    nodes: [[0, 0, 0], [100, 0, 0], [0, 60, 0], [0, 0, 50]],
    elements: [{ nodes: [0, 1, 2, 3], materialId: 'steel' }],
    materials: [{ id: 'steel', youngMPa: 205000, poisson: 0.3, densityKgM3: densityGPerCm3ToKgM3(density()) }],
    constraints: [], modeCount: 1 };
}

describe('independent CAD finished mass and analysis mass fixtures', () => {
  it.each(['frame', 'bolted', 'welded'] as const)('%s accounts for included and omitted physical mass', kind => {
    const extra: AssemblyComponent[] = [];
    const bodies = new Map<string, readonly SolidBody[]>();
    let excludedKg = 0;
    let excludedKind = '';
    if (kind === 'bolted') {
      // Analytic CAD-volume fixture: two M6 shafts (r=3,L=20) with hex heads (across flats=10,h=4).
      // Each V = 180*pi + 200*sqrt(3) mm3. This verifies mass transfer, not native thread/chamfer geometry.
      const volume = 180 * Math.PI + 200 * Math.sqrt(3);
      excludedKg = (360 * Math.PI + 400 * Math.sqrt(3)) * 7.85e-6;
      excludedKind = 'hexBolt';
      for (const id of ['bolt-1', 'bolt-2']) {
        const component = { ...testComponent(id), source: createStandardPartSource('hexBolt', 'M6', { length: '20' }) };
        extra.push(component);
        bodies.set(partKeyOf(component.source), [{ ...weldTestBody([], []), volume }]);
      }
    } else if (kind === 'welded') {
      // Three 6 x 8 / 2 mm2 triangular beads, lengths 20+30+50 = 100 mm: 2400 mm3, 18.84 g.
      excludedKg = 0.01884;
      excludedKind = 'filletWeld';
      for (const [segment, length] of [20, 30, 50].entries()) {
        const component = { ...testComponent(`weld-${segment}`), source: createFilletWeldSource(6, 8, {
          weldId: 'mass-weld', segment, station: [0, 20, 50][segment], length, contactLength: 100, parts: ['a', 'b'],
        }) };
        extra.push(component);
        bodies.set(partKeyOf(component.source), [{ ...weldTestBody([], []), volume: 24 * length }]);
      }
    }
    const fixture = frame(extra, bodies);
    const before = structuredClone(fixture);
    const result = standardMembersToBeamAnalysis(fixture.document, fixture.definition, fixture.context);
    if (!result.ok) throw new Error(result.issue.code + ': ' + result.issue.message);
    // Two bars: 600 cm3 x 7.85 g/cm3 / 1000 = 4.71 kg, independently of all imported constants.
    relative(result.totalMassKg, 4.71);
    relative(beamPlanMass(translateBeamAnalysis(result.document).plan), 4.71);
    const finishedKg = fixture.document.components.reduce((sum, component) => {
      const currentBodies = fixture.context.bodies.get(partKeyOf(component.source));
      if (currentBodies === undefined) throw new Error('Missing CAD fixture body');
      return sum + currentBodies.reduce((mass, body) => mass + massFromVolume(body.volume, density()) / 1000, 0);
    }, 0);
    relative(finishedKg, 4.71 + excludedKg);
    if (kind === 'frame') expect(result.excludedParts).toEqual([]);
    else {
      expect(result.excludedParts).toHaveLength(1);
      expect(result.excludedParts[0].kind).toBe(excludedKind);
      expect(result.excludedParts[0].count).toBe(kind === 'bolted' ? 2 : 3);
      const mass = result.excludedParts[0].massKg;
      if (mass === null) throw new Error('Known excluded CAD volume was lost');
      relative(mass, excludedKg);
    }
    const omittedKg = result.excludedParts.reduce((sum, item) => {
      if (item.massKg === null) throw new Error('Unknown mass in independent fixture');
      return sum + item.massKg;
    }, 0);
    relative(result.totalMassKg + omittedKg, finishedKg);
    expect(fixture).toEqual(before);
  });

  it('one solid has 0.3925 kg from both its CAD volume and its actual tetrahedron input', () => {
    const request = solid();
    const before = structuredClone(request);
    const result = translateSolidModal(request);
    relative(result.totalMassKg, 0.3925);
    relative(massFromVolume(50000, density()) / 1000, 0.3925);
    relative(result.totalMassKg, massFromVolume(50000, density()) / 1000);
    expect(request).toEqual(before);
    expect(result.input).toEqual(request);
    expect('totalMassKg' in result.input).toBe(false);
    expect('totalMassKg' in result.plan).toBe(false);
  });

  it('uses element material assignments, adds every tetrahedron, and ignores an unused material', () => {
    const first = solid();
    const request: SolidModalInput = { ...first, nodes: [...first.nodes, [0, 0, -50]],
      elements: [...first.elements, { nodes: [0, 2, 1, 4], materialId: 'aluminum' }],
      materials: [...first.materials, { ...first.materials[0], id: 'aluminum', densityKgM3: 2680 },
        { ...first.materials[0], id: 'unused', densityKgM3: 100000 }] };
    // Two 50000 mm3 tetrahedra: 50 cm3 x (7.85+2.68) g/cm3 = 526.5 g.
    relative(translateSolidModal(request).totalMassKg, 0.5265);
  });

  it('round-trips g/cm3, kg/m3 and t/mm3 to relative 1e-12 through the actual modal plan', () => {
    const result = translateSolidModal(solid());
    expect(density()).toBe(7.85);
    expect(result.input.materials[0].densityKgM3).toBe(7850);
    const tonnes = result.plan.materials[0].densityTPerMm3;
    relative(tonnes, 7.85e-9, 1e-12);
    relative(tonnes * 1e12, 7850, 1e-12);
    relative(tonnes * 1e9, 7.85, 1e-12);
  });

  it.each([false, true])('retains 7.85 kg after modal refinement (millimetres=%s)', millimetres => {
    const prepared = translateBeamModal(modalFixture({ millimetres, segments: 8, split: true }));
    // A=0.001 m2, L=1 m, rho=7850 kg/m3; splitting/refining must not multiply mass by element count.
    relative(beamPlanMass(prepared.plan), 7.85);
  });

  it.each(['zero-density', 'negative-density', 'unknown-material'])('refuses solid %s without returning an input', reason => {
    const base = solid();
    const request = reason === 'unknown-material'
      ? { ...base, elements: [{ ...base.elements[0], materialId: 'missing' }] }
      : { ...base, materials: [{ ...base.materials[0], densityKgM3: reason === 'zero-density' ? 0 : -7850 }] };
    const before = structuredClone(request);
    expect(() => translateSolidModal(request)).toThrow(reason === 'unknown-material'
      ? 'solid-modal-input: missing material'
      : 'solid-modal-input: density must be above 0 and at most 1e5 kg/m^3');
    expect(request).toEqual(before);
  });
});
