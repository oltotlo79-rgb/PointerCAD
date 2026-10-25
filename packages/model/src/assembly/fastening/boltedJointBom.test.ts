import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { addComponent, createComponentFor } from '../assemblyEdit.js';
import { buildBom, bomPartName } from '../bom.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import type { AssemblyDocument, Placement } from '../types.js';
import type { Vec3 } from '../../sketch/vec3.js';
import { applyBoltedJoint } from './applyBoltedJoint.js';
import { planBoltedJoint } from './planBoltedJoint.js';
import type { BoltedJointRequest, FasteningHoleSpec } from './types.js';

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

/** 板A(厚さ10)と板B(厚さ12)の M8 通し穴に、頭側とナット側の平座金を1枚ずつ置く。 */
const REQUEST: BoltedJointRequest = {
  first: hole('component-1', 'plateA', { kind: 'clearance', diameter: 9, length: 10 }, [0, 0, -1]),
  second: hole('component-2', 'plateB', { kind: 'clearance', diameter: 9, length: 12 }, [0, 0, 1]),
  dimensionSeries: 'annexJA', explicitBolt: { nominal: 'M8', threadSeries: 'coarse' }, minimumProtrusion: 0,
  headWashers: ['plainWasher'], nutWashers: ['plainWasher'],
  lengthAvailability: [{ boltRowKey: 'JIS-B-1180:2014:M8:P1.25:annexJA', lengths: [25, 30, 35], basis: 'perDiameterEvidence',
    verified: true, source: 'test fixture (not a JIS value)' }],
};

function applied(): { readonly document: AssemblyDocument; readonly componentIds: readonly string[] } {
  const document = plates();
  const planned = planBoltedJoint(document, REQUEST, REVISIONS);
  if (!planned.ok) throw new Error(JSON.stringify(planned.rejections));
  const result = applyBoltedJoint(document, planned.plan, REVISIONS);
  if (!result.ok) throw new Error(JSON.stringify(result.rejections));
  return result;
}

describe('実際に足した締結の金物は部品表で整合する(EX-06)', () => {
  it('ボルト・座金2枚・ナットは出どころごとの行になり、数量の合計が部品の数と一致する', () => {
    const { document, componentIds } = applied();
    const added = document.components.filter((component) => componentIds.includes(component.id));
    const catalogs = added.map((component) => (component.source.kind === 'standardPart' ? component.source.catalog : component.source.kind));
    expect([...catalogs].sort()).toEqual(['hexBolt', 'hexNut', 'plainWasher', 'plainWasher']);
    const rows = buildBom(document, { partKeys: new Map(), bodies: new Map() });
    // 板2枚 + ボルト + 座金(2枚を1行) + ナット。
    expect(rows).toHaveLength(5);
    expect(rows.reduce((sum, row) => sum + row.quantity, 0)).toBe(document.components.length);
    for (const component of added) {
      const owning = rows.filter((row) => row.componentIds.includes(component.id));
      expect(owning).toHaveLength(1);
      expect(owning[0]?.name).toBe(bomPartName(component));
    }
    const washerIds = added.filter((component) => component.source.kind === 'standardPart' && component.source.catalog === 'plainWasher')
      .map((component) => component.id);
    const washerRow = rows.find((row) => row.componentIds.includes(washerIds[0] ?? ''));
    expect(washerRow?.quantity).toBe(2);
    expect([...(washerRow?.componentIds ?? [])].sort()).toEqual([...washerIds].sort());
    for (const catalog of ['hexBolt', 'hexNut'] as const) {
      const ids = added.filter((component) => component.source.kind === 'standardPart' && component.source.catalog === catalog)
        .map((component) => component.id);
      expect(ids).toHaveLength(1);
      expect(rows.find((row) => row.componentIds.includes(ids[0] ?? ''))?.quantity).toBe(1);
    }
  });
});
