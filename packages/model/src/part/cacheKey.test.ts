import { describe, expect, it } from 'vitest';

import {
  cacheKeyFor,
  hash64,
  KEY_DECIMALS,
  keyMaterialText,
  keyNumber,
  type BooleanKeyMaterial,
  type ChamferKeyMaterial,
  type CutKeyMaterial,
  type DraftKeyMaterial,
  type EmbossKeyMaterial,
  type ExtrudeKeyMaterial,
  type FilletKeyMaterial,
  type HoleKeyMaterial,
  type KeyCurve,
  type KeyEllipse,
  type KeySpline,
  type KeySubShape,
  type KeyTransform,
  type KeyVec3,
  type MirrorKeyMaterial,
  type PrimitiveKeyMaterial,
  type RevolveKeyMaterial,
  type RibKeyMaterial,
  type ScaleKeyMaterial,
  type SewKeyMaterial,
  type ShellKeyMaterial,
  type SolidStepKeyMaterial,
  type SpringKeyMaterial,
  type SurfaceKeyMaterial,
  type SurfaceShapeKeyMaterial,
  type SweepKeyMaterial,
  type ThreadKeyMaterial,
  type ThreadShaftKeyMaterial,
  type ThruSectionKeyMaterial,
  type ThruSectionsKeyMaterial,
  type TransformKeyMaterial,
} from './cacheKey.js';
// 指紋の文字列化は subShapeRef.ts の1本だけを使う(丸めの規則を2か所に書かない、タスク14)。
import { fingerprintKeyText } from './subShapeRef.js';

const SQUARE_PROFILE: readonly KeyCurve[] = [
  { kind: 'segment', from: [0, 0, 0], to: [10, 0, 0] },
  { kind: 'segment', from: [10, 0, 0], to: [10, 10, 0] },
  { kind: 'segment', from: [10, 10, 0], to: [0, 10, 0] },
  { kind: 'segment', from: [0, 10, 0], to: [0, 0, 0] },
];

/** 文字列の固定用に使う最小の断面(1本だけ)。 */
const ONE_SEGMENT: readonly KeyCurve[] = [{ kind: 'segment', from: [0, 0, 0], to: [1, 0, 0] }];

function extrude(distance: number, profile: readonly KeyCurve[] = SQUARE_PROFILE): ExtrudeKeyMaterial {
  return { kind: 'extrude', profile, direction: [0, 0, 1], distance };
}

function revolve(angle: number): RevolveKeyMaterial {
  return {
    kind: 'revolve',
    profile: SQUARE_PROFILE,
    axisOrigin: [0, 0, 0],
    axisDirection: [0, 0, 1],
    angle,
  };
}

function sew(profiles: readonly (readonly KeyCurve[])[], tolerance = 0.01): SewKeyMaterial {
  return { kind: 'sew', profiles, tolerance };
}

function boolean(targetKey: string, toolKey: string): BooleanKeyMaterial {
  return { kind: 'boolean', operation: 'union', targetKey, toolKey };
}

/** 上流のボディの鍵に見立てた固定文字列(鍵の連鎖の検査で差し替える)。 */
const TARGET_KEY = 'aaaa1111bbbb2222';

/**
 * 面の指紋の文字列(計画書 §2.2.3 の検算表と同じ箱: 40×30 を Z へ10押し出した上面)。
 * `fingerprintKeyText` をそのまま使うので、丸めの規則(9桁、-0 は 0)も1本で揃う。
 */
function faceFingerprint(index = 0, area = 1200): KeySubShape {
  return fingerprintKeyText({
    bodyFeatureId: 'extrude-1',
    index,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'plane',
      area,
      position: [20, 15, 10],
      axis: [0, 0, 1],
      radius: null,
    },
  });
}

/** 辺の指紋の文字列。通し番号だけを変えて別の辺を作る。 */
function edgeFingerprint(index: number): KeySubShape {
  return fingerprintKeyText({
    bodyFeatureId: 'extrude-1',
    index,
    fingerprint: {
      kind: 'edge',
      curveKind: 'line',
      length: 40,
      position: [0, 15, 10],
      axis: [1, 0, 0],
      radius: null,
    },
  });
}

/** 恒等の剛体変換(何も動かさない)。空の transforms との違いを見るために使う。 */
const IDENTITY_TRANSFORM: KeyTransform = {
  translation: [0, 0, 0],
  rotationOrigin: [0, 0, 0],
  rotationAxis: [0, 0, 1],
  rotationAngle: 0,
};

function hole(overrides: Partial<Omit<HoleKeyMaterial, 'kind'>> = {}): HoleKeyMaterial {
  return {
    kind: 'hole',
    targetKey: TARGET_KEY,
    face: faceFingerprint(),
    centers: [[10, 10, 0]],
    diameter: 6,
    depth: null,
    tiltAngle: 0,
    tiltAzimuth: 0,
    transforms: [],
    ...overrides,
  };
}

/** M6 並目・簡略表示のねじ穴(下穴径は D1 = 6 − 1.082532×1)。 */
function thread(overrides: Partial<Omit<ThreadKeyMaterial, 'kind'>> = {}): ThreadKeyMaterial {
  return {
    kind: 'thread',
    targetKey: TARGET_KEY,
    face: faceFingerprint(),
    centers: [[10, 10, 0]],
    drillDiameter: 4.917468,
    majorDiameter: 6,
    pitch: 1,
    threadLength: 10,
    depth: null,
    modeled: false,
    tiltAngle: 0,
    tiltAzimuth: 0,
    transforms: [],
    ...overrides,
  };
}

function fillet(overrides: Partial<Omit<FilletKeyMaterial, 'kind'>> = {}): FilletKeyMaterial {
  return {
    kind: 'fillet',
    targetKey: TARGET_KEY,
    targets: [edgeFingerprint(0), edgeFingerprint(1)],
    radius: 5,
    ...overrides,
  };
}

function chamfer(overrides: Partial<Omit<ChamferKeyMaterial, 'kind'>> = {}): ChamferKeyMaterial {
  return {
    kind: 'chamfer',
    targetKey: TARGET_KEY,
    targets: [edgeFingerprint(0), edgeFingerprint(1)],
    mode: 'equal',
    distance1: 2,
    distance2: 0,
    swapReferenceFace: false,
    ...overrides,
  };
}

/** 既定のばね(§0.a-0.30: ピッチ5・巻数4・コイル径20・線径2・右巻き)。 */
function spring(overrides: Partial<Omit<SpringKeyMaterial, 'kind'>> = {}): SpringKeyMaterial {
  return {
    kind: 'spring',
    origin: [10, 10, 0],
    direction: [0, 0, 1],
    coilDiameter: 20,
    wireDiameter: 2,
    pitch: 5,
    turns: 4,
    handedness: 'right',
    ...overrides,
  };
}

/** 頂点の指紋の文字列(基本形状の基準点に立体の頂点を指したとき)。 */
function vertexFingerprint(index = 0, position: KeyVec3 = [0, 0, 0]): KeySubShape {
  return fingerprintKeyText({
    bodyFeatureId: 'extrude-1',
    index,
    fingerprint: { kind: 'vertex', position },
  });
}

/**
 * 既定の基本形状(§0.a-0.16: 球 半径10)。基準点は原点の座標なので
 * `originQuery` / `targetKey` は無い(頂点を指したときだけ入る)。
 */
function primitive(overrides: Partial<Omit<PrimitiveKeyMaterial, 'kind'>> = {}): PrimitiveKeyMaterial {
  return {
    kind: 'primitive',
    origin: [0, 0, 0],
    axis: [0, 0, 1],
    shape: { kind: 'sphere', radius: 10 },
    originQuery: null,
    targetKey: null,
    ...overrides,
  };
}

/**
 * 罫線面・ロフト(FR-430、FR-410、P5 タスク25)の断面。
 * 3 通り(輪郭・球・立体の面)を短く書くための道具。
 */
function curvesSection(curves: readonly KeyCurve[] = ONE_SEGMENT): ThruSectionKeyMaterial {
  return { kind: 'curves', curves };
}

function sphereSection(radius = 10, center: KeyVec3 = [0, 0, 40]): ThruSectionKeyMaterial {
  return { kind: 'sphere', center, radius };
}

function faceQuerySection(
  targetKey = 'aaaa1111bbbb2222',
  query: KeySubShape = faceFingerprint(),
): ThruSectionKeyMaterial {
  return { kind: 'faceQuery', targetKey, query };
}

/**
 * 既定の「面をつなぐ」の材料(輪郭 1 つ + 球 1 つを直線で結ぶ)。
 * ロフトは `ruled: false` にしただけの同じ段(§0.a-0.25)。
 */
