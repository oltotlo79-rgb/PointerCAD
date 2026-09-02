import { describe, expect, it } from 'vitest';

import {
  cacheKeyFor,
  hash64,
  KEY_DECIMALS,
  keyMaterialText,
  keyNumber,
  type BooleanKeyMaterial,
  type ExtrudeKeyMaterial,
  type KeyCurve,
  type RevolveKeyMaterial,
  type SewKeyMaterial,
  type SolidStepKeyMaterial,
} from './cacheKey.js';

const SQUARE_PROFILE: readonly KeyCurve[] = [
  { kind: 'segment', from: [0, 0, 0], to: [10, 0, 0] },
  { kind: 'segment', from: [10, 0, 0], to: [10, 10, 0] },
  { kind: 'segment', from: [10, 10, 0], to: [0, 10, 0] },
  { kind: 'segment', from: [0, 10, 0], to: [0, 0, 0] },
];

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
