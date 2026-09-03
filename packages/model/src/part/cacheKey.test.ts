import { describe, expect, it } from 'vitest';

import {
  cacheKeyFor,
  hash64,
  KEY_DECIMALS,
  keyMaterialText,
  keyNumber,
  type BooleanKeyMaterial,
  type ChamferKeyMaterial,
  type ExtrudeKeyMaterial,
  type FilletKeyMaterial,
  type HoleKeyMaterial,
  type KeyCurve,
  type KeySubShape,
  type KeyTransform,
  type RevolveKeyMaterial,
  type SewKeyMaterial,
  type SolidStepKeyMaterial,
  type SpringKeyMaterial,
  type ThreadKeyMaterial,
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

/** 9種類ぶんの材料を1つずつ。順序は SolidStepKeyMaterial の union の並びに合わせる。 */
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

/** 9種類の材料を index で少しずつ変えて作る(衝突検査用)。 */
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
];

describe('cacheKeyFor: 9種類が互いに衝突しない', () => {
  it('9種類すべての鍵が長さ16の16進文字列になる', () => {
    expect(ALL_KINDS).toHaveLength(9);
    for (const material of ALL_KINDS) {
      const key = cacheKeyFor(material);
      expect(key).toHaveLength(16);
      expect(key).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('9種類の鍵が互いに違う(種類が違えば必ず別の鍵)', () => {
    const keys = new Set(ALL_KINDS.map(cacheKeyFor));
    expect(keys.size).toBe(ALL_KINDS.length);
  });

  it('9種類の材料を1つずつ少しずつ変えた1000通りで、鍵の重複が0件', () => {
    const keys = new Set<string>();
    for (let index = 0; index < 1000; index += 1) {
      keys.add(cacheKeyFor(VARIANT_BUILDERS[index % VARIANT_BUILDERS.length](index)));
    }
    expect(keys.size).toBe(1000);
  });
});
