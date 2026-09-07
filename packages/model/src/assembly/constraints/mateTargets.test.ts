/**
 * 合致の対象の解決の検査(計画書 docs/plans/P7-アセンブリ.md タスク12 の検証表)。
 *
 * 期待値はすべて手で導ける値にしてある(20³ の箱の上面の重心は `(10, 10, 20)`、
 * Z 軸まわり 90° は法線を変えない、など)。**形は作らない**——`resolveMateTarget` は
 * カーネルを呼ばない純関数で、部分形状の位置・軸・半径は指紋から取る。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import { beforeAll, describe, expect, it } from 'vitest';

import type {
  EdgeCurveKind,
  FaceSurfaceKind,
  SubShapeFingerprint,
  SubShapeRef,
} from '../../geometry/subShapeRef.js';
import { appendSolid, createEmptyPartDocument } from '../../part/createPartDocument.js';
import type { PartDocument, PrimitiveFeature } from '../../part/types.js';
import { absoluteCoordinate } from '../../sketch/createSketchDocument.js';
import type { Vec3 } from '../../sketch/vec3.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import { embedPart, EMPTY_PART_LIBRARY, type PartLibrary } from '../partLibrary.js';
import { IDENTITY_QUATERNION, type Quaternion, quaternionFromAxisAngle, type RigidPlacement } from '../placementMath.js';
import { MISSING_PART_MESSAGE, resolveAssembly, type ResolvedAssembly } from '../resolveAssembly.js';
import type { AssemblyComponent, Mate, MateTarget, OriginElement, Placement } from '../types.js';
import { prepareMateResiduals } from './mateResiduals.js';
import {
  MISSING_AXIS_MESSAGE,
  MISSING_MATE_TARGET_MESSAGE,
  type MateTargetErrorCode,
  type MateTargetOutcome,
  resolveMateTarget,
  type ResolvedMateTarget,
  UNUSABLE_FACE_MESSAGE,
} from './mateTargets.js';

/** 取り込みの時刻を固定して、抱き込みの結果を決定的にする。 */
const IMPORTED_AT = '2026-09-06T00:00:00.000Z';

/** 検証表が求める誤差(回転を掛けた向きの丸め)。 */
const TOLERANCE = 1e-12;

/** 一辺 20mm の箱を 1 段だけ持つ部品文書。ボディの id は `solid-1`。 */
function boxPart(): PartDocument {
  const feature: PrimitiveFeature = {
    id: 'solid-1',
    name: '箱1',
    suppressed: false,
    kind: 'primitive',
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) },
    axis: { kind: 'world', axis: 'z' },
    shape: {
      kind: 'box',
      sizeX: expressionValueFromNumber(20),
      sizeY: expressionValueFromNumber(20),
      sizeZ: expressionValueFromNumber(20),
    },
  };
  return appendSolid(createEmptyPartDocument(), feature);
}

async function libraryWithBox(): Promise<PartLibrary> {
  const result = await embedPart(
    EMPTY_PART_LIBRARY,
    boxPart(),
    '箱.pcad',
    '../parts/箱.pcad',
    { importedAt: IMPORTED_AT },
  );
  return result.library;
}

function placementOf(position: Vec3, rotation: Quaternion = IDENTITY_QUATERNION): Placement {
  return {
    position: [
      expressionValueFromNumber(position[0]),
      expressionValueFromNumber(position[1]),
      expressionValueFromNumber(position[2]),
    ],
    rotation,
  };
}

function componentOf(placement: Placement, overrides: Partial<AssemblyComponent> = {}): AssemblyComponent {
  return {
    id: 'component-1',
    name: '箱:1',
    source: { kind: 'part', partRef: 'part-1' },
    placement,
    fixed: false,
    visible: true,
    suppressed: false,
    ...overrides,
  };
}

let library: PartLibrary;

beforeAll(async () => {
  library = await libraryWithBox();
});

/** 箱 1 個を置いたアセンブリの解決結果。 */
function resolvedWith(
  placement: Placement = DEFAULT_COMPONENT_PLACEMENT,
  overrides: Partial<AssemblyComponent> = {},
  parts?: PartLibrary,
): ResolvedAssembly {
  const assembly = {
    ...createAssemblyDocument('組立1'),
    components: [componentOf(placement, overrides)],
  };
  return resolveAssembly(assembly, { library: parts ?? library });
}