function thruSections(
  overrides: Partial<Omit<ThruSectionsKeyMaterial, 'kind'>> = {},
): ThruSectionsKeyMaterial {
  return {
    kind: 'thruSections',
    sections: [curvesSection(), sphereSection()],
    ruled: true,
    closed: true,
    twist: 0,
    sphereSegments: 24,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// P5 の Should 群・Could 群(タスク44)の材料を短く書くための道具。
// 角度はどれも**ラジアン**(段の依頼と同じ単位)。
// ---------------------------------------------------------------------------

/** 5 度をラジアンにした値(抜き勾配・テーパの見本)。 */
const FIVE_DEGREES = (5 * Math.PI) / 180;

/** 90 度をラジアンにした値(皿もみの開き角の既定)。 */
const NINETY_DEGREES = Math.PI / 2;

function draft(overrides: Partial<Omit<DraftKeyMaterial, 'kind'>> = {}): DraftKeyMaterial {
  return {
    kind: 'draft',
    targetKey: TARGET_KEY,
    faces: [faceFingerprint(1), faceFingerprint(2)],
    neutralFace: faceFingerprint(9),
    angle: FIVE_DEGREES,
    reversed: false,
    ...overrides,
  };
}

function mirror(overrides: Partial<Omit<MirrorKeyMaterial, 'kind'>> = {}): MirrorKeyMaterial {
  return {
    kind: 'mirror',
    targetKey: TARGET_KEY,
    origin: [0, 0, 0],
    normal: [0, 0, 1],
    ...overrides,
  };
}

function transform(
  overrides: Partial<Omit<TransformKeyMaterial, 'kind'>> = {},
): TransformKeyMaterial {
  return {
    kind: 'transform',
    targetKey: TARGET_KEY,
    translation: [10, 0, 0],
    rotationOrigin: [0, 0, 0],
    rotationAxis: [0, 0, 1],
    rotationAngle: 0,
    ...overrides,
  };
}

function scale(overrides: Partial<Omit<ScaleKeyMaterial, 'kind'>> = {}): ScaleKeyMaterial {
  return {
    kind: 'scale',
    targetKey: TARGET_KEY,
    origin: [0, 0, 0],
    uniform: 2,
    perAxis: null,
    ...overrides,
  };
}

function sweep(overrides: Partial<Omit<SweepKeyMaterial, 'kind'>> = {}): SweepKeyMaterial {
  return {
    kind: 'sweep',
    profile: SQUARE_PROFILE,
    path: ONE_SEGMENT,
    frenet: false,
    ...overrides,
  };
}

function rib(overrides: Partial<Omit<RibKeyMaterial, 'kind'>> = {}): RibKeyMaterial {
  return {
    kind: 'rib',
    targetKey: TARGET_KEY,
    profile: ONE_SEGMENT,
    normal: [0, 1, 0],
    thickness: 2,
    symmetric: true,
    direction: [0, 0, -1],
    ...overrides,
  };
}

function emboss(overrides: Partial<Omit<EmbossKeyMaterial, 'kind'>> = {}): EmbossKeyMaterial {
  return {
    kind: 'emboss',
    targetKey: TARGET_KEY,
    face: faceFingerprint(),
    profiles: [SQUARE_PROFILE],
    depth: 1,
    raised: false,
    ...overrides,
  };
}

/** M6 並目の外ねじ、簡略表示(§0.a-0.40)。面は円柱の側面のつもりで別の通し番号にする。 */
function threadShaft(
  overrides: Partial<Omit<ThreadShaftKeyMaterial, 'kind'>> = {},
): ThreadShaftKeyMaterial {
  return {
    kind: 'threadShaft',
    targetKey: TARGET_KEY,
    face: faceFingerprint(3, 188.495559),
    majorDiameter: 6,
    pitch: 1,
    length: 10,
    fromEnd: 'first',
    modeled: false,
    ...overrides,
  };
}

/** 曲面の作り方(FR-428)の既定「輪郭を掃いた面」。長さだけを変えられるようにする。 */
function surfaceExtrude(distance = 10): SurfaceShapeKeyMaterial {
  return { kind: 'extrude', profile: ONE_SEGMENT, direction: [0, 0, 1], distance };
}

/** 曲面の作り方「輪郭どうしをつないだ面」。罫線かなめらかかだけを変えられるようにする。 */
function surfaceLoft(ruled = true): SurfaceShapeKeyMaterial {
  return { kind: 'loft', sections: [ONE_SEGMENT, SQUARE_PROFILE], ruled };
}

function surface(
  shape: SurfaceShapeKeyMaterial = surfaceExtrude(),
  targetKey: string | null = null,
): SurfaceKeyMaterial {
  return { kind: 'surface', shape, targetKey };
}

function cut(overrides: Partial<Omit<CutKeyMaterial, 'kind'>> = {}): CutKeyMaterial {
  return {
    kind: 'cut',
    targetKey: TARGET_KEY,
    origin: [0, 0, 5],
    normal: [0, 0, 1],
    keepPositive: true,
    ...overrides,
  };
}

function shell(overrides: Partial<Omit<ShellKeyMaterial, 'kind'>> = {}): ShellKeyMaterial {
  return {
    kind: 'shell',
    targetKey: TARGET_KEY,
    openFaces: [faceFingerprint()],
    thickness: 2,
    outward: false,
    ...overrides,
  };
}

/** 22種類ぶんの材料を1つずつ。順序は SolidStepKeyMaterial の union の並びに合わせる。 */
const ALL_KINDS: readonly SolidStepKeyMaterial[] = [
  extrude(10),
  revolve(90),
  sew([SQUARE_PROFILE]),
  boolean('key-a', 'key-b'),
  hole(),
  thread(),
  fillet(),
  chamfer(),
  spring(),
  primitive(),
  thruSections(),
  // P5 の Should 群・Could 群(タスク44)。
  draft(),
  mirror(),
  transform(),
  scale(),
  sweep(),
  rib(),
  emboss(),
  threadShaft(),
  surface(),
  cut(),
  shell(),
];

describe('KEY_DECIMALS', () => {
  it('は9桁', () => {
    expect(KEY_DECIMALS).toBe(9);
  });
});

describe('keyNumber', () => {
  it('-0 と 0 は同じ文字列になる(Object.is では区別できるが鍵では同一視する)', () => {
    expect(Object.is(-0, 0)).toBe(false); // 前提の確認: double としては別物
    expect(keyNumber(-0)).toBe(keyNumber(0));
    expect(keyNumber(-0)).toBe('0.000000000');
  });

  it('非数(NaN)は x になる', () => {
    expect(keyNumber(Number.NaN)).toBe('x');
  });

  it('無限大は x になる(正負とも)', () => {
    expect(keyNumber(Number.POSITIVE_INFINITY)).toBe('x');
    expect(keyNumber(Number.NEGATIVE_INFINITY)).toBe('x');
  });

  it('9桁で丸める(toFixed(9))', () => {
    expect(keyNumber(1.23456789012)).toBe('1.234567890');
  });
});

describe('hash64: 決定性・形式', () => {
  it('同じ入力は2回呼んでも同じ文字列になる', () => {
    expect(hash64('abc')).toBe(hash64('abc'));
  });

  it('戻り値は長さ16の16進文字列', () => {
    const key = hash64('abc');
    expect(key).toHaveLength(16);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  it('空文字列でも例外にならず16桁を返す', () => {
    expect(() => hash64('')).not.toThrow();
    const key = hash64('');
    expect(key).toHaveLength(16);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });
});

/**
 * FNV-1a 32bit の公式テストベクトル(出典: L. C. Noll の参照実装に付属する
 * test_fnv.c 系のテストベクトルとして広く引用される値。
 * http://www.isthe.com/chongo/tech/comp/fnv/ )。
 *
 * hash64 の前半8桁(レーン1)は、標準の FNV-1a 32bit オフセット基底
 * (0x811c9dc5)をそのまま使っているので、標準の値と一致するはずである。
 * 後半8桁(レーン2)は開始点が違う(§0.a-0.20)ため公式ベクトルとは一致しない
 * (=既知の値では検算できない)。決定性・長さ・分布はここより上の property テストで見る。
 *
 * "a" の手計算による独立検算:
 *   h0 = 0x811c9dc5 (オフセット基底)
 *   'a' の文字コードは 0x61
 *   h1 = h0 XOR 0x61 = 0x811c9da4
 *   h2 = (h1 * 0x01000193) mod 2^32
 *      = (0x811c9da4 * 0x01000193) mod 2^32   … BigInt で独立に計算
 *      = 0xe40c292c
 *   (公式ベクトルの e40c292c と一致)
 */
describe('hash64: FNV-1a 32bit の公式テストベクトル(レーン1 = 標準オフセット)', () => {
  it('空文字列 → オフセット基底そのもの(0x811c9dc5)', () => {
    expect(hash64('').slice(0, 8)).toBe('811c9dc5');
  });

  it('"a" → 0xe40c292c', () => {
    expect(hash64('a').slice(0, 8)).toBe('e40c292c');
  });

  it('"foobar" → 0xbf9cf968', () => {
    expect(hash64('foobar').slice(0, 8)).toBe('bf9cf968');
  });

  it('"chongo was here!\\n" → 0xd49930d5', () => {
    expect(hash64('chongo was here!\n').slice(0, 8)).toBe('d49930d5');
  });
});

describe('hash64: 200件の異なる入力で重複しない', () => {
  it('1件ずつ変えた200個の文字列がすべて別の鍵になる', () => {
    const keys = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      keys.add(hash64(`solid-step-${index}:x=${index * 0.001}`));
    }
    expect(keys.size).toBe(200);
  });
});

describe('cacheKeyFor: 同じ材料は同じ鍵', () => {
  it('同じ押し出しの材料を2回渡しても同じ鍵になる', () => {
    expect(cacheKeyFor(extrude(10))).toBe(cacheKeyFor(extrude(10)));
  });

  it('同じブーリアンの材料(同じ targetKey/toolKey)は同じ鍵になる', () => {
    const a = boolean('aaaa1111bbbb2222', 'cccc3333dddd4444');
    const b = boolean('aaaa1111bbbb2222', 'cccc3333dddd4444');
    expect(cacheKeyFor(a)).toBe(cacheKeyFor(b));
  });
});

describe('cacheKeyFor: 種別の違い', () => {
  it('extrude と revolve は同じ断面・同じ数値でも違う鍵になる', () => {
    const a = extrude(10);
    const b: RevolveKeyMaterial = {
      kind: 'revolve',
      profile: SQUARE_PROFILE,
      axisOrigin: [0, 0, 1],
      axisDirection: [0, 0, 0],
      angle: 10,
    };
    expect(cacheKeyFor(a)).not.toBe(cacheKeyFor(b));
  });

  it('sew と boolean は違う鍵になる(段の種類が文字列の先頭に混ざるので混同しない)', () => {
    const s = sew([SQUARE_PROFILE]);
    const b = boolean('key-a', 'key-b');
    expect(cacheKeyFor(s)).not.toBe(cacheKeyFor(b));
  });
});

describe('cacheKeyFor: 数値パラメータの丸め(KEY_DECIMALS = 9)', () => {
  it('1e-9 の差(10 → 10.000000001)は違う鍵になる', () => {
    expect(cacheKeyFor(extrude(10))).not.toBe(cacheKeyFor(extrude(10.000000001)));
  });

  it('1e-10 の差(10 → 10.0000000001)は9桁より下なので同じ鍵になる', () => {
    expect(cacheKeyFor(extrude(10))).toBe(cacheKeyFor(extrude(10.0000000001)));
  });

  it('1e-3 の差(10 → 10.001)は明確に違う鍵になる', () => {
    expect(cacheKeyFor(extrude(10))).not.toBe(cacheKeyFor(extrude(10.001)));
  });

  it('座標が 1e-9 だけ違う断面は違う鍵になる', () => {
    const shifted: readonly KeyCurve[] = SQUARE_PROFILE.map((curve) =>
      curve.kind === 'segment'
        ? { ...curve, from: [curve.from[0] + 1e-9, curve.from[1], curve.from[2]] as const }
        : curve,
    );
    expect(cacheKeyFor(extrude(10))).not.toBe(cacheKeyFor(extrude(10, shifted)));
  });

  it('座標が 1e-10 だけ違う断面は丸めで同じ鍵になる', () => {
    const shifted: readonly KeyCurve[] = SQUARE_PROFILE.map((curve) =>
      curve.kind === 'segment'
        ? { ...curve, from: [curve.from[0] + 1e-10, curve.from[1], curve.from[2]] as const }
        : curve,
    );
    expect(cacheKeyFor(extrude(10))).toBe(cacheKeyFor(extrude(10, shifted)));
  });

  it('-0 と 0 を含む向きは同じ鍵になる', () => {
    const a: ExtrudeKeyMaterial = { kind: 'extrude', profile: SQUARE_PROFILE, direction: [0, 0, 1], distance: 10 };
    const b: ExtrudeKeyMaterial = { kind: 'extrude', profile: SQUARE_PROFILE, direction: [-0, 0, 1], distance: 10 };
    expect(cacheKeyFor(a)).toBe(cacheKeyFor(b));
  });
});

describe('cacheKeyFor: 上流の鍵の違いが下流へ伝わる(§0.a-0.20 の連鎖)', () => {
  it('ブーリアンの targetKey が違えば結果の鍵も違う', () => {
    const a = boolean('1111111111111111', '2222222222222222');
    const b = boolean('9999999999999999', '2222222222222222');
    expect(cacheKeyFor(a)).not.toBe(cacheKeyFor(b));
  });

  it('ブーリアンの toolKey が違えば結果の鍵も違う', () => {
    const a = boolean('1111111111111111', '2222222222222222');
    const b = boolean('1111111111111111', '8888888888888888');
    expect(cacheKeyFor(a)).not.toBe(cacheKeyFor(b));
  });

  it('上流フィーチャーの材料が変わって上流の鍵(cacheKeyFor)が変わると、それを材料に積む下流のブーリアンの鍵も変わる', () => {
    const upstreamBefore = cacheKeyFor(extrude(10));
    const upstreamAfter = cacheKeyFor(extrude(20));
    expect(upstreamBefore).not.toBe(upstreamAfter);

    const otherToolKey = cacheKeyFor(extrude(5));
    const downstreamBefore = cacheKeyFor(boolean(upstreamBefore, otherToolKey));
    const downstreamAfter = cacheKeyFor(boolean(upstreamAfter, otherToolKey));
    expect(downstreamBefore).not.toBe(downstreamAfter);
  });

  it('操作(union/subtract/intersect)が違えば同じ対象・相手でも違う鍵になる', () => {
    const target = cacheKeyFor(extrude(10));
    const tool = cacheKeyFor(extrude(5));
    const union: BooleanKeyMaterial = { kind: 'boolean', operation: 'union', targetKey: target, toolKey: tool };
    const subtract: BooleanKeyMaterial = { kind: 'boolean', operation: 'subtract', targetKey: target, toolKey: tool };
    expect(cacheKeyFor(union)).not.toBe(cacheKeyFor(subtract));
  });
});

describe('cacheKeyFor: 順序の違いは別の鍵', () => {
  it('押し出しの断面の曲線の並び順が違えば違う鍵になる(閉ループとしては同じでも順序が違う)', () => {
    const reversed = [...SQUARE_PROFILE].reverse();
    expect(cacheKeyFor(extrude(10, SQUARE_PROFILE))).not.toBe(cacheKeyFor(extrude(10, reversed)));
  });

  it('縫合の面の並び順が違えば違う鍵になる', () => {
    const faceA: readonly KeyCurve[] = SQUARE_PROFILE;
    const faceB: readonly KeyCurve[] = SQUARE_PROFILE.map((curve) =>
      curve.kind === 'segment'
        ? { ...curve, from: [curve.from[0], curve.from[1], curve.from[2] + 5] as const }
        : curve,
    );
    expect(cacheKeyFor(sew([faceA, faceB]))).not.toBe(cacheKeyFor(sew([faceB, faceA])));
  });
});

describe('cacheKeyFor: 配列の長さを混ぜる(衝突対策)', () => {
  it('同じ曲線1本だけの縫合と、それを2本重ねた縫合は違う鍵になる(長さが材料に混ざる)', () => {
    const one = sew([SQUARE_PROFILE]);
    const two = sew([SQUARE_PROFILE, SQUARE_PROFILE]);
    expect(cacheKeyFor(one)).not.toBe(cacheKeyFor(two));
  });

  it('断面の曲線が1本多いだけの押し出しは違う鍵になる', () => {
    const withExtra: readonly KeyCurve[] = [...SQUARE_PROFILE, SQUARE_PROFILE[0]];
    expect(cacheKeyFor(extrude(10, SQUARE_PROFILE))).not.toBe(cacheKeyFor(extrude(10, withExtra)));
  });
});

describe('cacheKeyFor: 名前・抑制・色を材料に含めない設計', () => {
  it('SolidStepKeyMaterial の型そのものに名前・抑制・色の欄が無いので、同じ形の材料は常に同じ鍵になる', () => {
    // ここで確かめたいのは「型の設計として、名前等を混ぜられない」こと。
    // 同じ幾何パラメータの材料を2つ独立に組み立てても鍵が一致することで、
    // model 側で名前だけを変えても鍵は変わらないことを裏付ける。
    const a = revolve(180);
    const b = revolve(180);
    expect(cacheKeyFor(a)).toBe(cacheKeyFor(b));
  });
});

describe('keyMaterialText', () => {
  it('段の種類を先頭のキーワードとして含む', () => {
    expect(keyMaterialText(extrude(10))).toMatch(/^extrude\{/);
    expect(keyMaterialText(revolve(90))).toMatch(/^revolve\{/);
    expect(keyMaterialText(sew([SQUARE_PROFILE]))).toMatch(/^sew\{/);
    expect(keyMaterialText(boolean('a', 'b'))).toMatch(/^boolean\{/);
  });

  it('決定的(同じ材料には同じ文字列)', () => {
    const material: SolidStepKeyMaterial = extrude(10);
    expect(keyMaterialText(material)).toBe(keyMaterialText(extrude(10)));
  });
});

// ---------------------------------------------------------------------------
// 以下は P3 タスク14 で足した加工フィーチャー(穴・ねじ穴・R 面取り・C 面取り)と
// ばねの材料の検査。**具体的なハッシュ値は期待値に書かない**(docs/報告記録.md
// 2026-09-03 07:58 の②)。確かめるのは「決定性」と「衝突しないこと」の2つの性質だけ。
// ---------------------------------------------------------------------------

describe('keyMaterialText: P2 の4種類の文字列が変わっていない(既存の鍵を壊さない)', () => {
  // 鍵の文字列が1文字でも変わると P2 で作った形状キャッシュが全滅するので、
  // 読める形(ハッシュ前の材料の文字列)で固定する。ハッシュの具体値は書かない。
  it('押し出しの材料の文字列', () => {
    expect(keyMaterialText(extrude(2, ONE_SEGMENT))).toBe(
      'extrude{profile=1:[segment(0.000000000,0.000000000,0.000000000|1.000000000,0.000000000,0.000000000)]' +
        ';direction=0.000000000,0.000000000,1.000000000;distance=2.000000000}',
    );
  });

  it('回転の材料の文字列', () => {
    const material: RevolveKeyMaterial = {
      kind: 'revolve',
      profile: ONE_SEGMENT,
      axisOrigin: [0, 0, 0],
      axisDirection: [0, 0, 1],
      angle: 90,
    };
    expect(keyMaterialText(material)).toBe(
      'revolve{profile=1:[segment(0.000000000,0.000000000,0.000000000|1.000000000,0.000000000,0.000000000)]' +
        ';axisOrigin=0.000000000,0.000000000,0.000000000' +
        ';axisDirection=0.000000000,0.000000000,1.000000000;angle=90.000000000}',
    );
  });

  it('縫合の材料の文字列', () => {
    expect(keyMaterialText(sew([ONE_SEGMENT]))).toBe(
      'sew{profiles=1:[1:[segment(0.000000000,0.000000000,0.000000000|1.000000000,0.000000000,0.000000000)]]' +
        ';tolerance=0.010000000}',
    );
  });

  it('ブーリアンの材料の文字列', () => {
    expect(keyMaterialText(boolean('a', 'b'))).toBe('boolean{operation=union;targetKey=a;toolKey=b}');
  });
});

describe('keyMaterialText: 楕円・スプラインの曲線(P4 タスク5、FR-317・FR-318)', () => {
  const ELLIPSE: KeyEllipse = {
    kind: 'ellipse',
    center: [0, 0, 0],
    normal: [0, 0, 1],
    majorAxis: [1, 0, 0],
    majorRadius: 20,
    minorRadius: 10,
    startAngle: 0,
    endAngle: 2,
  };
  const SPLINE: KeySpline = {
    kind: 'spline',
    mode: 'interpolate',
    points: [
      [0, 0, 0],
      [10, 5, 0],
      [20, 0, 0],
    ],
    closed: false,
  };

  it('楕円の材料の文字列(長軸・短軸・パラメータ角がすべて混ざる)', () => {
    expect(keyMaterialText(extrude(2, [ELLIPSE]))).toBe(
      'extrude{profile=1:[ellipse(0.000000000,0.000000000,0.000000000' +
        '|0.000000000,0.000000000,1.000000000|1.000000000,0.000000000,0.000000000' +
        '|20.000000000|10.000000000|0.000000000|2.000000000)]' +
        ';direction=0.000000000,0.000000000,1.000000000;distance=2.000000000}',
    );
  });

  it('スプラインの材料の文字列(点の並び・通過点/制御点・閉じるかが混ざる)', () => {
    expect(keyMaterialText(extrude(2, [SPLINE]))).toBe(
      'extrude{profile=1:[spline(interpolate|false|3:[0.000000000,0.000000000,0.000000000,' +
        '10.000000000,5.000000000,0.000000000,20.000000000,0.000000000,0.000000000])]' +
        ';direction=0.000000000,0.000000000,1.000000000;distance=2.000000000}',
    );
  });

  it('長軸と短軸を入れ替えると違う鍵になる(同じ 2 つの数でも形が違う)', () => {
    const swapped: KeyEllipse = { ...ELLIPSE, majorRadius: 10, minorRadius: 20 };
    expect(cacheKeyFor(extrude(2, [ELLIPSE]))).not.toBe(cacheKeyFor(extrude(2, [swapped])));
  });

  it('通過点と制御点、開いた曲線と閉じた曲線は別の鍵になる', () => {
    const asControl: KeySpline = { ...SPLINE, mode: 'control' };
    const asClosed: KeySpline = { ...SPLINE, closed: true };
    const base = cacheKeyFor(extrude(2, [SPLINE]));
    expect(cacheKeyFor(extrude(2, [asControl]))).not.toBe(base);
    expect(cacheKeyFor(extrude(2, [asClosed]))).not.toBe(base);
  });

  it('点の並び順が違えば違う鍵になる(曲線の向きが変わるため)', () => {
    const reversed: KeySpline = { ...SPLINE, points: [...SPLINE.points].reverse() };
    expect(cacheKeyFor(extrude(2, [SPLINE]))).not.toBe(cacheKeyFor(extrude(2, [reversed])));
  });
});

describe('keyMaterialText: P3 の5節', () => {
  it('段の種類を先頭のキーワードとして含む', () => {
    expect(keyMaterialText(hole())).toMatch(/^hole\{/);
    expect(keyMaterialText(thread())).toMatch(/^thread\{/);
    expect(keyMaterialText(fillet())).toMatch(/^fillet\{/);
    expect(keyMaterialText(chamfer())).toMatch(/^chamfer\{/);
    expect(keyMaterialText(spring())).toMatch(/^spring\{/);
  });

  it('面・辺の指紋は subShapeRef.ts の fingerprintKeyText の出力をそのまま含む(丸めを2か所に書かない)', () => {
    expect(keyMaterialText(hole())).toContain(faceFingerprint());
    expect(keyMaterialText(fillet())).toContain(edgeFingerprint(1));
  });

  it('ばねの材料の文字列に length と derived が出てこない(§0.a-0.30)', () => {
    const text = keyMaterialText(spring());
    expect(text).not.toContain('length');
    expect(text).not.toContain('derived');
  });
});

describe('cacheKeyFor: P3 の材料の決定性(同じ材料は同じ鍵)', () => {
  it('同じ穴の材料を2回渡しても同じ鍵になる', () => {
    expect(cacheKeyFor(hole())).toBe(cacheKeyFor(hole()));
  });

  it('同じねじ穴の材料を2回渡しても同じ鍵になる', () => {
    expect(cacheKeyFor(thread())).toBe(cacheKeyFor(thread()));
  });

  it('同じ R 面取りの材料を2回渡しても同じ鍵になる', () => {
    expect(cacheKeyFor(fillet())).toBe(cacheKeyFor(fillet()));
  });

  it('同じ C 面取りの材料を2回渡しても同じ鍵になる', () => {
    expect(cacheKeyFor(chamfer())).toBe(cacheKeyFor(chamfer()));
  });

  it('同じばねの材料を2回渡しても同じ鍵になる', () => {
    expect(cacheKeyFor(spring())).toBe(cacheKeyFor(spring()));
  });

  it('欄を書く順序が違っても同じ鍵になる(鍵は欄の並びに依らない)', () => {
    const written: SpringKeyMaterial = {
      handedness: 'right',
      turns: 4,
      pitch: 5,
      wireDiameter: 2,
      coilDiameter: 20,
      direction: [0, 0, 1],
      origin: [10, 10, 0],
      kind: 'spring',
    };
    expect(cacheKeyFor(written)).toBe(cacheKeyFor(spring()));
  });
});

describe('cacheKeyFor: 加工フィーチャーの鍵の連鎖(上流の鍵を材料に混ぜる)', () => {
  it('穴の targetKey だけが違えば違う鍵になる', () => {
    expect(cacheKeyFor(hole())).not.toBe(cacheKeyFor(hole({ targetKey: '9999999999999999' })));
  });

  it('ねじ穴の targetKey だけが違えば違う鍵になる', () => {
    expect(cacheKeyFor(thread())).not.toBe(cacheKeyFor(thread({ targetKey: '9999999999999999' })));
  });

  it('R 面取りの targetKey だけが違えば違う鍵になる', () => {
    expect(cacheKeyFor(fillet())).not.toBe(cacheKeyFor(fillet({ targetKey: '9999999999999999' })));
  });

  it('C 面取りの targetKey だけが違えば違う鍵になる', () => {
    expect(cacheKeyFor(chamfer())).not.toBe(cacheKeyFor(chamfer({ targetKey: '9999999999999999' })));
  });

  it('上流の押し出しが変わると、それを対象にした穴の鍵も変わる', () => {
    const before = cacheKeyFor(extrude(10));
    const after = cacheKeyFor(extrude(20));
    expect(before).not.toBe(after);
    expect(cacheKeyFor(hole({ targetKey: before }))).not.toBe(cacheKeyFor(hole({ targetKey: after })));
  });

  it('上流が同じなら、穴 → 面取りと2段つないでも鍵は毎回同じになる(決定性)', () => {
    const holeKey = cacheKeyFor(hole({ targetKey: cacheKeyFor(extrude(10)) }));
    const again = cacheKeyFor(hole({ targetKey: cacheKeyFor(extrude(10)) }));
    expect(holeKey).toBe(again);
    expect(cacheKeyFor(fillet({ targetKey: holeKey }))).toBe(cacheKeyFor(fillet({ targetKey: again })));
  });
});

describe('cacheKeyFor: P3 の材料の丸め(KEY_DECIMALS = 9)', () => {
  it('穴の径 6 → 6.000000001 は違う鍵になる', () => {
    expect(cacheKeyFor(hole())).not.toBe(cacheKeyFor(hole({ diameter: 6.000000001 })));
  });

  it('穴の径 6 → 6.0000000001 は9桁より下なので同じ鍵になる', () => {
    expect(cacheKeyFor(hole())).toBe(cacheKeyFor(hole({ diameter: 6.0000000001 })));
  });

  it('ばねのピッチ 5 → 5.000000001 は違う鍵、5.0000000001 は同じ鍵になる', () => {
    expect(cacheKeyFor(spring())).not.toBe(cacheKeyFor(spring({ pitch: 5.000000001 })));
    expect(cacheKeyFor(spring())).toBe(cacheKeyFor(spring({ pitch: 5.0000000001 })));
  });

  it('面の指紋の面積が 1e-9 違えば違う鍵、1e-10 違えば同じ鍵になる(指紋も同じ丸め)', () => {
    expect(cacheKeyFor(hole())).not.toBe(cacheKeyFor(hole({ face: faceFingerprint(0, 1200.000000001) })));
    expect(cacheKeyFor(hole())).toBe(cacheKeyFor(hole({ face: faceFingerprint(0, 1200.0000000001) })));
  });

  it('-0 と 0 は同じ鍵になる(ばねの向き・穴の傾き)', () => {
    expect(cacheKeyFor(spring({ direction: [-0, 0, 1] }))).toBe(cacheKeyFor(spring({ direction: [0, 0, 1] })));
    expect(cacheKeyFor(hole({ tiltAngle: -0 }))).toBe(cacheKeyFor(hole({ tiltAngle: 0 })));
  });
});

describe('cacheKeyFor: 穴の欄', () => {
  it('depth が null(貫通)と 0(深さ0の止まり穴)は違う鍵になる', () => {
    expect(cacheKeyFor(hole({ depth: null }))).not.toBe(cacheKeyFor(hole({ depth: 0 })));
  });

  it('depth が 0 と 4 は違う鍵になる', () => {
    expect(cacheKeyFor(hole({ depth: 0 }))).not.toBe(cacheKeyFor(hole({ depth: 4 })));
  });

  it('centers の並びを入れ替えると違う鍵になる(並びも形の作り方の一部)', () => {
    const a = hole({ centers: [[10, 10, 0], [30, 20, 0]] });
    const b = hole({ centers: [[30, 20, 0], [10, 10, 0]] });
    expect(cacheKeyFor(a)).not.toBe(cacheKeyFor(b));
  });

  it('centers の個数が違えば違う鍵になる(配列の長さを混ぜている)', () => {
    const one = hole({ centers: [[10, 10, 0]] });
    const two = hole({ centers: [[10, 10, 0], [10, 10, 0]] });
    expect(cacheKeyFor(one)).not.toBe(cacheKeyFor(two));
  });

  it('transforms が空と恒等1つは違う鍵になる(model はどちらかに揃える)', () => {
    expect(cacheKeyFor(hole({ transforms: [] }))).not.toBe(
      cacheKeyFor(hole({ transforms: [IDENTITY_TRANSFORM] })),
    );
  });

  it('transforms の平行移動だけが違えば違う鍵になる', () => {
    const a = hole({ transforms: [{ ...IDENTITY_TRANSFORM, translation: [20, 0, 0] }] });
    const b = hole({ transforms: [{ ...IDENTITY_TRANSFORM, translation: [40, 0, 0] }] });
    expect(cacheKeyFor(a)).not.toBe(cacheKeyFor(b));
  });

  it('transforms の回転角だけが違えば違う鍵になる', () => {
    const a = hole({ transforms: [{ ...IDENTITY_TRANSFORM, rotationAngle: Math.PI / 2 }] });
    const b = hole({ transforms: [{ ...IDENTITY_TRANSFORM, rotationAngle: Math.PI }] });
    expect(cacheKeyFor(a)).not.toBe(cacheKeyFor(b));
  });

  it('transforms の個数が違えば違う鍵になる(パターンの個数が効く)', () => {
    const two = hole({ transforms: [IDENTITY_TRANSFORM, IDENTITY_TRANSFORM] });
    expect(cacheKeyFor(hole({ transforms: [IDENTITY_TRANSFORM] }))).not.toBe(cacheKeyFor(two));
  });

  it('面の指紋の通し番号だけが違えば違う鍵になる', () => {
    expect(cacheKeyFor(hole())).not.toBe(cacheKeyFor(hole({ face: faceFingerprint(1) })));
  });

  it('傾き角・方位角がそれぞれ違えば違う鍵になる', () => {
    expect(cacheKeyFor(hole())).not.toBe(cacheKeyFor(hole({ tiltAngle: Math.PI / 6 })));
    expect(cacheKeyFor(hole())).not.toBe(cacheKeyFor(hole({ tiltAzimuth: Math.PI / 6 })));
  });
});

describe('cacheKeyFor: ねじ穴の欄', () => {
  it('modeled(実らせんか簡略表示か)の真偽が違えば違う鍵になる', () => {
    expect(cacheKeyFor(thread({ modeled: false }))).not.toBe(cacheKeyFor(thread({ modeled: true })));
  });

  it('drillDiameter / majorDiameter / pitch / threadLength を1つずつ変えると、それぞれ違う鍵になる', () => {
    const base = cacheKeyFor(thread());
    expect(cacheKeyFor(thread({ drillDiameter: 6.646835 }))).not.toBe(base);
    expect(cacheKeyFor(thread({ majorDiameter: 8 }))).not.toBe(base);
    expect(cacheKeyFor(thread({ pitch: 1.25 }))).not.toBe(base);
    expect(cacheKeyFor(thread({ threadLength: 12 }))).not.toBe(base);
  });

  it('同じ寸法でも穴とねじ穴は違う鍵になる(種類が先頭に混ざる)', () => {
    const asHole = hole({ diameter: 4.917468, depth: null });
    expect(cacheKeyFor(asHole)).not.toBe(cacheKeyFor(thread()));
  });
});

describe('cacheKeyFor: 面取りの欄', () => {
  it('targets の並びだけが違えば違う鍵になる(model は通し番号の昇順に並べてから渡す)', () => {
    const ascending = fillet({ targets: [edgeFingerprint(0), edgeFingerprint(1)] });
    const descending = fillet({ targets: [edgeFingerprint(1), edgeFingerprint(0)] });
    expect(cacheKeyFor(ascending)).not.toBe(cacheKeyFor(descending));
  });

  it('targets が空と1本は違う鍵になる(配列の長さを混ぜている)', () => {
    expect(cacheKeyFor(fillet({ targets: [] }))).not.toBe(
      cacheKeyFor(fillet({ targets: [edgeFingerprint(0)] })),
    );
  });

  it('R 面取りの半径だけが違えば違う鍵になる', () => {
    expect(cacheKeyFor(fillet())).not.toBe(cacheKeyFor(fillet({ radius: 3 })));
  });

  it('C 面取りの mode だけが違えば違う鍵になる', () => {
    const base = cacheKeyFor(chamfer({ mode: 'equal' }));
    expect(cacheKeyFor(chamfer({ mode: 'twoDistances' }))).not.toBe(base);
    expect(cacheKeyFor(chamfer({ mode: 'distanceAngle' }))).not.toBe(base);
  });

  it('C 面取りの distance1 / distance2 を1つずつ変えると、それぞれ違う鍵になる', () => {
    const base = cacheKeyFor(chamfer());
    expect(cacheKeyFor(chamfer({ distance1: 3 }))).not.toBe(base);
    expect(cacheKeyFor(chamfer({ distance2: Math.PI / 6 }))).not.toBe(base);
  });

  it('C 面取りの swapReferenceFace の真偽が違えば違う鍵になる', () => {
    expect(cacheKeyFor(chamfer({ swapReferenceFace: false }))).not.toBe(
      cacheKeyFor(chamfer({ swapReferenceFace: true })),
    );
  });

  it('同じ辺・同じ寸法でも R 面取りと C 面取りは違う鍵になる', () => {
    expect(cacheKeyFor(fillet({ radius: 2 }))).not.toBe(cacheKeyFor(chamfer({ distance1: 2 })));
  });
});

describe('cacheKeyFor: ばねの欄', () => {
  it('handedness を右 → 左に変えると違う鍵になる', () => {
    expect(cacheKeyFor(spring({ handedness: 'right' }))).not.toBe(
      cacheKeyFor(spring({ handedness: 'left' })),
    );
  });

  it('coilDiameter / wireDiameter / pitch / turns を1つずつ変えると、それぞれ違う鍵になる', () => {
    const base = cacheKeyFor(spring());
    expect(cacheKeyFor(spring({ coilDiameter: 24 }))).not.toBe(base);
    expect(cacheKeyFor(spring({ wireDiameter: 3 }))).not.toBe(base);
    expect(cacheKeyFor(spring({ pitch: 6 }))).not.toBe(base);
    expect(cacheKeyFor(spring({ turns: 5 }))).not.toBe(base);
  });

  it('origin / direction がそれぞれ違えば違う鍵になる', () => {
    const base = cacheKeyFor(spring());
    expect(cacheKeyFor(spring({ origin: [0, 0, 0] }))).not.toBe(base);
    expect(cacheKeyFor(spring({ direction: [0, 1, 0] }))).not.toBe(base);
  });

  it('全長は材料に無いので、「ピッチ5・巻数4」と「全長20から導いたピッチ5・巻数4」は同じ鍵になる', () => {
    // derived: 'length' で ピッチ5・巻数4 を書いた場合(全長は 5×4 = 20)と、
    // derived: 'pitch' で 全長20・巻数4 を書いた場合(ピッチは 20/4 = 5)。
    // どちらも解決後は同じ「ピッチ5・巻数4」なので、鍵も同じでなければならない。
    const fromPitchAndTurns = spring({ pitch: 5, turns: 4 });
    const fromLengthAndTurns = spring({ pitch: 20 / 4, turns: 4 });
    expect(cacheKeyFor(fromPitchAndTurns)).toBe(cacheKeyFor(fromLengthAndTurns));
  });

  it('ばねは targetKey を持たないので、上流の鍵の違いでは変わりようがない(型に欄が無い)', () => {
    // 型に targetKey が無いことを、同じ数値の材料を2つ独立に組み立てて確かめる。
    expect(cacheKeyFor(spring())).toBe(cacheKeyFor(spring()));
  });
});

describe('基本形状(FR-429、P5 タスク15)の鍵の材料', () => {
  it('既定の球(半径10・原点・Z 軸)の材料の文字列が固定される', () => {
    expect(keyMaterialText(primitive())).toBe(
      'primitive{shape=sphere(10.000000000)' +
        ';origin=0.000000000,0.000000000,0.000000000' +
        ';axis=0.000000000,0.000000000,1.000000000' +
        ';originQuery=none;targetKey=none}',
    );
  });

  it('同じ内容なら同じ鍵になる(決定性)', () => {
    expect(cacheKeyFor(primitive())).toBe(cacheKeyFor(primitive()));
  });

  it('残りの4種の寸法の文字列も、欄の並びのまま固定される', () => {
    const shapeTextOf = (material: PrimitiveKeyMaterial): string =>
      keyMaterialText(material).slice('primitive{shape='.length).split(';')[0];
    expect(
      shapeTextOf(primitive({ shape: { kind: 'box', sizeX: 20, sizeY: 30, sizeZ: 40 } })),
    ).toBe('box(20.000000000,30.000000000,40.000000000)');
    expect(shapeTextOf(primitive({ shape: { kind: 'cylinder', radius: 10, height: 20 } }))).toBe(
      'cylinder(10.000000000,20.000000000)',
    );
    expect(
      shapeTextOf(
        primitive({ shape: { kind: 'cone', bottomRadius: 10, topRadius: 0, height: 20 } }),
      ),
    ).toBe('cone(10.000000000,0.000000000,20.000000000)');
    expect(
      shapeTextOf(primitive({ shape: { kind: 'torus', majorRadius: 20, minorRadius: 5 } })),
    ).toBe('torus(20.000000000,5.000000000)');
  });

  it('円柱の半径と高さ、トーラスの主半径と管半径を入れ替えると別の鍵になる', () => {
    expect(
      cacheKeyFor(primitive({ shape: { kind: 'cylinder', radius: 10, height: 20 } })),
    ).not.toBe(cacheKeyFor(primitive({ shape: { kind: 'cylinder', radius: 20, height: 10 } })));
    expect(
      cacheKeyFor(primitive({ shape: { kind: 'torus', majorRadius: 20, minorRadius: 5 } })),
    ).not.toBe(
      cacheKeyFor(primitive({ shape: { kind: 'torus', majorRadius: 5, minorRadius: 20 } })),
    );
  });

  it('寸法を変えると鍵が変わる', () => {
    const base = cacheKeyFor(primitive());
    expect(cacheKeyFor(primitive({ shape: { kind: 'sphere', radius: 10.5 } }))).not.toBe(base);

    const box = primitive({ shape: { kind: 'box', sizeX: 20, sizeY: 20, sizeZ: 20 } });
    const boxKey = cacheKeyFor(box);
    expect(
      cacheKeyFor(primitive({ shape: { kind: 'box', sizeX: 20.001, sizeY: 20, sizeZ: 20 } })),
    ).not.toBe(boxKey);
    // 欄の取り違えを防ぐ: 同じ3つの数でも並びが違えば別の形なので別の鍵。
    expect(
      cacheKeyFor(primitive({ shape: { kind: 'box', sizeX: 30, sizeY: 20, sizeZ: 40 } })),
    ).not.toBe(
      cacheKeyFor(primitive({ shape: { kind: 'box', sizeX: 20, sizeY: 30, sizeZ: 40 } })),
    );
    // 円錐の上下の半径も入れ替えれば別の形(上半径 0 は尖った円錐)。
    expect(
      cacheKeyFor(
        primitive({ shape: { kind: 'cone', bottomRadius: 10, topRadius: 5, height: 20 } }),
      ),
    ).not.toBe(
      cacheKeyFor(
        primitive({ shape: { kind: 'cone', bottomRadius: 5, topRadius: 10, height: 20 } }),
      ),
    );
  });

  it('形の種類が5つとも互いに違う鍵になる', () => {
    const keys = new Set(
      [
        primitive({ shape: { kind: 'sphere', radius: 10 } }),
        primitive({ shape: { kind: 'box', sizeX: 20, sizeY: 20, sizeZ: 20 } }),
        primitive({ shape: { kind: 'cylinder', radius: 10, height: 20 } }),
        primitive({ shape: { kind: 'cone', bottomRadius: 10, topRadius: 0, height: 20 } }),
        primitive({ shape: { kind: 'torus', majorRadius: 20, minorRadius: 5 } }),
      ].map(cacheKeyFor),
    );
    expect(keys.size).toBe(5);
  });

  it('基準点と向きを変えると鍵が変わる', () => {
    const base = cacheKeyFor(primitive());
    expect(cacheKeyFor(primitive({ origin: [0, 0, 0.001] }))).not.toBe(base);
    expect(cacheKeyFor(primitive({ axis: [1, 0, 0] }))).not.toBe(base);
  });

  it('頂点を基準にすると、指す頂点が変われば鍵が変わる(§0.a-0.18)', () => {
    const onCoordinate = cacheKeyFor(primitive());
    const onVertex = primitive({
      originQuery: vertexFingerprint(0, [0, 0, 0]),
      targetKey: TARGET_KEY,
    });
    // 座標で原点を指すのと、原点にある頂点を指すのは別物(選び直しの有無が違う)。
    expect(cacheKeyFor(onVertex)).not.toBe(onCoordinate);
    // 別の頂点(通し番号も位置も違う)を指せば別の鍵。
    expect(
      cacheKeyFor(
        primitive({ originQuery: vertexFingerprint(3, [40, 30, 10]), targetKey: TARGET_KEY }),
      ),
    ).not.toBe(cacheKeyFor(onVertex));
  });

  it('頂点を貸した立体の鍵が変われば、基本形状の鍵も必ず変わる(鍵の連鎖、NFR-PF-3)', () => {
    /*
      これが `targetKey` を材料へ混ぜる理由(P5 タスク14b の申し送り)。上流の押し出しを
      10 から 20 へ伸ばすと、頂点の位置は動くが**指紋の中身は選び直しの結果でしか変わらない**
      ので、材料が `originQuery` だけだと鍵が同じままになり、古い位置の形がキャッシュから返る。
    */
    const before = primitive({
      originQuery: vertexFingerprint(0, [0, 0, 10]),
      targetKey: 'aaaa1111bbbb2222',
    });
    const after = primitive({
      // 指紋は同じ(選び直しで同じ頂点に当たった)まま、上流の段の鍵だけが変わった場合。
      originQuery: vertexFingerprint(0, [0, 0, 10]),
      targetKey: 'cccc3333dddd4444',
    });
    expect(cacheKeyFor(after)).not.toBe(cacheKeyFor(before));
  });

  it('頂点を指していないときの none は、指紋とも鍵とも重ならない', () => {
    // `keyOptionalText` の 'none' が指紋(vertex{…})や16進16桁の鍵と衝突しないことの確認。
    expect(keyMaterialText(primitive())).toContain(';originQuery=none;targetKey=none}');
    expect(vertexFingerprint()).not.toContain('none');
  });
});

describe('面をつなぐ・ロフト(FR-430、FR-410、P5 タスク25)の鍵の材料', () => {
  it('輪郭 1 つと球 1 つを直線で結ぶ材料の文字列が、欄の並びのまま固定される', () => {
    expect(keyMaterialText(thruSections())).toBe(
      'thruSections{sections=2:[' +
        'curves(1:[segment(0.000000000,0.000000000,0.000000000|1.000000000,0.000000000,0.000000000)])' +
        ',sphere(0.000000000,0.000000000,40.000000000|10.000000000)' +
        '];ruled=true;closed=true;twist=0.000000000;sphereSegments=24.000000000}',
    );
  });

  it('同じ内容なら同じ鍵になる(決定性)', () => {
    expect(cacheKeyFor(thruSections())).toBe(cacheKeyFor(thruSections()));
  });

  it('断面の輪郭が動くと鍵が変わる(スケッチを直せば形が変わる、NFR-PF-3)', () => {
    const moved: readonly KeyCurve[] = [{ kind: 'segment', from: [0, 0, 0], to: [2, 0, 0] }];
    expect(cacheKeyFor(thruSections({ sections: [curvesSection(moved), sphereSection()] }))).not.toBe(
      cacheKeyFor(thruSections()),
    );
  });

  it('球の中心と半径のどちらが変わっても鍵が変わる', () => {
    const base = cacheKeyFor(thruSections());
    expect(cacheKeyFor(thruSections({ sections: [curvesSection(), sphereSection(10.5)] }))).not.toBe(
      base,
    );
    expect(
      cacheKeyFor(thruSections({ sections: [curvesSection(), sphereSection(10, [0, 0, 41])] })),
    ).not.toBe(base);
  });

  it('ねじれの補正・球の点の数・罫線面かロフトかで鍵が変わる', () => {
    const base = cacheKeyFor(thruSections());
    expect(cacheKeyFor(thruSections({ twist: 1 }))).not.toBe(base);
    expect(cacheKeyFor(thruSections({ sphereSegments: 48 }))).not.toBe(base);
    // 同じ断面でも、直線で結ぶかなめらかに結ぶかで形が違う(§0.a-0.25)。
    expect(cacheKeyFor(thruSections({ ruled: false }))).not.toBe(base);
    expect(cacheKeyFor(thruSections({ closed: false }))).not.toBe(base);
  });

  it('断面の並びと数が鍵に効く(順序が意味を持つ、長さも混ぜる)', () => {
    const forward = thruSections({ sections: [curvesSection(), sphereSection()] });
    const reversed = thruSections({ sections: [sphereSection(), curvesSection()] });
    expect(cacheKeyFor(reversed)).not.toBe(cacheKeyFor(forward));
    const three = thruSections({
      sections: [curvesSection(), curvesSection(), sphereSection()],
    });
    expect(cacheKeyFor(three)).not.toBe(cacheKeyFor(forward));
  });

  it('立体の面の断面には、上流の段の鍵と面の指紋の両方が混ざる', () => {
    const text = keyMaterialText(
      thruSections({ sections: [faceQuerySection(), curvesSection()] }),
    );
    expect(text).toContain('aaaa1111bbbb2222');
    expect(text).toContain(faceFingerprint());
  });

  it('面を貸した立体の鍵が変われば、つないだ段の鍵も必ず変わる(鍵の連鎖、NFR-PF-3)', () => {
    /*
      これが `targetKey` を材料へ混ぜる理由(基本形状の頂点とまったく同じ)。上流の押し出しを
      伸ばすと面は動くが、**指紋の中身は選び直しの結果でしか変わらない**ので、材料が指紋だけだと
      鍵が同じままになり、古い輪郭の形がキャッシュから返る。
    */
    const before = thruSections({ sections: [faceQuerySection('aaaa1111bbbb2222'), curvesSection()] });
    const after = thruSections({ sections: [faceQuerySection('cccc3333dddd4444'), curvesSection()] });
    expect(cacheKeyFor(after)).not.toBe(cacheKeyFor(before));
  });

  it('上流の鍵が同じでも、選び直した面が別なら鍵が変わる(指紋も混ざる)', () => {
    const before = thruSections({
      sections: [faceQuerySection('aaaa1111bbbb2222', faceFingerprint(0, 1200)), curvesSection()],
    });
    const after = thruSections({
      sections: [faceQuerySection('aaaa1111bbbb2222', faceFingerprint(2, 800)), curvesSection()],
    });
    expect(cacheKeyFor(after)).not.toBe(cacheKeyFor(before));
  });

  it('断面の種類が違えば必ず別の文字列になる(種類を先頭に置く)', () => {
    const only = (section: ThruSectionKeyMaterial): string =>
      keyMaterialText(thruSections({ sections: [section] }));
    expect(only(curvesSection())).toContain('curves(');
    expect(only(sphereSection())).toContain('sphere(');
    expect(only(faceQuerySection())).toContain('faceQuery(');
  });
});

// ---------------------------------------------------------------------------
// 以下は P5 タスク44 で足した Should 群・Could 群の材料と、既存の 4 種へ足した欄の検査。
// **ここでも具体的なハッシュ値は期待値に書かない**(報告記録 2026-09-03 07:58 の②)。
// ---------------------------------------------------------------------------

describe('keyMaterialText: 押し出しに足した5欄(FR-415・FR-401・FR-416)', () => {
  it('5欄を省略した材料と、既定を明示した材料は同じ鍵になる(同じ形に2つの鍵を作らない)', () => {
    /*
      タスク43 が押し出しの5欄を「省略できる欄」にしたので、材料を組み立てる側
      (`extrudeShapingOf` を通す解決)からは既定が明示された値で届くこともある。
      省略と既定で鍵が変われば、同じ形に2つの鍵ができてキャッシュが当たらなくなる。
    */
    const explicit: ExtrudeKeyMaterial = {
      ...extrude(10),
      end: { kind: 'distance', distance: 10 },
      taperAngle: 0,
      taperOutward: false,
      thin: null,
      targetKey: null,
    };
    expect(cacheKeyFor(explicit)).toBe(cacheKeyFor(extrude(10)));
  });

  it('既定を明示しても文字列は P2 のまま(既存の鍵を壊さない)', () => {
    const explicit: ExtrudeKeyMaterial = {
      ...extrude(2, ONE_SEGMENT),
      end: { kind: 'distance', distance: 2 },
      taperAngle: -0,
      taperOutward: false,
      thin: null,
      targetKey: null,
    };
    expect(keyMaterialText(explicit)).toBe(keyMaterialText(extrude(2, ONE_SEGMENT)));
    expect(keyMaterialText(explicit)).not.toContain('taperAngle');
  });

  it('終端の種類(両側・面まで・次の面まで)を変えると鍵が変わる', () => {
    const base = cacheKeyFor(extrude(10));
    const symmetric: ExtrudeKeyMaterial = {
      ...extrude(10),
      end: { kind: 'symmetric', forward: 5, backward: 5 },
    };
    const toFace: ExtrudeKeyMaterial = { ...extrude(10), end: { kind: 'toFace', distance: 10 } };
    const toNext: ExtrudeKeyMaterial = { ...extrude(10), end: { kind: 'toNext' } };
    expect(cacheKeyFor(symmetric)).not.toBe(base);
    // 長さが同じでも「距離 10」と「面まで 10」は別の指定なので別の鍵になる。
    expect(cacheKeyFor(toFace)).not.toBe(base);
    expect(cacheKeyFor(toNext)).not.toBe(base);
    expect(cacheKeyFor(toFace)).not.toBe(cacheKeyFor(symmetric));
  });

  it('両側へ出す長さの前後の配分が変われば鍵が変わる', () => {
    const even: ExtrudeKeyMaterial = {
      ...extrude(10),
      end: { kind: 'symmetric', forward: 5, backward: 5 },
    };
    const uneven: ExtrudeKeyMaterial = {
      ...extrude(10),
      end: { kind: 'symmetric', forward: 7, backward: 3 },
    };
    expect(cacheKeyFor(uneven)).not.toBe(cacheKeyFor(even));
  });

  it('「次の面まで」の相手の鍵が変われば鍵も変わる(消費しないが連鎖する、NFR-PF-3)', () => {
    /*
      相手の立体を伸ばすと押し出しの長さが変わるのに、鍵が同じままだと
      古い長さの形がキャッシュから返る。だから消費しなくても targetKey を混ぜる。
    */
    const before: ExtrudeKeyMaterial = {
      ...extrude(10),
      end: { kind: 'toNext' },
      targetKey: 'aaaa1111bbbb2222',
    };
    const after: ExtrudeKeyMaterial = { ...before, targetKey: 'cccc3333dddd4444' };
    expect(cacheKeyFor(after)).not.toBe(cacheKeyFor(before));
  });

  it('テーパの角度と向きで鍵が変わる(角度だけ同じで向きが逆なら別の形)', () => {
    const base = cacheKeyFor(extrude(10));
    const inward: ExtrudeKeyMaterial = { ...extrude(10), taperAngle: FIVE_DEGREES };
    const outward: ExtrudeKeyMaterial = { ...inward, taperOutward: true };
    expect(cacheKeyFor(inward)).not.toBe(base);
    expect(cacheKeyFor(outward)).not.toBe(cacheKeyFor(inward));
  });

  it('薄板の厚みと向きで鍵が変わる(中実とも別)', () => {
    const solid = cacheKeyFor(extrude(10));
    const inner: ExtrudeKeyMaterial = {
      ...extrude(10),
      thin: { thickness: 2, side: 'inner' },
    };
    const outer: ExtrudeKeyMaterial = { ...inner, thin: { thickness: 2, side: 'outer' } };
    const thicker: ExtrudeKeyMaterial = { ...inner, thin: { thickness: 3, side: 'inner' } };
    expect(cacheKeyFor(inner)).not.toBe(solid);
    expect(cacheKeyFor(outer)).not.toBe(cacheKeyFor(inner));
    expect(cacheKeyFor(thicker)).not.toBe(cacheKeyFor(inner));
  });
});

describe('keyMaterialText: 穴・ねじ穴の入口(ざぐり・皿もみ、FR-422)', () => {
  const COUNTERBORE: HoleKeyMaterial = hole({
    entry: { kind: 'counterbore', diameter: 11, depth: 6 },
  });

  it('省略と plain の明示は同じ鍵になる(穴・ねじ穴とも)', () => {
    expect(cacheKeyFor(hole({ entry: { kind: 'plain' } }))).toBe(cacheKeyFor(hole()));
    expect(cacheKeyFor(thread({ entry: { kind: 'plain' } }))).toBe(cacheKeyFor(thread()));
    expect(keyMaterialText(hole({ entry: { kind: 'plain' } }))).not.toContain('entry');
  });

  it('ざぐり・皿もみは広げない穴と別の鍵になり、径・深さ・角度も鍵に効く', () => {
    const plain = cacheKeyFor(hole());
    expect(cacheKeyFor(COUNTERBORE)).not.toBe(plain);
    expect(
      cacheKeyFor(hole({ entry: { kind: 'counterbore', diameter: 12, depth: 6 } })),
    ).not.toBe(cacheKeyFor(COUNTERBORE));
    expect(
      cacheKeyFor(hole({ entry: { kind: 'counterbore', diameter: 11, depth: 7 } })),
    ).not.toBe(cacheKeyFor(COUNTERBORE));
    const countersink = hole({
      entry: { kind: 'countersink', diameter: 11, angle: NINETY_DEGREES },
    });
    expect(cacheKeyFor(countersink)).not.toBe(plain);
    expect(
      cacheKeyFor(hole({ entry: { kind: 'countersink', diameter: 11, angle: FIVE_DEGREES } })),
    ).not.toBe(cacheKeyFor(countersink));
  });

  it('同じ2つの数でも、ざぐりと皿もみは別の鍵になる(種類を先頭に置く)', () => {
    const bore = hole({ entry: { kind: 'counterbore', diameter: 11, depth: 6 } });
    const sink = hole({ entry: { kind: 'countersink', diameter: 11, angle: 6 } });
    expect(cacheKeyFor(sink)).not.toBe(cacheKeyFor(bore));
    expect(keyMaterialText(bore)).toContain(';entry=counterbore(');
    expect(keyMaterialText(sink)).toContain(';entry=countersink(');
  });

  it('ねじ穴の入口も同じ扱いで鍵に効く', () => {
    expect(
      cacheKeyFor(thread({ entry: { kind: 'counterbore', diameter: 11, depth: 6 } })),
    ).not.toBe(cacheKeyFor(thread()));
  });
});

describe('keyMaterialText: R 面取りの可変半径(FR-426)', () => {
  it('一定半径の文字列は P3 のまま(数字列そのもの)', () => {
    expect(keyMaterialText(fillet({ radius: 5 }))).toContain(';radius=5.000000000}');
  });

  it('可変半径は一定半径と別の鍵になり、始点と終点を入れ替えても別の鍵になる', () => {
    const constant = cacheKeyFor(fillet({ radius: 5 }));
    const variable = cacheKeyFor(fillet({ radius: { start: 5, end: 8 } }));
    const swapped = cacheKeyFor(fillet({ radius: { start: 8, end: 5 } }));
    expect(variable).not.toBe(constant);
    expect(swapped).not.toBe(variable);
    // 始点と終点が同じ値の可変半径も、一定半径とは別の指定なので別の鍵にする。
    expect(cacheKeyFor(fillet({ radius: { start: 5, end: 5 } }))).not.toBe(constant);
  });
});

describe('cacheKeyFor: 点の集まりへ複製(FR-425)は工具の変換として鍵に効く', () => {
  /*
    点集合パターンは独立の材料を持たない(cacheKey.ts の `HoleKeyMaterial.transforms` の注釈)。
    解決が点それぞれを平行移動 1 つへ直すので、点の位置と個数はこの並びに現れる。
  */
  function translationsOf(points: readonly KeyVec3[]): readonly KeyTransform[] {
    return points.map((point) => ({ ...IDENTITY_TRANSFORM, translation: point }));
  }

  it('点の位置が変われば鍵が変わる', () => {
    const before = hole({ transforms: translationsOf([[0, 0, 0], [20, 0, 0]]) });
    const after = hole({ transforms: translationsOf([[0, 0, 0], [21, 0, 0]]) });
    expect(cacheKeyFor(after)).not.toBe(cacheKeyFor(before));
  });

  it('点の個数と並びが鍵に効く(長さも混ざる)', () => {
    const two = hole({ transforms: translationsOf([[0, 0, 0], [20, 0, 0]]) });
    const three = hole({ transforms: translationsOf([[0, 0, 0], [20, 0, 0], [40, 0, 0]]) });
    const reversed = hole({ transforms: translationsOf([[20, 0, 0], [0, 0, 0]]) });
    expect(cacheKeyFor(three)).not.toBe(cacheKeyFor(two));
    expect(cacheKeyFor(reversed)).not.toBe(cacheKeyFor(two));
  });
});

describe('keyMaterialText: P5 の Should 群・Could 群の11種(タスク44)', () => {
  it('段の種類を先頭のキーワードとして含む', () => {
    expect(keyMaterialText(draft())).toMatch(/^draft\{/);
    expect(keyMaterialText(mirror())).toMatch(/^mirror\{/);
    expect(keyMaterialText(transform())).toMatch(/^transform\{/);
    expect(keyMaterialText(scale())).toMatch(/^scale\{/);
    expect(keyMaterialText(sweep())).toMatch(/^sweep\{/);
    expect(keyMaterialText(rib())).toMatch(/^rib\{/);
    expect(keyMaterialText(emboss())).toMatch(/^emboss\{/);
    expect(keyMaterialText(threadShaft())).toMatch(/^threadShaft\{/);
    expect(keyMaterialText(surface())).toMatch(/^surface\{/);
    expect(keyMaterialText(cut())).toMatch(/^cut\{/);
    expect(keyMaterialText(shell())).toMatch(/^shell\{/);
  });

  it('面・辺の指紋は fingerprintKeyText の出力をそのまま含む(丸めを2か所に書かない)', () => {
    expect(keyMaterialText(draft())).toContain(faceFingerprint(9));
    expect(keyMaterialText(emboss())).toContain(faceFingerprint());
    expect(keyMaterialText(shell())).toContain(faceFingerprint());
  });

  it('外観(色・材質・柄)の欄がどこにも出てこない(§2.2.3、FR-1106)', () => {
    /*
      外観は形に影響しないので鍵に混ぜない(§2.3 の二重の保証の片方)。
      材料の型に外観の欄が無いので、そもそも混ぜられないことを文字列でも確かめる。
    */
    for (const material of ALL_KINDS) {
      const text = keyMaterialText(material);
      expect(text).not.toContain('color');
      expect(text).not.toContain('appearance');
      expect(text).not.toContain('material');
      expect(text).not.toContain('opacity');
    }
  });
});

describe('cacheKeyFor: 抜き勾配(FR-417)', () => {
  it('角度・向き・傾ける面・中立面のどれが変わっても鍵が変わる', () => {
    const base = cacheKeyFor(draft());
    expect(cacheKeyFor(draft({ angle: FIVE_DEGREES * 2 }))).not.toBe(base);
    expect(cacheKeyFor(draft({ reversed: true }))).not.toBe(base);
    expect(cacheKeyFor(draft({ faces: [faceFingerprint(1)] }))).not.toBe(base);
    expect(cacheKeyFor(draft({ neutralFace: faceFingerprint(8) }))).not.toBe(base);
  });

  it('傾ける面の並びが違えば別の鍵になり、上流が変われば必ず変わる(鍵の連鎖)', () => {
    const forward = draft({ faces: [faceFingerprint(1), faceFingerprint(2)] });
    const backward = draft({ faces: [faceFingerprint(2), faceFingerprint(1)] });
    expect(cacheKeyFor(backward)).not.toBe(cacheKeyFor(forward));
    expect(cacheKeyFor(draft({ targetKey: 'cccc3333dddd4444' }))).not.toBe(cacheKeyFor(draft()));
  });
});

describe('cacheKeyFor: ミラー(FR-419)は消費しないが上流の鍵を混ぜる', () => {
  it('鏡に映す立体の鍵が変われば鏡像の鍵も必ず変わる(NFR-PF-3)', () => {
    const before = cacheKeyFor(mirror({ targetKey: 'aaaa1111bbbb2222' }));
    const after = cacheKeyFor(mirror({ targetKey: 'cccc3333dddd4444' }));
    expect(after).not.toBe(before);
    expect(keyMaterialText(mirror())).toContain('targetKey=');
  });

  it('鏡の平面の位置と向きが鍵に効く', () => {
    const base = cacheKeyFor(mirror());
    expect(cacheKeyFor(mirror({ origin: [0, 0, 5] }))).not.toBe(base);
    expect(cacheKeyFor(mirror({ normal: [0, 1, 0] }))).not.toBe(base);
  });
});

describe('cacheKeyFor: 移動/回転・拡大縮小(FR-424)', () => {
  it('平行移動・回転の中心・軸・角度のどれが変わっても鍵が変わる', () => {
    const base = cacheKeyFor(transform());
    expect(cacheKeyFor(transform({ translation: [10, 1, 0] }))).not.toBe(base);
    expect(cacheKeyFor(transform({ rotationOrigin: [1, 0, 0] }))).not.toBe(base);
    expect(cacheKeyFor(transform({ rotationAxis: [0, 1, 0] }))).not.toBe(base);
    expect(cacheKeyFor(transform({ rotationAngle: Math.PI / 2 }))).not.toBe(base);
  });

  it('倍率・中心が鍵に効き、全体の倍率と軸ごとの倍率は別の鍵になる', () => {
    const base = cacheKeyFor(scale());
    expect(cacheKeyFor(scale({ uniform: 2.5 }))).not.toBe(base);
    expect(cacheKeyFor(scale({ origin: [1, 0, 0] }))).not.toBe(base);
    const perAxis = scale({ uniform: null, perAxis: [2, 2, 2] });
    expect(cacheKeyFor(perAxis)).not.toBe(base);
    expect(cacheKeyFor(scale({ uniform: null, perAxis: [2, 2, 3] }))).not.toBe(
      cacheKeyFor(perAxis),
    );
  });

  it('上流の鍵が変われば移動も拡大縮小も鍵が変わる(どちらも消費する)', () => {
    expect(cacheKeyFor(transform({ targetKey: 'cccc3333dddd4444' }))).not.toBe(
      cacheKeyFor(transform()),
    );
    expect(cacheKeyFor(scale({ targetKey: 'cccc3333dddd4444' }))).not.toBe(cacheKeyFor(scale()));
  });
});

describe('cacheKeyFor: スイープ(FR-409)', () => {
  it('断面・経路・向きの決め方のどれが変わっても鍵が変わる', () => {
    const base = cacheKeyFor(sweep());
    expect(cacheKeyFor(sweep({ profile: ONE_SEGMENT }))).not.toBe(base);
    expect(cacheKeyFor(sweep({ path: SQUARE_PROFILE }))).not.toBe(base);
    expect(cacheKeyFor(sweep({ frenet: true }))).not.toBe(base);
  });

  it('対象を取らない「作る」段なので targetKey を持たない', () => {
    expect(keyMaterialText(sweep())).not.toContain('targetKey');
  });

  it('経路の曲線の並びが違えば違う鍵になる(向きが変わるため)', () => {
    const forward = sweep({ path: SQUARE_PROFILE });
    const backward = sweep({ path: [...SQUARE_PROFILE].reverse() });
    expect(cacheKeyFor(backward)).not.toBe(cacheKeyFor(forward));
  });
});

describe('cacheKeyFor: リブ(FR-420)・エンボス(FR-421)', () => {
  it('リブの輪郭・法線・厚み・付ける側・伸ばす向きが鍵に効く', () => {
    const base = cacheKeyFor(rib());
    expect(cacheKeyFor(rib({ profile: SQUARE_PROFILE }))).not.toBe(base);
    expect(cacheKeyFor(rib({ normal: [1, 0, 0] }))).not.toBe(base);
    expect(cacheKeyFor(rib({ thickness: 3 }))).not.toBe(base);
    expect(cacheKeyFor(rib({ symmetric: false }))).not.toBe(base);
    expect(cacheKeyFor(rib({ direction: [0, 0, 1] }))).not.toBe(base);
  });

  it('エンボスの面・輪郭・深さ・彫るか浮き出すかが鍵に効く', () => {
    const base = cacheKeyFor(emboss());
    expect(cacheKeyFor(emboss({ face: faceFingerprint(4) }))).not.toBe(base);
    expect(cacheKeyFor(emboss({ profiles: [ONE_SEGMENT] }))).not.toBe(base);
    expect(cacheKeyFor(emboss({ profiles: [SQUARE_PROFILE, ONE_SEGMENT] }))).not.toBe(base);
    expect(cacheKeyFor(emboss({ depth: 2 }))).not.toBe(base);
    // 同じ輪郭・同じ深さでも、彫る(差)と浮き出す(和)は別の形になる。
    expect(cacheKeyFor(emboss({ raised: true }))).not.toBe(base);
  });

  it('リブもエンボスも上流の鍵を混ぜる(どちらも消費する)', () => {
    expect(cacheKeyFor(rib({ targetKey: 'cccc3333dddd4444' }))).not.toBe(cacheKeyFor(rib()));
    expect(cacheKeyFor(emboss({ targetKey: 'cccc3333dddd4444' }))).not.toBe(cacheKeyFor(emboss()));
  });
});

describe('cacheKeyFor: 外ねじ(FR-423)', () => {
  it('呼び径・ピッチ・長さ・切り始めの端が鍵に効く', () => {
    const base = cacheKeyFor(threadShaft());
    expect(cacheKeyFor(threadShaft({ majorDiameter: 8 }))).not.toBe(base);
    expect(cacheKeyFor(threadShaft({ pitch: 1.25 }))).not.toBe(base);
    expect(cacheKeyFor(threadShaft({ length: 12 }))).not.toBe(base);
    expect(cacheKeyFor(threadShaft({ fromEnd: 'last' }))).not.toBe(base);
  });

  it('簡略表示と実らせんは別の鍵になる(形そのものが変わる、§0.a-0.15)', () => {
    expect(cacheKeyFor(threadShaft({ modeled: true }))).not.toBe(cacheKeyFor(threadShaft()));
  });

  it('ねじを切る面と上流の鍵が変われば鍵も変わる', () => {
    const base = cacheKeyFor(threadShaft());
    expect(cacheKeyFor(threadShaft({ face: faceFingerprint(5) }))).not.toBe(base);
    expect(cacheKeyFor(threadShaft({ targetKey: 'cccc3333dddd4444' }))).not.toBe(base);
  });
});

describe('cacheKeyFor: 曲面(FR-428)', () => {
  it('5種の作り方が互いに違う鍵になる(種類を先頭に置く)', () => {
    const shapes: readonly SurfaceShapeKeyMaterial[] = [
      surfaceExtrude(),
      {
        kind: 'revolve',
        profile: ONE_SEGMENT,
        axisOrigin: [0, 0, 0],
        axisDirection: [0, 0, 1],
        angle: Math.PI,
      },
      { kind: 'planar', profile: SQUARE_PROFILE },
      surfaceLoft(),
      { kind: 'face', face: faceFingerprint() },
    ];
    const keys = new Set(shapes.map((shape) => cacheKeyFor(surface(shape))));
    expect(keys.size).toBe(shapes.length);
  });

  it('作り方ごとの数値(距離・罫線かどうか)が鍵に効く', () => {
    expect(cacheKeyFor(surface(surfaceExtrude(11)))).not.toBe(cacheKeyFor(surface()));
    expect(cacheKeyFor(surface(surfaceLoft(false)))).not.toBe(
      cacheKeyFor(surface(surfaceLoft(true))),
    );
  });

  it('面を借りる作り方では、面の指紋と上流の鍵の両方が混ざる(消費しないが連鎖する)', () => {
    const shape: SurfaceShapeKeyMaterial = { kind: 'face', face: faceFingerprint() };
    const text = keyMaterialText(surface(shape, 'aaaa1111bbbb2222'));
    expect(text).toContain('aaaa1111bbbb2222');
    expect(text).toContain(faceFingerprint());
    const after = cacheKeyFor(surface(shape, 'cccc3333dddd4444'));
    expect(after).not.toBe(cacheKeyFor(surface(shape, 'aaaa1111bbbb2222')));
  });

  it('上流を取らない作り方では targetKey は none になる(指していないことも鍵に出る)', () => {
    expect(keyMaterialText(surface())).toContain(';targetKey=none}');
  });
});

describe('cacheKeyFor: 切断(FR-432)・くり抜き(FR-418)', () => {
  it('切断面の位置・向き・残す側が鍵に効く', () => {
    const base = cacheKeyFor(cut());
    expect(cacheKeyFor(cut({ origin: [0, 0, 6] }))).not.toBe(base);
    expect(cacheKeyFor(cut({ normal: [0, 1, 0] }))).not.toBe(base);
    // 同じ平面で切っても、残す側が逆なら別の形になる。
    expect(cacheKeyFor(cut({ keepPositive: false }))).not.toBe(base);
  });

  it('くり抜きの開口面・厚さ・向きが鍵に効き、開口 0 枚と 1 枚は別の鍵になる', () => {
    const base = cacheKeyFor(shell());
    expect(cacheKeyFor(shell({ openFaces: [] }))).not.toBe(base);
    expect(cacheKeyFor(shell({ openFaces: [faceFingerprint(), faceFingerprint(4)] }))).not.toBe(
      base,
    );
    expect(cacheKeyFor(shell({ thickness: 3 }))).not.toBe(base);
    expect(cacheKeyFor(shell({ outward: true }))).not.toBe(base);
  });

  it('開口面の並びが違えば別の鍵になる(指紋の並びをそのまま持つ)', () => {
    const forward = shell({ openFaces: [faceFingerprint(0), faceFingerprint(4)] });
    const backward = shell({ openFaces: [faceFingerprint(4), faceFingerprint(0)] });
    expect(cacheKeyFor(backward)).not.toBe(cacheKeyFor(forward));
  });

  it('切断もくり抜きも上流の鍵を混ぜる(どちらも消費する)', () => {
    expect(cacheKeyFor(cut({ targetKey: 'cccc3333dddd4444' }))).not.toBe(cacheKeyFor(cut()));
    expect(cacheKeyFor(shell({ targetKey: 'cccc3333dddd4444' }))).not.toBe(cacheKeyFor(shell()));
  });
});

describe('cacheKeyFor: P5 の11種の決定性と -0 の正規化', () => {
  it('同じ材料を独立に2回組み立てても同じ鍵になる(11種すべて)', () => {
    const builders: readonly (() => SolidStepKeyMaterial)[] = [
      draft,
      mirror,
      transform,
      scale,
      sweep,
      rib,
      emboss,
      threadShaft,
      surface,
      cut,
      shell,
    ];
    expect(builders).toHaveLength(11);
    for (const build of builders) {
      expect(cacheKeyFor(build())).toBe(cacheKeyFor(build()));
    }
  });

  it('-0 と 0 は同じ鍵になる(角度・倍率・座標のどれでも)', () => {
    expect(cacheKeyFor(transform({ rotationAngle: -0 }))).toBe(
      cacheKeyFor(transform({ rotationAngle: 0 })),
    );
    expect(cacheKeyFor(mirror({ origin: [-0, 0, 0] }))).toBe(cacheKeyFor(mirror()));
    expect(cacheKeyFor(cut({ normal: [-0, -0, 1] }))).toBe(cacheKeyFor(cut()));
    expect(cacheKeyFor(scale({ uniform: null, perAxis: [-0, 2, 2] }))).toBe(
      cacheKeyFor(scale({ uniform: null, perAxis: [0, 2, 2] })),
    );
  });

  it('null と 0・null と指していないことは別の文字列になる(拡大縮小・曲面)', () => {
    // 全体の倍率が無い(軸ごと)ことと、倍率 0 は別物。
    expect(keyMaterialText(scale({ uniform: null, perAxis: [2, 2, 2] }))).toContain(
      ';uniform=none',
    );
    expect(keyMaterialText(scale({ uniform: 0 }))).toContain(';uniform=0.000000000');
    expect(keyMaterialText(scale())).toContain(';perAxis=none');
  });
});

/** 22種類の材料を index で少しずつ変えて作る(衝突検査用)。 */
function variantValue(index: number): number {
  return 1 + index * 0.001;
}

const VARIANT_BUILDERS: readonly ((index: number) => SolidStepKeyMaterial)[] = [
  (index) => extrude(variantValue(index)),
  (index) => revolve(variantValue(index)),
  (index) => sew([SQUARE_PROFILE], variantValue(index)),
  (index) => boolean(`upstream-${index}`, 'tool-key'),
  (index) => hole({ diameter: variantValue(index) }),
  (index) => thread({ pitch: variantValue(index) }),
  (index) => fillet({ radius: variantValue(index) }),
  (index) => chamfer({ distance1: variantValue(index) }),
  (index) => spring({ pitch: variantValue(index) }),
  (index) => primitive({ shape: { kind: 'sphere', radius: variantValue(index) } }),
  // 罫線面・ロフト(P5 タスク25)。球の半径だけを少しずつ変える。
  (index) => thruSections({ sections: [curvesSection(), sphereSection(variantValue(index))] }),
  // P5 の Should 群・Could 群(タスク44)。
  (index) => draft({ angle: variantValue(index) }),
  (index) => mirror({ origin: [variantValue(index), 0, 0] }),
  (index) => transform({ translation: [variantValue(index), 0, 0] }),
  (index) => scale({ uniform: variantValue(index) }),
  (index) => sweep({ path: [{ kind: 'segment', from: [0, 0, 0], to: [variantValue(index), 0, 0] }] }),
  (index) => rib({ thickness: variantValue(index) }),
  (index) => emboss({ depth: variantValue(index) }),
  (index) => threadShaft({ pitch: variantValue(index) }),
  (index) => surface(surfaceExtrude(variantValue(index))),
  (index) => cut({ origin: [0, 0, variantValue(index)] }),
  (index) => shell({ thickness: variantValue(index) }),
];

describe('cacheKeyFor: 22種類が互いに衝突しない', () => {
  it('22種類すべての鍵が長さ16の16進文字列になる', () => {
    expect(ALL_KINDS).toHaveLength(22);
    for (const material of ALL_KINDS) {
      const key = cacheKeyFor(material);
      expect(key).toHaveLength(16);
      expect(key).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('22種類の鍵が互いに違う(種類が違えば必ず別の鍵)', () => {
    const keys = new Set(ALL_KINDS.map(cacheKeyFor));
    expect(keys.size).toBe(ALL_KINDS.length);
  });

  it('種類ごとに1つずつ材料を用意してあり、取りこぼしが無い', () => {
    // union を広げたのに検査へ足し忘れると、衝突検査の網から漏れる。
    expect(VARIANT_BUILDERS).toHaveLength(ALL_KINDS.length);
    expect(new Set(ALL_KINDS.map((material) => material.kind)).size).toBe(ALL_KINDS.length);
  });

  it('22種類の材料を1つずつ少しずつ変えた1000通りで、鍵の重複が0件', () => {
    const keys = new Set<string>();
    for (let index = 0; index < 1000; index += 1) {
      keys.add(cacheKeyFor(VARIANT_BUILDERS[index % VARIANT_BUILDERS.length](index)));
    }
    expect(keys.size).toBe(1000);
  });
});
