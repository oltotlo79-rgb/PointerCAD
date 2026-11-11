import { describe, expect, it } from 'vitest';

import { findDensityMaterial } from '../../appearance/densityMaterials.js';
import { rigidPlacementOf } from '../fastening/frames.js';
import { assemblyMassProperties, type AssemblyMassBody } from '../massProperties.js';
import type { RigidPlacement } from '../placementMath.js';
import { standardPartNominalVolume } from '../standard/buildStandardPart.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import { applyFilletWeld } from './applyFilletWeld.js';
import { plainTee, TEE_BODIES, teeRequest, WELD_TEST_REVISIONS } from './filletWeld.testSupport.js';
import { filletWeldSegmentOptions } from './filletWeldPart.js';
import { planFilletWeld, planFilletWeldEdit, weldSegmentsOf, type FilletWeldEditRequest } from './planFilletWeld.js';

/**
 * Edit of an irregular three-bead weld (6x8 aluminium at stations 10/40/70, lengths 20/15/25) into a different
 * irregular three-bead weld whose beads touch end to end and reach the contact end (stationing.ts 63-65: touching
 * ends are allowed and stay separate beads). The expected bead fields, volumes and mass are derived here from the
 * edit request, the right-angle section (legs product / 2) and the material density, not read from the product.
 */
const LEG_ON_SECOND = 4, LEG_ON_FIRST = 7;
const SEGMENTS = [{ start: 0, length: 40 }, { start: 40, length: 25 }, { start: 80, length: 20 }] as const;
const EDIT: FilletWeldEditRequest = { weldId: 'weld-1', legOnSecond: LEG_ON_SECOND, legOnFirst: LEG_ON_FIRST,
  segments: SEGMENTS, materialId: 'steel' };
/** Contact edge length of the tee (filletWeld.testSupport.ts: standing plate edge 0..100 on the base top). */
const CONTACT_LENGTH = 100;
/** Weld line origin of the tee (applyFilletWeld.test.ts: origin (0,34,10) + station along +X). */
const WELD_ORIGIN = [0, 34, 10] as const;
/** Plates: standing 100x8x50 and base 100x60x10, no material (steel 7.85, applyFilletWeld.test.ts 130). */
const PLATE_VOLUMES: Readonly<Record<string, number>> = { 'component-1': 40000, 'component-2': 60000 };
const SECTION_AREA = LEG_ON_SECOND * LEG_ON_FIRST / 2;

function welded(): AssemblyDocument {
  const before = plainTee();
  const planned = planFilletWeld(before, teeRequest(), WELD_TEST_REVISIONS, TEE_BODIES);
  if (!planned.ok) throw new Error(JSON.stringify(planned.rejections));
  const applied = applyFilletWeld(before, planned.plan, WELD_TEST_REVISIONS);
  if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
  return applied.document;
}

function edited(after: AssemblyDocument): AssemblyDocument {
  const planned = planFilletWeldEdit(after, EDIT, WELD_TEST_REVISIONS, TEE_BODIES);
  if (!planned.ok) throw new Error(JSON.stringify(planned.rejections));
  // Independent: section area x sum of requested lengths (14 x 85 = 1190 mm3).
  expect(planned.plan.nominalVolume).toBeCloseTo(SECTION_AREA * SEGMENTS.reduce((sum, segment) => sum + segment.length, 0), 9);
  const applied = applyFilletWeld(after, planned.plan, WELD_TEST_REVISIONS);
  if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
  return applied.document;
}