function faceRef(
  surfaceKind: FaceSurfaceKind,
  position: Vec3,
  axis: Vec3 | null,
  radius: number | null,
  bodyFeatureId = 'solid-1',
): SubShapeRef {
  return {
    bodyFeatureId,
    index: 4,
    fingerprint: { kind: 'face', surfaceKind, area: 400, position, axis, radius },
  };
}

function edgeRef(
  curveKind: EdgeCurveKind,
  length: number,
  position: Vec3,
  axis: Vec3 | null,
  radius: number | null,
): SubShapeRef {
  return {
    bodyFeatureId: 'solid-1',
    index: 7,
    fingerprint: { kind: 'edge', curveKind, length, position, axis, radius },
  };
}

function vertexRef(position: Vec3): SubShapeRef {
  return { bodyFeatureId: 'solid-1', index: 2, fingerprint: { kind: 'vertex', position } };
}

function subShapeTarget(reference: SubShapeRef): MateTarget {
  return { kind: 'subShape', componentId: 'component-1', ref: reference };
}

function originTargetOf(element: OriginElement): MateTarget {
  return { kind: 'origin', componentId: 'component-1', element };
}

/** 20³ の箱の上面(原点が角)。重心 `(10, 10, 20)`、法線 `(0, 0, 1)`。 */
const TOP_FACE = faceRef('plane', [10, 10, 20], [0, 0, 1], null);

function accepted(outcome: MateTargetOutcome): ResolvedMateTarget {
  if (!outcome.ok) {
    throw new Error(`解決できなかった: ${outcome.message}`);
  }
  return outcome.target;
}

function expectRefused(
  outcome: MateTargetOutcome,
  code: MateTargetErrorCode,
  message: string,
): void {
  if (outcome.ok) {
    throw new Error('断られるはずの対象が解決した');
  }
  expect(outcome.code).toBe(code);
  expect(outcome.message).toBe(message);
}

function expectClose(actual: Vec3 | null, expected: Vec3, tolerance = TOLERANCE): void {
  if (actual === null) {
    throw new Error('向きが取れなかった');
  }
  for (let index = 0; index < 3; index += 1) {
    expect(Math.abs(actual[index] - expected[index]), `成分 ${index}`).toBeLessThanOrEqual(
      tolerance,
    );
  }
}

describe('平らな面(計画書 タスク12 の検証表)', () => {
  it('20³ の箱の上面は 点 (10,10,20)・向き (0,0,1)', () => {
    const target = accepted(resolveMateTarget(subShapeTarget(TOP_FACE), resolvedWith()));

    expect(target.kind).toBe('plane');
    expectClose(target.point, [10, 10, 20]);
    expectClose(target.direction, [0, 0, 1]);
    expect(target.radius).toBeNull();
  });

  it('同じ面を (10,0,0) へ移した部品では 点 (20,10,20)・向きは変わらない', () => {
    const resolved = resolvedWith(placementOf([10, 0, 0]));

    const target = accepted(resolveMateTarget(subShapeTarget(TOP_FACE), resolved));

    expectClose(target.point, [20, 10, 20]);
    expectClose(target.direction, [0, 0, 1]);
  });

  it('Z 軸まわり 90° 回した部品では 点 (−10,10,20)。Z 回転は法線を変えない', () => {
    const resolved = resolvedWith(placementOf([0, 0, 0], quaternionFromAxisAngle([0, 0, 1], Math.PI / 2)));

    const target = accepted(resolveMateTarget(subShapeTarget(TOP_FACE), resolved));

    expectClose(target.point, [-10, 10, 20]);
    expectClose(target.direction, [0, 0, 1]);
  });

  it('X 軸まわり 90° 回した部品では 向き (0,−1,0)、点 (10,−20,10)', () => {
    const resolved = resolvedWith(placementOf([0, 0, 0], quaternionFromAxisAngle([1, 0, 0], Math.PI / 2)));

    const target = accepted(resolveMateTarget(subShapeTarget(TOP_FACE), resolved));

    expectClose(target.direction, [0, -1, 0]);
    // (10,10,20) を X まわりに 90° 回すと (x, −z, y) = (10, −20, 10)。
    expectClose(target.point, [10, -20, 10]);
  });

  it('回した部品でも向きの長さは 1 のまま', () => {
    const resolved = resolvedWith(placementOf([3, 4, 5], quaternionFromAxisAngle([1, 1, 1], 0.7)));

    const target = accepted(resolveMateTarget(subShapeTarget(TOP_FACE), resolved));

    expect(target.direction).not.toBeNull();
    expect(Math.hypot(...(target.direction ?? [0, 0, 0]))).toBeCloseTo(1, 12);
  });

  it('法線の取れない平らな面は断る(投げない)', () => {
    const reference = faceRef('plane', [10, 10, 20], null, null);

    expectRefused(
      resolveMateTarget(subShapeTarget(reference), resolvedWith()),
      'unusableFace',
      UNUSABLE_FACE_MESSAGE,
    );
  });
});

