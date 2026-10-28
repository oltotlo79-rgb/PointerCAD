import { componentSourceKey, placementFingerprint } from '../assembly/fastening/frames.js';
import { partKeyOf } from '../assembly/resolveAssembly.js';
import { multiplyQuaternion, quaternionFromAxisAngle, rotateVector } from '../assembly/placementMath.js';
import { planFilletWeld } from '../assembly/welding/planFilletWeld.js';
import { applyFilletWeld } from '../assembly/welding/applyFilletWeld.js';
import { buildFilletWeldPart, createFilletWeldSource, filletWeldSegmentOptions } from '../assembly/welding/filletWeldPart.js';
import { lineEdge, planeFace, weldTestBox } from '../assembly/welding/filletWeld.testSupport.js';
import { beamCadFixture, testComponent, testMember, testPlacement, TEST_EVIDENCE } from './beamInputs.testSupport.js';
import type { CadWeldLayerInputs } from './weldLayerInput.js';
import type { StandardBeamContactDefinition } from './beamInputs.js';

import { describe, expect, it } from 'vitest';
import { prepareCadWeldLayers } from './cadWeldLayer.js';
import { readCadWeldLayerInputs } from './weldLayerInput.js';
import { cadWeldLayerFixture } from './cadWeldLayer.testSupport.js';

describe('current CAD effective weld layer boundary', () => {
  it('derives actual triangular throat frame and SI compliance from the two owned endpoint sections', () => {
    const f = cadWeldLayerFixture(), before = structuredClone(f.document);
    const result = prepareCadWeldLayers(f.document, f.definition, f.associations, f.context), w = result.welds[0];
    // Actual 3-4-5 triangle: available altitude=12/5 mm. Declared effective width2 mm.
    // Root-to-foot direction local(.8,.6), localZ maps worldX; root at(worldY6,Z6).
    expect(w.centerM[0]).toBeCloseTo(.025, 12);
    expect(w.centerM[1]).toBeCloseTo(.0068, 12);
    expect(w.centerM[2]).toBeCloseTo(.0066, 12);
    expect(w.normal[0]).toBeCloseTo(0, 12); expect(w.normal[1]).toBeCloseTo(.6, 12); expect(w.normal[2]).toBeCloseTo(-.8, 12);
    expect(w.along[0]).toBeCloseTo(1, 12);
    expect(w.youngPa*w.widthM*w.lengthM/w.thicknessM).toBeCloseTo(2e7, 6);
    expect(w.nodeIdA).toBe('a-base'); expect(w.nodeIdB).toBe('b-base');
    expect(f.document).toEqual(before);
  });
  it('roundtrips explicit associations and rejects unsupported, duplicate or sparse data', () => {
    const f = cadWeldLayerFixture();
    expect(readCadWeldLayerInputs(JSON.parse(JSON.stringify(f.associations)))).toEqual(f.associations);
    for (const patch of [{ yieldMPa: 250 }, { complianceLengthMm: 0 }, { effectiveThroatMm: Infinity }, { poisson: .5 }]) {
      expect(() => readCadWeldLayerInputs({ ...f.associations, welds: [{ ...f.associations.welds[0], ...patch }] })).toThrow();
    }
    expect(() => readCadWeldLayerInputs({ ...f.associations, welds: new Array(1) })).toThrow();
  });
  it('rejects stale source/material/placement and wrong member ownership or remote endpoint', () => {
    const f = cadWeldLayerFixture();
    expect(() => prepareCadWeldLayers(f.document, f.definition, f.associations,
      { ...f.context, currentSource: { ...f.context.currentSource, geometryRevision: 'changed' } })).toThrow();
    for (const patch of [{ materialId: 'steel' }, { suppressed: true }, { placement: testPlacement([999, 0, 0]) }]) {
      const document = { ...f.document, components: f.document.components.map(c => c.id === f.beadId ? { ...c, ...patch } : c) };
      expect(() => prepareCadWeldLayers(document, f.definition, f.associations, f.context)).toThrow();
    }
    for (const first of [{ memberId: 'a-beam', nodeId: 'b-base' }, { memberId: 'a-beam', nodeId: 'a-tip' }]) {
      expect(() => prepareCadWeldLayers(f.document, f.definition, { ...f.associations,
        welds: [{ ...f.associations.welds[0], first }] }, f.context)).toThrow();
    }
  });
  it('refuses missing actual body evidence and a throat wider than the real triangle', () => {
    const f = cadWeldLayerFixture();
    expect(() => prepareCadWeldLayers(f.document, f.definition, f.associations, { ...f.context, bodies: new Map() })).toThrow('CAD bodies');
    expect(() => prepareCadWeldLayers(f.document, f.definition, { ...f.associations,
      welds: [{ ...f.associations.welds[0], effectiveThroatMm: 2.5 }] }, f.context)).toThrow('altitude');
    const bead = f.document.components.find(c => c.id === f.beadId);
    if (bead === undefined) throw new Error('Missing fixture bead');
    const doubled = { ...f.document, components: [...f.document.components, { ...bead, id: 'extra-bead' }] };
    expect(() => prepareCadWeldLayers(doubled, f.definition, f.associations, f.context)).toThrow('silent merging');
  });
});


