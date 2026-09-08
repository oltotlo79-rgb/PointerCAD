import { describe, expect, it } from 'vitest';

import { createEmptyPartDocument } from '../part/createPartDocument.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from './createAssemblyDocument.js';
import {
  assemblyMassProperties, materialOf, PARTIAL_ASSEMBLY_MASS_MESSAGE,
  type AssemblyMassBody, type MaterialBearingPartDocument,
} from './massProperties.js';
import { IDENTITY_PLACEMENT, quaternionFromAxisAngle, type RigidPlacement } from './placementMath.js';
import type { AssemblyComponent, AssemblyDocument } from './types.js';

function component(id: string, overrides: Partial<AssemblyComponent> = {}): AssemblyComponent {
  return {
    id, name: id, source: { kind: 'part', partRef: `part-${id}` },
    placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed: false,
    ...overrides,
  };
}

function assembly(...components: readonly AssemblyComponent[]): AssemblyDocument {
  return { ...createAssemblyDocument('組立'), components };
}

const BOX: AssemblyMassBody = { volume: 8000, centroid: [10, 10, 10] };

function resolved(
  components: readonly AssemblyComponent[],
  bodies: ReadonlyMap<string, readonly AssemblyMassBody[]> = new Map(
    components.map((item) => [item.source.kind === 'part' ? item.source.partRef : item.id, [BOX]]),
  ),
) {
  return {
    partKeys: new Map(components.map((item) => [
      item.id, item.source.kind === 'part' ? item.source.partRef : item.id,
    ])),
    bodies,
  };
}

function placements(...entries: readonly (readonly [string, RigidPlacement])[]): ReadonlyMap<string, RigidPlacement> {
  return new Map(entries);
}

describe('materialOf', () => {
  it('部品文書の材質を最優先する', () => {
    const part: MaterialBearingPartDocument = { ...createEmptyPartDocument(), materialId: 'copper' };
    expect(materialOf(component('1', { materialId: 'aluminum' }), part)).toBe('copper');
  });

  it('部品文書に無ければインスタンスの材質を使う', () => {
    expect(materialOf(component('1', { materialId: 'aluminum' }), createEmptyPartDocument())).toBe('aluminum');
  });

  it('どちらにも無ければ鋼を使う', () => {
    expect(materialOf(component('1'))).toBe('steel');
  });
});