describe('曲がった面(§0.a-0.13、§2.12)', () => {
  it('円柱(半径 5、Z 軸)の側面は 種類 cylinder・向き (0,0,1)・半径 5', () => {
    const reference = faceRef('cylinder', [0, 0, 10], [0, 0, 1], 5);

    const target = accepted(resolveMateTarget(subShapeTarget(reference), resolvedWith()));

    expect(target.kind).toBe('cylinder');
    expectClose(target.direction, [0, 0, 1]);
    expect(target.radius).toBe(5);
  });

  it('球面は断る(「この面は合致に使えません。…」)', () => {
    const reference = faceRef('sphere', [0, 0, 0], null, 8);

    expectRefused(
      resolveMateTarget(subShapeTarget(reference), resolvedWith()),
      'unusableFace',
      UNUSABLE_FACE_MESSAGE,
    );
  });

  it('トーラスと自由曲面も同じ文言で断る', () => {
    for (const surfaceKind of ['torus', 'other'] as const) {
      const reference = faceRef(surfaceKind, [0, 0, 0], [0, 0, 1], null);
      expectRefused(
        resolveMateTarget(subShapeTarget(reference), resolvedWith()),
        'unusableFace',
        UNUSABLE_FACE_MESSAGE,
      );
    }
  });

  it('円錐の面は軸として取れる(§0.a-0.13「円筒面/円錐面の軸」)。半径は持たない', () => {
    const reference = faceRef('cone', [0, 0, 4], [0, 0, 1], 3);

    const target = accepted(resolveMateTarget(subShapeTarget(reference), resolvedWith()));

    expect(target.kind).toBe('axis');
    expectClose(target.direction, [0, 0, 1]);
    expect(target.radius).toBeNull();
  });

  it('半径の無い円柱面は断る(形が決まらない)', () => {
    const reference = faceRef('cylinder', [0, 0, 10], [0, 0, 1], null);

    expectRefused(
      resolveMateTarget(subShapeTarget(reference), resolvedWith()),
      'unusableFace',
      UNUSABLE_FACE_MESSAGE,
    );
  });
});

describe('辺と頂点(FR-609)', () => {
  it('まっすぐな辺は 中点と向きの軸になる', () => {
    const reference = edgeRef('line', 20, [10, 0, 0], [1, 0, 0], null);

    const target = accepted(resolveMateTarget(subShapeTarget(reference), resolvedWith()));

    expect(target.kind).toBe('axis');
    expectClose(target.point, [10, 0, 0]);
    expectClose(target.direction, [1, 0, 0]);
  });

  it('全周の円の辺は 中心・軸・半径が取れる', () => {
    const radius = 4;
    const reference = edgeRef('circle', 2 * Math.PI * radius, [0, 0, 20], [0, 0, 1], radius);

    const target = accepted(resolveMateTarget(subShapeTarget(reference), resolvedWith()));

    expect(target.kind).toBe('axis');
    expectClose(target.point, [0, 0, 20]);
    expect(target.radius).toBe(radius);
  });

  it('欠けた円弧は断る(重心が中心に無いため軸の上の点が決まらない)', () => {
    const radius = 4;
    const reference = edgeRef('circle', Math.PI * radius, [0, 0, 20], [0, 0, 1], radius);

    expectRefused(
      resolveMateTarget(subShapeTarget(reference), resolvedWith()),
      'missingAxis',
      MISSING_AXIS_MESSAGE,
    );
  });

  it('楕円と自由曲線の辺は「この形からは軸が決まりません。」と断る', () => {
    for (const curveKind of ['ellipse', 'other'] as const) {
      const reference = edgeRef(curveKind, 30, [0, 0, 0], [0, 0, 1], null);
      expectRefused(
        resolveMateTarget(subShapeTarget(reference), resolvedWith()),
        'missingAxis',
        MISSING_AXIS_MESSAGE,
      );
    }
  });

  it('頂点は 点になり、配置を掛けた世界座標で返る', () => {
    const resolved = resolvedWith(placementOf([1, 2, 3]));

    const target = accepted(resolveMateTarget(subShapeTarget(vertexRef([20, 20, 20])), resolved));

    expect(target.kind).toBe('point');
    expectClose(target.point, [21, 22, 23]);
    expect(target.direction).toBeNull();
  });
});