/** 実FB50×6の境界と既存plan/apply/buildを通す。曲面を平鋼のbodyへ捏造しない。 */
function obliqueLayerFixture(outer = false, segments = [{ start: 5, length: 20 }]) {
  const base = beamCadFixture(), turn = quaternionFromAxisAngle([1, 0, 0], -Math.PI / 6);
  const world = outer ? quaternionFromAxisAngle([0, 0, 1], Math.PI / 2) : [0, 0, 0, 1] as const;
  const shift = outer ? [7, -2, 5] as const : [0, 0, 0] as const;
  const transform = (point: readonly [number, number, number]) => {
    const p = rotateVector(world, point);
    return [p[0] + shift[0], p[1] + shift[1], p[2] + shift[2]] as const;
  };
  const a = { ...testComponent('a', '20'), placement: testPlacement(transform([0, 0, 6]), multiplyQuaternion(world, turn)) };
  const b = { ...testComponent('b', '20'), placement: testPlacement(transform([0, 3 * Math.sqrt(3), 3]),
    multiplyQuaternion(world, quaternionFromAxisAngle([1, 0, 0], -Math.PI / 2))) };
  const before = { ...base.document, components: [a, b] }, body = weldTestBox([0, 0, 0], [50, 6, 20]);
  const revisions = new Map<string, string>(), ka = componentSourceKey(a, revisions), kb = componentSourceKey(b, revisions);
  if (ka === null || kb === null) throw new Error('Missing actual steel source');
  const planned = planFilletWeld(before, {
    first: { ...planeFace('a', '', [25, 6, 10], [0, 1, 0]), sourceKey: ka },
    second: { ...planeFace('b', '', [25, 0, 10], [0, -1, 0]), sourceKey: kb },
    edge: lineEdge([25, 6, 0], [1, 0, 0], 50), legOnSecond: 6, legOnFirst: 8, segments, materialId: 'aluminum',
  }, revisions, () => [body]);
  if (!planned.ok) throw new Error('Actual oblique plan refused: ' + JSON.stringify(planned.rejections));
  const applied = applyFilletWeld(before, planned.plan, revisions);
  if (!applied.ok) throw new Error('Actual oblique apply refused');
  const document = applied.document;
  const definition: StandardBeamContactDefinition = { schema: 'pointercad-standard-beam/5', id: 'oblique-contact', revision: 1,
    source: base.stamp, units: 'N-mm', members: [testMember(a, ['a'], 'a-'), testMember(b, ['b'], 'b-')],
    materials: base.definition.materials, sections: base.definition.sections,
    supports: [{ nodeId: 'a-tip', restrained: [true, true, true, true, true, true] },
      { nodeId: 'b-tip', restrained: [true, true, true, true, true, true] }],
    referenceLoads: [{ id: 'load', kind: 'nodal', nodeId: 'a-base', force: [0, 0, 1], moment: [0, 0, 0] }],
    contact: { segmentsPerMember: 1, contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'b-base', normal: [0, 0, 1], gapMm: 10 }], loadFactors: [1, -1] } };
  const associations: CadWeldLayerInputs = { schema: 'pointercad-cad-weld-layers/1', source: base.stamp,
    analysisId: definition.id, analysisRevision: definition.revision, welds: applied.componentIds.map((id, i) => {
      const bead = document.components.find(c => c.id === id);
      if (bead?.source.kind !== 'standardPart' || buildFilletWeldPart(bead.source) === null) throw new Error('Actual saved build missing');
      return { id: 'oblique-' + i, beadComponentId: id, expectedPartKey: partKeyOf(bead.source),
        expectedPlacementKey: placementFingerprint(bead.placement), expectedMaterialId: 'aluminum',
        first: { memberId: 'a-beam', nodeId: 'a-base' }, second: { memberId: 'b-beam', nodeId: 'b-base' },
        youngMPa: 1000, poisson: .25, effectiveThroatMm: 2, complianceLengthMm: 1,
        propertySource: TEST_EVIDENCE, idealization: 'rectangular-effective-elastic-throat' };
    }) };
  return { document, definition, associations, context: { currentSource: base.stamp,
    bodies: new Map([[partKeyOf(a.source), [body]]]), assemblyOptions: {} } };
}