describe('assemblyMassProperties', () => {
  it('20mm角の鋼の箱は8000mm³・62.8g', () => {
    const item = component('1');
    const result = assemblyMassProperties(assembly(item), resolved([item]), placements(['1', IDENTITY_PLACEMENT]));
    expect(result.volume).toBe(8000);
    expect(result.mass).toBeCloseTo(62.8, 12);
    expect(result.centroid).toEqual([10, 10, 10]);
  });

  it('X=0と40に置いた同じ箱の重心Xは30', () => {
    const first = component('1');
    const second = component('2', { source: first.source });
    const data = resolved([first, second], new Map([['part-1', [BOX]]]));
    const result = assemblyMassProperties(assembly(first, second), data, placements(
      ['1', IDENTITY_PLACEMENT], ['2', { ...IDENTITY_PLACEMENT, position: [40, 0, 0] }],
    ));
    expect(result.volume).toBe(16000);
    expect(result.mass).toBeCloseTo(125.6, 12);
    expect(result.centroid?.[0]).toBeCloseTo(30, 12);
  });

  it('鋼とA5052では重心が鋼側へ寄る', () => {
    const steel = component('1');
    const aluminum = component('2', { source: steel.source, materialId: 'aluminum' });
    const data = resolved([steel, aluminum], new Map([['part-1', [BOX]]]));
    const result = assemblyMassProperties(assembly(steel, aluminum), data, placements(
      ['1', IDENTITY_PLACEMENT], ['2', { ...IDENTITY_PLACEMENT, position: [40, 0, 0] }],
    ));
    expect(result.centroid?.[0]).toBeCloseTo((10 * 62.8 + 50 * 21.44) / (62.8 + 21.44), 12);
  });

  it('抑制した部品は数えない', () => {
    const kept = component('1');
    const suppressed = component('2', { source: kept.source, suppressed: true });
    const result = assemblyMassProperties(assembly(kept, suppressed), resolved([kept, suppressed], new Map([['part-1', [BOX]]])), placements(
      ['1', IDENTITY_PLACEMENT], ['2', IDENTITY_PLACEMENT],
    ));
    expect(result.volume).toBe(8000);
  });

  it('非表示の部品も組み立ての一部として数える', () => {
    const item = component('1', { visible: false });
    expect(assemblyMassProperties(assembly(item), resolved([item]), placements(['1', IDENTITY_PLACEMENT])).mass).toBeCloseTo(62.8, 12);
  });

  it('形が無い部品は残りを計算しつつ部分結果とする', () => {
    const known = component('1');
    const missing = component('2');
    const data = resolved([known, missing], new Map([['part-1', [BOX]]]));
    const result = assemblyMassProperties(assembly(known, missing), data, placements(
      ['1', IDENTITY_PLACEMENT], ['2', IDENTITY_PLACEMENT],
    ));
    expect(result).toMatchObject({
      volume: 8000, mass: null, partial: true,
      message: PARTIAL_ASSEMBLY_MASS_MESSAGE,
    });
    expect(result.knownMass).toBeCloseTo(62.8, 12);
  });

  it('壊れた体積は部分結果にする', () => {
    const item = component('1');
    const result = assemblyMassProperties(assembly(item), resolved([item], new Map([
      ['part-1', [{ volume: Number.NaN, centroid: [0, 0, 0] }]],
    ])), placements(['1', IDENTITY_PLACEMENT]));
    expect(result).toMatchObject({ mass: null, knownMass: 0, partial: true });
  });

  it('知らない材質は部分結果にする', () => {
    const item = component('1', { materialId: 'unknown-material' });
    expect(assemblyMassProperties(assembly(item), resolved([item]), placements(['1', IDENTITY_PLACEMENT])).partial).toBe(true);
  });

  it('配置の回転と平行移動を重心へ適用する', () => {
    const item = component('1');
    const rotated: RigidPlacement = {
      position: [20, 0, 0], rotation: quaternionFromAxisAngle([0, 0, 1], Math.PI / 2),
    };
    const result = assemblyMassProperties(assembly(item), resolved([item]), placements(['1', rotated]));
    expect(result.centroid?.[0]).toBeCloseTo(10, 12);
    expect(result.centroid?.[1]).toBeCloseTo(10, 12);
  });

  it('複数ボディの体積と重心を合算する', () => {
    const item = component('1');
    const data = resolved([item], new Map([['part-1', [
      { volume: 1000, centroid: [0, 0, 0] }, { volume: 3000, centroid: [4, 0, 0] },
    ]]]));
    const result = assemblyMassProperties(assembly(item), data, placements(['1', IDENTITY_PLACEMENT]));
    expect(result.volume).toBe(4000);
    expect(result.centroid?.[0]).toBeCloseTo(3, 12);
  });

  it('部品文書の材質でインスタンスの材質を上書きする', () => {
    const item = component('1', { materialId: 'aluminum' });
    const part: MaterialBearingPartDocument = { ...createEmptyPartDocument(), materialId: 'copper' };
    const data = { ...resolved([item]), documents: new Map([['part-1', part]]) };
    expect(assemblyMassProperties(assembly(item), data, placements(['1', IDENTITY_PLACEMENT])).mass).toBeCloseTo(71.68, 12);
  });

  it('部品が0個なら0で完全な結果を返す', () => {
    expect(assemblyMassProperties(assembly(), resolved([]), new Map())).toEqual({
      volume: 0, mass: 0, knownMass: 0, centroid: null, partial: false, message: null,
    });
  });
});