describe('部品の原点・3 軸・3 平面(FR-329)', () => {
  it('部品の X 軸は 点 (0,0,0)・向き (1,0,0)', () => {
    const target = accepted(resolveMateTarget(originTargetOf('x'), resolvedWith()));

    expect(target.kind).toBe('axis');
    expectClose(target.point, [0, 0, 0]);
    expectClose(target.direction, [1, 0, 0]);
  });

  it('部品の原点は 向きを持たない点', () => {
    const target = accepted(resolveMateTarget(originTargetOf('origin'), resolvedWith()));

    expect(target.kind).toBe('point');
    expectClose(target.point, [0, 0, 0]);
    expect(target.direction).toBeNull();
  });

  it('基準の 3 面の法線は既存の固定表と同じ(xy は (0,0,1)、xz は (0,−1,0)、yz は (1,0,0))', () => {
    const normals: Readonly<Record<'xy' | 'xz' | 'yz', Vec3>> = {
      xy: [0, 0, 1],
      xz: [0, -1, 0],
      yz: [1, 0, 0],
    };
    for (const element of ['xy', 'xz', 'yz'] as const) {
      const target = accepted(resolveMateTarget(originTargetOf(element), resolvedWith()));
      expect(target.kind).toBe('plane');
      expectClose(target.direction, normals[element]);
    }
  });

  it('部品を動かすと 原点の要素も一緒に動く', () => {
    const resolved = resolvedWith(placementOf([5, 0, 0], quaternionFromAxisAngle([0, 0, 1], Math.PI / 2)));

    const target = accepted(resolveMateTarget(originTargetOf('x'), resolved));

    expectClose(target.point, [5, 0, 0]);
    // Z まわり 90° は X 軸を Y 軸へ向ける。
    expectClose(target.direction, [0, 1, 0]);
  });

  it('部品の中身が引けなくても 原点の要素は解ける(置いた場所は分かっている)', () => {
    const resolved = resolvedWith(DEFAULT_COMPONENT_PLACEMENT, {}, EMPTY_PART_LIBRARY);

    const target = accepted(resolveMateTarget(originTargetOf('z'), resolved));

    expectClose(target.direction, [0, 0, 1]);
  });
});

describe('見つからないもの(FR-504、NFR-RE-1)', () => {
  it('見つからない部品は断る(投げない)', () => {
    const target: MateTarget = {
      kind: 'subShape',
      componentId: 'component-9',
      ref: TOP_FACE,
    };

    expectRefused(
      resolveMateTarget(target, resolvedWith()),
      'missingComponent',
      MISSING_PART_MESSAGE,
    );
  });

  it('抑制した部品も同じく断る(配置が無い)', () => {
    const resolved = resolvedWith(DEFAULT_COMPONENT_PLACEMENT, { suppressed: true });

    expectRefused(
      resolveMateTarget(subShapeTarget(TOP_FACE), resolved),
      'missingComponent',
      MISSING_PART_MESSAGE,
    );
  });

  it('部品文書が引けないインスタンスの部分形状は断る', () => {
    const resolved = resolvedWith(DEFAULT_COMPONENT_PLACEMENT, {}, EMPTY_PART_LIBRARY);

    expectRefused(
      resolveMateTarget(subShapeTarget(TOP_FACE), resolved),
      'missingComponent',
      MISSING_PART_MESSAGE,
    );
  });

  it('消えたボディを指す対象は断る。対象そのものは消さない(P3 §6.10-1)', () => {
    const reference = faceRef('plane', [10, 10, 20], [0, 0, 1], null, 'solid-9');
    const target = subShapeTarget(reference);

    expectRefused(
      resolveMateTarget(target, resolvedWith()),
      'missingSubShape',
      MISSING_MATE_TARGET_MESSAGE,
    );
    // 断っても引数の対象は変わらない(呼び出し側が持っている合致は残る)。
    expect(target.kind === 'subShape' && target.ref.bodyFeatureId).toBe('solid-9');
  });

  it('位置が数でない指紋は断る(NaN をソルバへ流さない)', () => {
    const reference = faceRef('plane', [Number.NaN, 0, 0], [0, 0, 1], null);

    expectRefused(
      resolveMateTarget(subShapeTarget(reference), resolvedWith()),
      'missingSubShape',
      MISSING_MATE_TARGET_MESSAGE,
    );
  });
});