function component(document: AssemblyDocument, id: string): AssemblyComponent {
  const found = document.components.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing ${id}`);
  return found;
}

describe('irregular multi-bead fillet weld edit keeps saved beads, volumes and mass in agreement', () => {
  it('replaces every old bead once with the edited irregular beads whose fields, placement, volume and mass follow the request', () => {
    const after = welded();
    const oldBeads = (weldSegmentsOf(after).get('weld-1') ?? []).map((bead) => bead.id);
    expect(oldBeads).toHaveLength(3);
    const snapshot = JSON.stringify(after);
    const result = edited(after);
    // Undo keeps the previous immutable document; Redo (same plan on the same document) gives the same result.
    expect(JSON.stringify(after)).toBe(snapshot);
    expect(edited(after)).toEqual(result);

    const beads = weldSegmentsOf(result).get('weld-1') ?? [];
    expect(beads).toHaveLength(SEGMENTS.length);
    // No old bead survives, so its volume cannot be charged in addition to the new beads.
    expect(result.components.map((item) => item.id).filter((id) => oldBeads.includes(id))).toEqual([]);
    expect(result.components).toHaveLength(2 + SEGMENTS.length);
    // The welded plates are unchanged by the edit.
    for (const id of ['component-1', 'component-2']) {
      expect(component(result, id)).toEqual(component(after, id));
    }

    const volumes = new Map<string, number>(Object.entries(PLATE_VOLUMES));
    const seen = new Set<number>();
    for (const bead of beads) {
      if (bead.source.kind !== 'standardPart') throw new Error('bead must be a standard part');
      const options = filletWeldSegmentOptions(bead.source.options);
      if (options === null) throw new Error(`bead ${bead.id} options unreadable`);
      const requested = SEGMENTS[options.segment];
      if (requested === undefined) throw new Error(`bead ${bead.id} segment ${String(options.segment)} not requested`);
      expect(seen.has(options.segment)).toBe(false);
      seen.add(options.segment);
      expect([bead.source.size, options.weldId, options.station, options.length, options.contactLength, options.parts])
        .toEqual([`${String(LEG_ON_SECOND)}x${String(LEG_ON_FIRST)}`, 'weld-1', requested.start, requested.length,
          CONTACT_LENGTH, ['component-1', 'component-2']]);
      expect([bead.materialId, bead.rigidGroupId, bead.suppressed]).toEqual(['steel', component(result, 'component-1').rigidGroupId, false]);
      expect(bead.placement.position.map((value) => value.value))
        .toEqual([WELD_ORIGIN[0] + requested.start, WELD_ORIGIN[1], WELD_ORIGIN[2]]);
      const expectedVolume = SECTION_AREA * requested.length;
      expect(standardPartNominalVolume('filletWeld', bead.source.size, bead.source.options)).toBeCloseTo(expectedVolume, 9);
      volumes.set(bead.id, expectedVolume);
    }
    expect([...seen].sort((left, right) => left - right)).toEqual(SEGMENTS.map((_segment, index) => index));

    // Mass counts each current component once: plates and beads, all steel after the edit.
    const partKeys = new Map<string, string>();
    const bodies = new Map<string, readonly AssemblyMassBody[]>();
    const placements = new Map<string, RigidPlacement>();
    for (const item of result.components) {
      partKeys.set(item.id, item.id);
      bodies.set(item.id, [{ volume: volumes.get(item.id) ?? Number.NaN, centroid: [0, 0, 0] }]);
      placements.set(item.id, rigidPlacementOf(item.placement));
    }
    const steel = findDensityMaterial('steel')?.density;
    if (steel === undefined) throw new Error('steel density missing');
    const totalVolume = Object.values(PLATE_VOLUMES).reduce((sum, value) => sum + value, 0)
      + SECTION_AREA * SEGMENTS.reduce((sum, segment) => sum + segment.length, 0);
    const mass = assemblyMassProperties(result, { partKeys, bodies }, placements);
    expect(mass.partial).toBe(false);
    expect(mass.volume).toBeCloseTo(totalVolume, 9);
    // g = mm3 x g/cm3 x 1e-3 (applyFilletWeld.test.ts 142): 101190 x 7.85e-3 = 794.3415 g.
    expect(mass.mass).toBeCloseTo(totalVolume * steel * 1e-3, 9);
  });

  it('changes only the middle irregular bead values and charges only its new length to mass', () => {
    const before = welded();
    const snapshot = JSON.stringify(before);
    const request: FilletWeldEditRequest = { weldId: 'weld-1', legOnSecond: 6, legOnFirst: 8,
      segments: [{ start: 10, length: 20 }, { start: 45, length: 10 }, { start: 70, length: 25 }], materialId: 'aluminum' };
    const plan = planFilletWeldEdit(before, request, WELD_TEST_REVISIONS, TEE_BODIES);
    if (!plan.ok) throw new Error(JSON.stringify(plan.rejections));
    // Right triangle 6 x 8 / 2; only the middle bead loses 5 mm: 24 x (20 + 10 + 25).
    expect(plan.plan.nominalVolume).toBe(1320);
    const applied = applyFilletWeld(before, plan.plan, WELD_TEST_REVISIONS);
    if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
    const rows = weldSegmentsOf(applied.document).get('weld-1') ?? [];
    expect(rows).toHaveLength(3);
    const partKeys = new Map<string, string>();
    const bodies = new Map<string, readonly AssemblyMassBody[]>();
    const placements = new Map<string, RigidPlacement>();
    const expectedVolumes = [480, 240, 600];
    for (const [index, bead] of rows.entries()) {
      if (bead.source.kind !== 'standardPart') throw new Error('missing bead source');
      const options = filletWeldSegmentOptions(bead.source.options);
      const expected = request.segments[index];
      if (options === null || expected === undefined) throw new Error('missing bead options');
      expect([options.station, options.length, bead.source.size, bead.materialId])
        .toEqual([expected.start, expected.length, '6x8', 'aluminum']);
      expect(bead.placement.position.map(value => value.value)).toEqual([expected.start, 34, 10]);
      expect(standardPartNominalVolume('filletWeld', bead.source.size, bead.source.options)).toBe(expectedVolumes[index]);
    }
    for (const item of applied.document.components) {
      const index = rows.findIndex(bead => bead.id === item.id);
      const volume = index < 0 ? PLATE_VOLUMES[item.id] : expectedVolumes[index];
      if (volume === undefined) throw new Error('unexpected component');
      partKeys.set(item.id, item.id);
      bodies.set(item.id, [{ volume, centroid: [0, 0, 0] }]);
      placements.set(item.id, rigidPlacementOf(item.placement));
    }
    const mass = assemblyMassProperties(applied.document, { partKeys, bodies }, placements);
    expect(mass.partial).toBe(false);
    expect(mass.volume).toBe(101320);
    // Catalog steel 7.85 and aluminium 2.68 g/cm3; mm3 to cm3 is 1/1000.
    expect(mass.mass).toBeCloseTo(100000 * 7.85 / 1000 + 1320 * 2.68 / 1000, 9);
    expect(JSON.stringify(before)).toBe(snapshot);
    for (const id of ['component-1', 'component-2']) expect(component(applied.document, id)).toEqual(component(before, id));
  });

  it('refuses an overlapping edit and leaves the saved irregular beads untouched', () => {
    const after = welded();
    const overlapping = planFilletWeldEdit(after, { ...EDIT, segments: [{ start: 0, length: 40 }, { start: 30, length: 20 }] },
      WELD_TEST_REVISIONS, TEE_BODIES);
    expect(overlapping.ok ? [] : overlapping.rejections.map((rejection) => rejection.code)).toEqual(['segmentsOverlap']);
    expect(overlapping.ok ? null : overlapping.rejections[0]?.detail).toEqual({ segment: 1, overlap: 10 });
    expect((weldSegmentsOf(after).get('weld-1') ?? []).map((bead) => bead.source.kind === 'standardPart'
      ? bead.source.options.length : '')).toEqual(['20', '15', '25']);
  });
});
