/**
 * 安全柵(E-12 第 2 段の ③)の側から E-07 の窓へ渡す、柵の T の接続の一覧: 柱の途中に横の材の端が当たる T だけを入れ、同じ形(同じ呼び・
 * 同じ面)の接続は 1 つの組にまとめ、柵の外の部材との接続は入れない事。部材は一括配置の道で置く(手で解いた配置)。
 */
import { createAssemblyDocument, PRODUCT_CATALOG_REGISTRY, type AssemblyDocument, type RigidPlacement } from '@pointercad/model';
import { beforeAll, describe, expect, it } from 'vitest';

import { frameMembersDocument } from './frameMembersPlacement.js';
import { safetyFenceJoints } from './safetyFenceJoints.js';

const SERIES = { kind: 'catalogItem', familyId: 't-slot-frame-series', itemKey: 's6-20x20', values: {} } as const;
const NONE = { quarterTurns: 0, startExtension: 0, endExtension: 0, corners: 'none', swapThrough: [] } as const;

/** 柱 2 本(x = 0 と 1000、上の向きは +X)と、その間の高さ 500 の横の材 1 本(柱の面の間 10〜990)、柵の外の部材 1 本(横の材の上に T)。 */
function fence(): { readonly document: AssemblyDocument; readonly ids: readonly string[]; readonly outsider: string } {
  let document = createAssemblyDocument('柵');
  const add = (lines: readonly { readonly start: readonly [number, number, number]; readonly end: readonly [number, number, number] }[],
    up: readonly [number, number, number]): readonly string[] => {
    const placed = frameMembersDocument(document, { member: SERIES, lines, up, ...NONE });
    if (!placed.ok) throw new Error(placed.reason);
    document = placed.document;
    return placed.componentIds;
  };
  const posts = add([{ start: [0, 0, 0], end: [0, 0, 1000] }, { start: [1000, 0, 0], end: [1000, 0, 1000] }], [1, 0, 0]);
  const rails = add([{ start: [10, 0, 500], end: [990, 0, 500] }], [0, 0, 1]);
  const [outsider] = add([{ start: [500, 0, 510], end: [500, 0, 800] }], [1, 0, 0]);
  if (outsider === undefined) throw new Error('outsider');
  return { document, ids: [...posts, ...rails], outsider };
}

const placementsOf = (document: AssemblyDocument): ReadonlyMap<string, RigidPlacement> => new Map(document.components.map((component) => [
  component.id, { position: [component.placement.position[0].value, component.placement.position[1].value, component.placement.position[2].value],
    rotation: component.placement.rotation }]));

beforeAll(async () => { await PRODUCT_CATALOG_REGISTRY.ensure(['t-slot-frame-series']); });

describe('柵の T の接続の一覧', () => {
  it('横の材の両端が柱の途中に当たる T が 2 つで、柱の両側の面から当たっても同じ形の 1 つの組。柵の外の部材との接続は入れない', () => {
    const { document, ids, outsider } = fence();
    const result = safetyFenceJoints(document, placementsOf(document), ids);
    expect(result.jointIds).toHaveLength(2);
    expect(result.groups).toEqual([{ key: expect.stringContaining('t-slot-frame-series/s6-20x20') as string, jointIds: result.jointIds }]);
    expect(result.jointIds.some((id) => id.includes(outsider))).toBe(false);
  });
});
