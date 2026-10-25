import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { addComponent, createComponentFor, moveComponent } from '../assemblyEdit.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import { buildStandardPartFromSource } from '../standard/buildStandardPart.js';
import { STANDARD_CATALOG_REVISION, STANDARD_PART_GENERATOR_REVISION } from '../standard/types.js';
import type { AssemblyDocument, ComponentSource, Placement } from '../types.js';
import type { Vec3 } from '../../sketch/vec3.js';
import { applyBoltedJoint } from './applyBoltedJoint.js';
import { planBoltedJoint } from './planBoltedJoint.js';
import type { BoltedJointPlan, BoltedJointRequest, FasteningHoleSpec } from './types.js';

const REVISIONS = new Map([['plateA', 'rev-a'], ['plateB', 'rev-b']]);

function placement(position: Vec3): Placement {
  return { position: [expressionValueFromNumber(position[0]), expressionValueFromNumber(position[1]),
    expressionValueFromNumber(position[2])], rotation: [0, 0, 0, 1] };
}

function plates(): AssemblyDocument {
  let document = createAssemblyDocument('組立1');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'plateA' }, { placement: placement([0, 0, 0]) }));
  return addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'plateB' }, { placement: placement([0, 0, 0]) }));
}

function hole(componentId: string, partRef: string, spec: FasteningHoleSpec, into: Vec3): BoltedJointRequest['first'] {
  return {
    componentId, sourceKey: `part:${partRef}@${REVISIONS.get(partRef) ?? ''}`, holeFeatureId: 'hole-1',
    matingFace: { bodyFeatureId: 'extrude-1', index: 0, fingerprint: {
      kind: 'face', surfaceKind: 'plane', area: 100, position: [0, 0, 0], axis: into, radius: null } },
    hole: spec, axisOrigin: [0, 0, 0], axisDirection: into, matingFaceNormal: [-into[0], -into[1], -into[2]],
  };
}

/** 板A(厚さ10、−Z へ)と板B(厚さ12、+Z へ)の M8 通し穴。確認済みの長さは検査用の入力。 */
const REQUEST: BoltedJointRequest = {
  first: hole('component-1', 'plateA', { kind: 'clearance', diameter: 9, length: 10 }, [0, 0, -1]),
  second: hole('component-2', 'plateB', { kind: 'clearance', diameter: 9, length: 12 }, [0, 0, 1]),
  dimensionSeries: 'annexJA', explicitBolt: { nominal: 'M8', threadSeries: 'coarse' }, minimumProtrusion: 0,
  headWashers: [], nutWashers: [],
  lengthAvailability: [{ boltRowKey: 'JIS-B-1180:2014:M8:P1.25:annexJA', lengths: [25, 30, 35], basis: 'perDiameterEvidence',
    verified: true, source: 'test fixture (not a JIS value)' }],
};

function plan(document: AssemblyDocument): BoltedJointPlan {
  const result = planBoltedJoint(document, REQUEST, REVISIONS);
  if (!result.ok) throw new Error(JSON.stringify(result.rejections));
  return result.plan;
}

describe('締結の計画を文書へ足す', () => {
  it('既存の規格部品の出どころでボルトとナットを1回の新しい文書として足し、固定しない', () => {
    const document = plates();
    const before = JSON.stringify(document);
    const result = applyBoltedJoint(document, plan(document), REVISIONS);
    if (!result.ok) throw new Error(JSON.stringify(result.rejections));
    expect(JSON.stringify(document)).toBe(before);
    expect(result.componentIds).toEqual(['component-3', 'component-4']);
    const [bolt, nut] = result.document.components.slice(2);
    const expectedBolt: ComponentSource = {
      kind: 'standardPart', catalog: 'hexBolt', size: 'M8',
      options: { length: '30', dimensionSeries: 'annexJA', threadSeries: 'coarse' },
      catalogRevision: STANDARD_CATALOG_REVISION, generatorRevision: STANDARD_PART_GENERATOR_REVISION,
    };
    expect(bolt?.source).toEqual(expectedBolt);
    expect(nut?.source).toEqual({ ...expectedBolt, catalog: 'hexNut', options: { dimensionSeries: 'annexJA', threadSeries: 'coarse' } });
    expect([bolt?.name, nut?.name]).toEqual(['六角ボルト M8×30:1', '六角ナット M8:1']);
    expect([bolt?.fixed, nut?.fixed]).toEqual([false, false]);
    expect(bolt?.placement.position.map((value) => value.value)).toEqual([0, 0, -10]);
    expect(nut?.placement.position.map((value) => value.value)).toEqual([0, 0, 12]);
  });

  it('足したボルト・ナットの台本は穴と同じ呼び・ピッチのねじの情報を持つ', () => {
    const document = plates();
    const result = applyBoltedJoint(document, plan(document), REVISIONS);
    if (!result.ok) throw new Error('apply failed');
    const [bolt, nut] = result.document.components.slice(2);
    if (bolt?.source.kind !== 'standardPart' || nut?.source.kind !== 'standardPart') throw new Error('not standard');
    const shaft = buildStandardPartFromSource(bolt.source)?.solids.find((solid) => solid.kind === 'threadShaft');
    const tapped = buildStandardPartFromSource(nut.source)?.solids.find((solid) => solid.kind === 'threadHole');
    // b1(附属書JA M8)=22 < 呼び長さ30 なので、ねじ部の長さは 22。実らせんではなく簡略表示。
    expect(shaft?.kind === 'threadShaft' ? [shaft.nominal, shaft.pitch.value, shaft.length.value, shaft.modeled] : null)
      .toEqual(['M8', 1.25, 22, false]);
    expect(tapped?.kind === 'threadHole' ? [tapped.designation, tapped.pitch.value, tapped.representation] : null)
      .toEqual(['M8', 1.25, 'simplified']);
  });

  it('計画の後に部品が動いた・出どころの版が変わった時は足さずに元の文書を返す', () => {
    const document = plates();
    const planned = plan(document);
    const moved = moveComponent(document, 'component-2', placement([0, 0, 1]));
    const afterMove = applyBoltedJoint(moved, planned, REVISIONS);
    expect(afterMove.ok).toBe(false);
    expect(afterMove.document).toBe(moved);
    const revised = applyBoltedJoint(document, planned, new Map([['plateA', 'rev-a'], ['plateB', 'rev-b2']]));
    expect(revised.ok ? [] : revised.rejections.map((rejection) => rejection.code)).toEqual(['staleSource']);
    expect(revised.document).toBe(document);
  });

  it('断った計画は文書を変えない', () => {
    const document = plates();
    const before = JSON.stringify(document);
    const result = planBoltedJoint(document, { ...REQUEST, minimumProtrusion: -1 }, REVISIONS);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(document)).toBe(before);
  });
});