describe('選び直し(P4 の流儀)', () => {
  it('選び直した指紋を渡すと、そちらの位置と向きを使う', () => {
    const moved: SubShapeFingerprint = {
      kind: 'face',
      surfaceKind: 'plane',
      area: 400,
      position: [10, 10, 30],
      axis: [0, 0, 1],
      radius: null,
    };

    const target = accepted(
      resolveMateTarget(subShapeTarget(TOP_FACE), resolvedWith(), {
        subShape: () => moved,
      }),
    );

    expectClose(target.point, [10, 10, 30]);
  });

  it('選び直しには部品の鍵と保存された参照が渡る(インスタンスの id ではない)', () => {
    const calls: { readonly partKey: string; readonly bodyFeatureId: string }[] = [];

    accepted(
      resolveMateTarget(subShapeTarget(TOP_FACE), resolvedWith(), {
        subShape: (partKey, reference) => {
          calls.push({ partKey, bodyFeatureId: reference.bodyFeatureId });
          return reference.fingerprint;
        },
      }),
    );

    expect(calls).toEqual([{ partKey: 'part-1', bodyFeatureId: 'solid-1' }]);
  });

  it('選び直せなかった(null)ときは、保存された指紋へ戻さずに断る', () => {
    expectRefused(
      resolveMateTarget(subShapeTarget(TOP_FACE), resolvedWith(), { subShape: () => null }),
      'missingSubShape',
      MISSING_MATE_TARGET_MESSAGE,
    );
  });
});

describe('決定性(§0.a-0.54)', () => {
  it('同じ対象を 2 回解いても同じ値', () => {
    const resolved = resolvedWith(placementOf([1, 2, 3], quaternionFromAxisAngle([0, 1, 0], 0.3)));

    const first = accepted(resolveMateTarget(subShapeTarget(TOP_FACE), resolved));
    const second = accepted(resolveMateTarget(subShapeTarget(TOP_FACE), resolved));

    expect(second).toEqual(first);
  });
});

