import { describe, expect, it } from 'vitest';

import {
  dedupeSubShapeRefs,
  fingerprintKeyText,
  isSameSubShape,
  subShapeKindOf,
} from './subShapeRef.js';
// 型はタスク13 で part/types.ts(保存形の置き場)へ移した。道具だけが subShapeRef.ts に残る。
import type { SubShapeFingerprint, SubShapeRef } from './types.js';

/** 面の指紋の既定値(計画書 §2.2.3 の検算表と同じ箱: 40×30 を Z へ10押し出した上面)。 */
function faceRef(
  fingerprintOverrides: Partial<Omit<Extract<SubShapeFingerprint, { kind: 'face' }>, 'kind'>> = {},
  refOverrides: Partial<Pick<SubShapeRef, 'bodyFeatureId' | 'index'>> = {},
): SubShapeRef {
  return {
    bodyFeatureId: 'extrude-1',
    index: 0,
    ...refOverrides,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'plane',
      area: 1200,
      position: [20, 15, 10],
      axis: [0, 0, 1],
      radius: null,
      ...fingerprintOverrides,
    },
  };
}

/** 辺の指紋の既定値。 */
function edgeRef(
  fingerprintOverrides: Partial<Omit<Extract<SubShapeFingerprint, { kind: 'edge' }>, 'kind'>> = {},
  refOverrides: Partial<Pick<SubShapeRef, 'bodyFeatureId' | 'index'>> = {},
): SubShapeRef {
  return {
    bodyFeatureId: 'extrude-1',
    index: 0,
    ...refOverrides,
    fingerprint: {
      kind: 'edge',
      curveKind: 'line',
      length: 40,
      position: [0, 15, 10],
      axis: [1, 0, 0],
      radius: null,
      ...fingerprintOverrides,
    },
  };
}

/** 頂点の指紋の既定値。 */
function vertexRef(
  fingerprintOverrides: Partial<Omit<Extract<SubShapeFingerprint, { kind: 'vertex' }>, 'kind'>> = {},
  refOverrides: Partial<Pick<SubShapeRef, 'bodyFeatureId' | 'index'>> = {},
): SubShapeRef {
  return {
    bodyFeatureId: 'extrude-1',
    index: 0,
    ...refOverrides,
    fingerprint: {
      kind: 'vertex',
      position: [0, 0, 10],
      ...fingerprintOverrides,
    },
  };
}

describe('subShapeKindOf', () => {
  it('3種類とも正しく返る', () => {
    expect(subShapeKindOf(faceRef())).toBe('face');
    expect(subShapeKindOf(edgeRef())).toBe('edge');
    expect(subShapeKindOf(vertexRef())).toBe('vertex');
  });
});

describe('isSameSubShape', () => {
  it('同じボディ・種類・番号なら指紋が違っても true(指紋の中身は見ない)', () => {
    const a = faceRef({ area: 1200 });
    const b = faceRef({ area: 999999 });
    expect(isSameSubShape(a, b)).toBe(true);
  });

  it('ボディが違えば false', () => {
    const a = faceRef({}, { bodyFeatureId: 'extrude-1' });
    const b = faceRef({}, { bodyFeatureId: 'extrude-2' });
    expect(isSameSubShape(a, b)).toBe(false);
  });

  it('種類が違えば false', () => {
    const a = faceRef({}, { bodyFeatureId: 'x', index: 0 });
    const b = edgeRef({}, { bodyFeatureId: 'x', index: 0 });
    expect(isSameSubShape(a, b)).toBe(false);
  });

  it('通し番号が違えば false', () => {
    const a = faceRef({}, { index: 0 });
    const b = faceRef({}, { index: 1 });
    expect(isSameSubShape(a, b)).toBe(false);
  });
});

describe('dedupeSubShapeRefs', () => {
  it('同じものが2つなら長さ1で、先に出たほうが残る', () => {
    const first = faceRef({ area: 1200 });
    const second = faceRef({ area: 999 });
    const result = dedupeSubShapeRefs([first, second]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(first);
  });

  it('空なら空', () => {
    expect(dedupeSubShapeRefs([])).toEqual([]);
  });

  it('別々の部分形状は両方残る', () => {
    const a = faceRef({}, { index: 0 });
    const b = faceRef({}, { index: 1 });
    const result = dedupeSubShapeRefs([a, b]);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(a);
    expect(result[1]).toBe(b);
  });
});

describe('fingerprintKeyText', () => {
  it('2回呼んでも同じ文字列になる(決定性)', () => {
    const ref = faceRef();
    expect(fingerprintKeyText(ref)).toBe(fingerprintKeyText(ref));
  });

  it('面積だけ1e-12違う指紋は同じ文字列になる(KEY_DECIMALS=9で丸まる)', () => {
    const a = faceRef({ area: 1200 });
    const b = faceRef({ area: 1200 + 1e-12 });
    expect(fingerprintKeyText(a)).toBe(fingerprintKeyText(b));
  });

  it('面積が1e-6違う指紋は違う文字列になる', () => {
    const a = faceRef({ area: 1200 });
    const b = faceRef({ area: 1200 + 1e-6 });
    expect(fingerprintKeyText(a)).not.toBe(fingerprintKeyText(b));
  });

  it('axisがnullの指紋と[0,0,1]の指紋は違う文字列になる', () => {
    const a = faceRef({ axis: null });
    const b = faceRef({ axis: [0, 0, 1] });
    expect(fingerprintKeyText(a)).not.toBe(fingerprintKeyText(b));
  });

  it('種類が違う指紋は違う文字列になる(同じボディ・番号でも)', () => {
    const a = faceRef({}, { bodyFeatureId: 'x', index: 0 });
    const b = edgeRef({}, { bodyFeatureId: 'x', index: 0 });
    expect(fingerprintKeyText(a)).not.toBe(fingerprintKeyText(b));
  });

  it('-0 と 0 は同じ文字列になる(rules/04-設計の規律.md の数値精度)', () => {
    const a = faceRef({ position: [-0, 15, 10] });
    const b = faceRef({ position: [0, 15, 10] });
    expect(fingerprintKeyText(a)).toBe(fingerprintKeyText(b));
  });

  it('半径がnullの指紋と数値の指紋は違う文字列になる(円柱面など)', () => {
    const a = faceRef({ surfaceKind: 'cylinder', radius: null });
    const b = faceRef({ surfaceKind: 'cylinder', radius: 5 });
    expect(fingerprintKeyText(a)).not.toBe(fingerprintKeyText(b));
  });

  it('vertex の指紋も鍵の材料の文字列になる', () => {
    const v = vertexRef();
    expect(fingerprintKeyText(v)).toContain('vertex{');
    expect(fingerprintKeyText(v)).toBe(fingerprintKeyText(vertexRef()));
  });

  it('bodyFeatureId が違えば同じ指紋でも違う文字列になる', () => {
    const a = faceRef({}, { bodyFeatureId: 'extrude-1' });
    const b = faceRef({}, { bodyFeatureId: 'extrude-2' });
    expect(fingerprintKeyText(a)).not.toBe(fingerprintKeyText(b));
  });
});