describe('保存済み斜角の現在CAD有効のど', () => {
  it.each([false, true])('60度の実plan/build/端部断面を通し、世界変換を一度だけ行う outer=%s', outer => {
    const f = obliqueLayerFixture(outer), before = structuredClone(f.document);
    const result = prepareCadWeldLayers(f.document, f.definition, f.associations, f.context), w = result.welds[0];
    const y = 3 * Math.sqrt(3) + 2 * Math.sqrt(3 / 13), z = 3 + 1 / Math.sqrt(13);
    const center = outer ? [(7 - y) / 1000, .013, (z + 5) / 1000] : [.015, y / 1000, z / 1000];
    const normal = outer ? [-1 / Math.sqrt(13), 0, -2 * Math.sqrt(3 / 13)] : [0, 1 / Math.sqrt(13), -2 * Math.sqrt(3 / 13)];
    center.forEach((v, i) => expect(w.centerM[i]).toBeCloseTo(v, 12));
    normal.forEach((v, i) => expect(w.normal[i]).toBeCloseTo(v, 12));
    (outer ? [0, 1, 0] : [1, 0, 0]).forEach((v, i) => expect(w.along[i]).toBeCloseTo(v, 12));
    expect(w.widthM * w.lengthM).toBeCloseTo(40e-6, 15);
    expect(w.youngPa).toBe(1e9); expect(w.poisson).toBe(.25); expect(w.thicknessM).toBe(.001);
    expect(f.document).toEqual(before);
  });

  it('不規則な全区間と隙間を保持し、部分群・古いsource・pose・materialを拒否する', () => {
    const f = obliqueLayerFixture(false, [{ start: 5, length: 10 }, { start: 25, length: 20 }]);
    const result = prepareCadWeldLayers(f.document, f.definition, f.associations, f.context);
    expect(result.welds.map(w => w.widthM)).toEqual([.01, .02]);
    result.welds.map(w => w.centerM[0]).forEach((v, i) => expect(v).toBeCloseTo([.01, .035][i], 12));
    expect(() => prepareCadWeldLayers(f.document, f.definition, { ...f.associations, welds: f.associations.welds.slice(0, 1) }, f.context)).toThrow('No silent merging');
    expect(() => prepareCadWeldLayers(f.document, f.definition, f.associations,
      { ...f.context, currentSource: { ...f.context.currentSource, geometryRevision: 'stale' } })).toThrow();
    const id = f.associations.welds[1].beadComponentId;
    for (const change of [{ materialId: 'steel' }, { placement: testPlacement([99, 0, 0]) }, { suppressed: true }]) {
      const doc = { ...f.document, components: f.document.components.map(c => c.id === id ? { ...c, ...change } : c) };
      expect(() => prepareCadWeldLayers(doc, f.definition, f.associations, f.context)).toThrow();
    }
  });

  it('実のど高度を超える明示値を拒否する', () => {
    const f = obliqueLayerFixture();
    expect(() => prepareCadWeldLayers(f.document, f.definition, { ...f.associations,
      welds: f.associations.welds.map(w => ({ ...w, effectiveThroatMm: 6 })) }, f.context)).toThrow('actual saved section');
  });

  it.each([{ interiorAngleDegrees: 61 }, { cylindricalRadius: 10 },
    { cylindricalRadius: 11 }, { cylindricalRadius: 10, cylindricalSide: 'interior' as const }])(
    '全区間の角/半径/内外を完全一致させ、不一致を別入力として拒否する %o', patch => {
      const f = obliqueLayerFixture(false, [{ start: 5, length: 10 }, { start: 25, length: 20 }]);
      const id = f.associations.welds[1].beadComponentId;
      const doc = { ...f.document, components: f.document.components.map(c => {
        if (c.id !== id || c.source.kind !== 'standardPart') return c;
        const options = filletWeldSegmentOptions(c.source.options);
        if (options === null) throw new Error('Missing saved options');
        const { interiorAngleDegrees: oldAngle, ...withoutAngle } = options;
        expect(oldAngle).toBeCloseTo(60, 10);
        return { ...c, source: createFilletWeldSource(6, 8, { ...withoutAngle, ...patch }) };
      }) };
      const associations = { ...f.associations, welds: f.associations.welds.map(w => {
        const c = doc.components.find(row => row.id === w.beadComponentId);
        if (c === undefined) throw new Error('Missing member');
        return { ...w, expectedPartKey: partKeyOf(c.source) };
      }) };
      expect(() => prepareCadWeldLayers(doc, f.definition, associations, f.context)).toThrow('No silent merging');
    });
});