describe('解析軸上点の世界座標化(P7-14b)', () => {
  function prepareAgainstOrigin(target: ResolvedMateTarget, resolved: ResolvedAssembly) {
    const origin = accepted(resolveMateTarget(originTargetOf('z'), resolved));
    const mate: Mate = { id: 'mate-1', name: '同心', kind: 'concentric',
      a: originTargetOf('z'), b: originTargetOf('z'), flipped: false, suppressed: false };
    return prepareMateResiduals({ mates: [mate],
      targets: new Map([[mate.id, { a: target, b: origin }]]), placements: resolved.placements });
  }

  it('基準の3軸は定義上の軸上点を持ち、残差準備でmissingAxisにならない', () => {
    const resolved = resolvedWith(placementOf([3, 4, 5]));
    for (const element of ['x', 'y', 'z'] as const) {
      const target = accepted(resolveMateTarget(originTargetOf(element), resolved));
      expectClose(target.axisOrigin ?? null, [3, 4, 5]);
      expect(prepareAgainstOrigin(target, resolved).skipped).toEqual([]);
    }
  });

  it('直線辺の中点は定義上軸上なので軸上点を渡す', () => {
    const resolved = resolvedWith();
    const target = accepted(resolveMateTarget(
      subShapeTarget(edgeRef('line', 10, [3, 4, 5], [1, 0, 0], null)), resolved,
    ));
    expectClose(target.axisOrigin ?? null, [3, 4, 5]);
    expect(prepareAgainstOrigin(target, resolved).skipped).toEqual([]);
  });

  it('回転と並進を解析点へ1回掛け、代表点と軸を混ぜない', () => {
    const ref = faceRef('cylinder', [7, 8, 9], [0, 0, 1], 5);
    const resolved = resolvedWith(placementOf([11, 13, 17], quaternionFromAxisAngle([1, 0, 0], Math.PI / 2)));
    const target = accepted(resolveMateTarget(subShapeTarget(ref), resolved, {
      subShape: () => ({ ...ref.fingerprint, axisOrigin: [1, 2, 3] }),
    }));
    expectClose(target.axisOrigin ?? null, [12, 10, 19]);
    expectClose(target.point, [18, 4, 25]);
    expectClose(target.direction, [0, -1, 0]);
    expect(target.radius).toBe(5);
    const prepared = prepareAgainstOrigin(target, resolved);
    expect(prepared.skipped).toEqual([]);
    expectClose(prepared.mates[0].a.point, [1, 2, 3]);
  });

  it('親のX90°と子のZ90°を外側から合成して解析点を世界へ置く', () => {
    const parent: RigidPlacement = { position: [11, 13, 17], rotation: quaternionFromAxisAngle([1, 0, 0], Math.PI / 2) };
    const assembly = { ...createAssemblyDocument('親子'), components: [componentOf(
      placementOf([1, 2, 3], quaternionFromAxisAngle([0, 0, 1], Math.PI / 2)),
    )] };
    const resolved = resolveAssembly(assembly, { library, parent });
    const ref = faceRef('cone', [8, 9, 10], [0, 0, 1], 5);
    const target = accepted(resolveMateTarget(subShapeTarget(ref), resolved, {
      subShape: () => ({ ...ref.fingerprint, axisOrigin: [2, 0, 0] }),
    }));
    // 子: (2,0,0)→(1,4,3)、親: (1,4,3)→(12,10,21)。
    expectClose(target.axisOrigin ?? null, [12, 10, 21]);
    expectClose(target.direction, [0, -1, 0]);
    expect(target.kind).toBe('axis');
    expect(target.radius).toBeNull();
  });

  it('解析点の選び直しがnullなら旧円筒の重心へ後退しない', () => {
    const ref = faceRef('cylinder', [0, 0, 5], [0, 0, 1], 5);
    expectRefused(resolveMateTarget(subShapeTarget(ref), resolvedWith(), { subShape: () => null }),
      'missingSubShape', MISSING_MATE_TARGET_MESSAGE);
  });

  it('解析点のNaNと正負の無限大は理由つきで断る', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const ref = faceRef('cylinder', [0, 0, 5], [0, 0, 1], 5);
      expectRefused(resolveMateTarget(subShapeTarget(ref), resolvedWith(), {
        subShape: () => ({ ...ref.fingerprint, axisOrigin: [value, 0, 0] }),
      }), 'missingAxis', MISSING_AXIS_MESSAGE);
    }
  });

  it('旧円筒・円錐・全周円の指紋だけでは解析点を捏造せず残差準備で断る', () => {
    const resolved = resolvedWith();
    const refs = [
      faceRef('cylinder', [0, 0, 5], [0, 0, 1], 5),
      faceRef('cone', [0, 0, 5], [0, 0, 1], 5),
      edgeRef('circle', 10 * Math.PI, [0, 0, 5], [0, 0, 1], 5),
    ];
    for (const ref of refs) {
      const target = accepted(resolveMateTarget(subShapeTarget(ref), resolved));
      expect('axisOrigin' in target).toBe(false);
      const prepared = prepareAgainstOrigin(target, resolved);
      expect(prepared.mates).toHaveLength(0);
      expect(prepared.skipped.map((entry) => entry.reason)).toEqual(['missingAxis']);
    }
  });

  it('同じ半円の指紋でも再計算から解析中心が届いた場合だけ軸を返す', () => {
    const ref = edgeRef('circle', 5 * Math.PI, [0, 10 / Math.PI, 10], [0, 0, 1], 5);
    const resolved = resolvedWith();
    expectRefused(resolveMateTarget(subShapeTarget(ref), resolved), 'missingAxis', MISSING_AXIS_MESSAGE);
    const target = accepted(resolveMateTarget(subShapeTarget(ref), resolved, {
      subShape: () => ({ ...ref.fingerprint, axisOrigin: [0, 0, 10] }),
    }));
    expectClose(target.point, [0, 10 / Math.PI, 10]);
    expectClose(target.axisOrigin ?? null, [0, 0, 10]);
    expect(target.kind).toBe('axis');
    expect(target.radius).toBe(5);
    expect(prepareAgainstOrigin(target, resolved).skipped).toEqual([]);
  });
});
