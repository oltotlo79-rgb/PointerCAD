import { describe, expect, it } from 'vitest';

import type { SubShapeRef } from '../geometry/subShapeRef.js';
import type { SolidBody, SolidVertexEntry } from '../kernelBridge.js';
import { createSubShapeCache } from './subShapeCache.js';

/**
 * 40×30×`height` の箱に見立てたボディ。頂点は 8 つで、通し番号は高さを変えても変わらない
 * (上流の押し出しの距離だけを変えたときの実際の振る舞いに合わせてある)。
 */
function boxBody(featureId: string, height: number): SolidBody {
  const corners: readonly (readonly [number, number, number])[] = [
    [0, 0, 0],
    [40, 0, 0],
    [40, 30, 0],
    [0, 30, 0],
    [0, 0, height],
    [40, 0, height],
    [40, 30, height],
    [0, 30, height],
  ];
  const vertices: SolidVertexEntry[] = corners.map((position, index) => ({
    index,
    position: [position[0], position[1], position[2]],
  }));
  return {
    featureId,
    mesh: {
      // 選び直しの「位置の点」を割る長さは、三角形の頂点の並びから測る(`matchScaleOf`)。
      positions: new Float32Array(corners.flatMap((corner) => [...corner])),
      normals: new Float32Array(corners.flatMap(() => [0, 0, 1])),
      indices: new Uint32Array([0, 1, 2]),
      edgePositions: new Float32Array([0, 0, 0, 40, 0, 0]),
      triangleCount: 1,
    },
    volume: 40 * 30 * height,
    isValid: true,
    faces: [],
    edges: [],
    vertices,
    threadMarks: [],
  };
}

/** 高さ 10 の箱の「奥・右・上」の頂点(通し番号 6)。 */
const CORNER: SubShapeRef = {
  bodyFeatureId: 'extrude-1',
  index: 6,
  fingerprint: { kind: 'vertex', position: [40, 30, 10] },
};

describe('部分形状の選び直しの覚え書き(FR-330 の上流追従、タスク25)', () => {
  it('覚えていないうちは、保存された指紋の位置をそのまま返す', () => {
    const cache = createSubShapeCache();

    expect(cache.resolve(CORNER)?.position).toEqual([40, 30, 10]);
    expect(cache.size).toBe(1);
  });

  it('聞かれた参照だけを選び直す(聞かれていないものは覚えない)', () => {
    const cache = createSubShapeCache();

    expect(cache.refresh([boxBody('extrude-1', 20)])).toBe(false);
    expect(cache.size).toBe(0);
  });

  it('形が変わると選び直した位置になり、変わったことを知らせる', () => {
    const cache = createSubShapeCache();
    cache.resolve(CORNER);

    expect(cache.refresh([boxBody('extrude-1', 20)])).toBe(true);
    expect(cache.resolve(CORNER)?.position).toEqual([40, 30, 20]);
  });

  it('形が変わっていなければ「変わった」と言わない(2 巡目を起こさない、NFR-PF-3)', () => {
    const cache = createSubShapeCache();
    cache.resolve(CORNER);

    expect(cache.refresh([boxBody('extrude-1', 10)])).toBe(false);
    expect(cache.resolve(CORNER)?.position).toEqual([40, 30, 10]);
  });

  it('同じ形で 2 回選び直しても「変わった」と言わない', () => {
    const cache = createSubShapeCache();
    cache.resolve(CORNER);
    cache.refresh([boxBody('extrude-1', 20)]);

    expect(cache.refresh([boxBody('extrude-1', 20)])).toBe(false);
  });

  it('一覧に無いボディの参照はそのままにする(指紋を使う従来の振る舞いが残る)', () => {
    const cache = createSubShapeCache();
    cache.resolve(CORNER);

    // 消費されて画面に出ない立体などは bodies に入らない。
    expect(cache.refresh([boxBody('extrude-9', 20)])).toBe(false);
    expect(cache.resolve(CORNER)?.position).toEqual([40, 30, 10]);
  });

  /*
   * 文書をまたいだ持ち越し(2026-09-06 の目視の不具合。docs/報告記録.md)。
   * フィーチャーの id は文書ごとに 1 から振り直されるので、前の文書の参照を抱えたまま
   * 次の文書のボディで `refresh` すると、**別物の同じ id のボディ**へ照合してしまう。
   */
  it('文書を替えても覚えたままだと、別物の同じ id のボディへ照合し直してしまう', () => {
    const cache = createSubShapeCache();
    // 文書 1 の `extrude-1`(高さ 10)の角を聞かれ、その形で覚える。
    cache.resolve(CORNER);
    cache.refresh([boxBody('extrude-1', 10)]);

    // 文書 2 にも `extrude-1` があるが、これは別物(高さ 20)。前の文書の参照が残って
    // いるので照合し直され、値が**別物のボディの位置**へ書き換わる。
    expect(cache.refresh([boxBody('extrude-1', 20)])).toBe(true);
    expect(cache.resolve(CORNER)?.position).toEqual([40, 30, 20]);
    expect(cache.size).toBe(1);

    // 形が遠ければ「指紋に合う形が無い」(null)になる。切断・くり抜きはこの null を
    // 受け取ると面を決められず、断ることになる(FR-504)。
    expect(cache.refresh([boxBody('extrude-1', 400)])).toBe(true);
    expect(cache.resolve(CORNER)).toBeNull();
  });

  it('clear() の後は何も覚えていない(文書の差し替えで前の文書の参照を捨てる)', () => {
    const cache = createSubShapeCache();
    cache.resolve(CORNER);
    cache.refresh([boxBody('extrude-1', 40)]);

    cache.clear();

    expect(cache.size).toBe(0);
    // 覚えていないので、次に聞かれたら保存された指紋の位置へ戻る。
    expect(cache.resolve(CORNER)?.position).toEqual([40, 30, 10]);
    // 別物のボディで選び直しても、捨てた参照は照合の対象に入らない
    // (`resolve` で聞かれた 1 件だけが対象。上の `resolve` の後なので 1 件ある)。
    expect(cache.size).toBe(1);
  });

  it('指紋に合う形が無くなったら null を返す(呼び出し側が missingSubShape で断る)', () => {
    const cache = createSubShapeCache();
    const faraway: SubShapeRef = {
      bodyFeatureId: 'extrude-1',
      index: 99,
      fingerprint: { kind: 'vertex', position: [4000, 3000, 1000] },
    };
    cache.resolve(faraway);

    expect(cache.refresh([boxBody('extrude-1', 10)])).toBe(true);
    expect(cache.resolve(faraway)).toBeNull();
  });
});
