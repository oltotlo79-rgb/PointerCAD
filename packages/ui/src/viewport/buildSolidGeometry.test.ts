/**
 * `buildSolidGeometry` と、サムネイルの純関数部分(`file/thumbnail.ts`)の検査
 * (計画書 docs/plans/P2-ソリッド基礎.md タスク20)。
 *
 * どちらも three.js にも DOM にも触れないので Node のまま検査できる。
 * サムネイルの検査をここへ同居させているのは、タスク20 で作ってよいファイルが
 * 6 つに限られているため(統括の指示書 §1)。canvas を触る `captureThumbnailPng` は
 * 実ブラウザでしか動かないので、E2E と統括の目視に任せる。
 */

import type { SolidBody } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { dataUrlToBytes, THUMBNAIL_SIZE, thumbnailFitRect } from '../file/thumbnail.js';
import type { SolidFaceEntry } from '../solid/subShapeSelection.js';

import {
  buildSolidGeometry,
  EMPTY_SOLID_GEOMETRY,
  solidEmphasisOf,
  type SolidBodyWithSubShapes,
  type SolidGeometryBundle,
} from './buildSolidGeometry.js';

/**
 * 検査用のボディ。三角形の数と稜線の本数だけを指定し、中身は 0 のままにする
 * (組み立てが見ているのは長さと参照だけで、座標の値は見ていない)。
 */
function makeBody(
  featureId: string,
  triangleCount: number,
  edgeCount: number,
  isValid = true,
): SolidBody {
  const indices = new Uint32Array(triangleCount * 3);
  for (let position = 0; position < indices.length; position += 1) {
    indices[position] = position;
  }
  return {
    featureId,
    mesh: {
      positions: new Float32Array(triangleCount * 9),
      normals: new Float32Array(triangleCount * 9),
      indices,
      edgePositions: new Float32Array(edgeCount * 6),
      triangleCount,
    },
    volume: 1000,
    isValid,
  };
}

/** 数値だけを取り出して比べる(Float32Array の中身は別に確かめる)。 */
function shapeOf(bundle: SolidGeometryBundle): unknown {
  return {
    triangleCount: bundle.triangleCount,
    edgeCount: bundle.edgeCount,
    entries: bundle.entries.map((entry) => ({
      featureId: entry.featureId,
      emphasis: entry.emphasis,
      drawIndex: entry.drawIndex,
      triangleOffset: entry.triangleOffset,
      triangleCount: entry.triangleCount,
      edgeOffset: entry.edgeOffset,
      edgeCount: entry.edgeCount,
    })),
  };
}

describe('buildSolidGeometry(FR-105、FR-106)', () => {
  it('ボディが 1 つも無ければ空の結果になる', () => {
    const bundle = buildSolidGeometry([], null, []);
    expect(bundle.entries).toEqual([]);
    expect(bundle.triangleCount).toBe(0);
    expect(bundle.edgeCount).toBe(0);
    expect(bundle.index.size).toBe(0);
    expect(shapeOf(bundle)).toEqual(shapeOf(EMPTY_SOLID_GEOMETRY));
  });

  it('ボディ 2 つの三角形と稜線を合計し、通し番号の始まりを持つ', () => {
    const bundle = buildSolidGeometry(
      [makeBody('extrude-1', 4, 12), makeBody('revolve-1', 2, 6)],
      null,
      [],
    );
    expect(bundle.entries.length).toBe(2);
    expect(bundle.triangleCount).toBe(6);
    expect(bundle.edgeCount).toBe(18);
    expect(shapeOf(bundle)).toEqual({
      triangleCount: 6,
      edgeCount: 18,
      entries: [
        {
          featureId: 'extrude-1',
          emphasis: 'none',
          drawIndex: 0,
          triangleOffset: 0,
          triangleCount: 4,
          edgeOffset: 0,
          edgeCount: 12,
        },
        {
          featureId: 'revolve-1',
          emphasis: 'none',
          drawIndex: 1,
          triangleOffset: 4,
          triangleCount: 2,
          edgeOffset: 12,
          edgeCount: 6,
        },
      ],
    });
  });

  it('バッファの長さが三角形・稜線の数と合う', () => {
    const bundle = buildSolidGeometry([makeBody('extrude-1', 4, 12)], null, []);
    const entry = bundle.entries[0];
    expect(entry.indices.length).toBe(12);
    expect(entry.positions.length).toBe(36);
    expect(entry.normals.length).toBe(36);
    expect(entry.edgePositions.length).toBe(72);
    expect(entry.edgeCount).toBe(entry.edgePositions.length / 6);
  });

  it('並びは写さずカーネルが返したものをそのまま指す(NFR-PF-1)', () => {
    const body = makeBody('extrude-1', 2, 3);
    const entry = buildSolidGeometry([body], null, []).entries[0];
    expect(entry.positions).toBe(body.mesh.positions);
    expect(entry.normals).toBe(body.mesh.normals);
    expect(entry.indices).toBe(body.mesh.indices);
    expect(entry.edgePositions).toBe(body.mesh.edgePositions);
  });

  it('対応表から featureId で描画の範囲を引ける', () => {
    const bundle = buildSolidGeometry(
      [makeBody('extrude-1', 4, 12), makeBody('revolve-1', 2, 6)],
      null,
      [],
    );
    expect([...bundle.index.keys()]).toEqual(['extrude-1', 'revolve-1']);
    expect(bundle.index.get('revolve-1')).toBe(bundle.entries[1]);
    expect(bundle.index.get('revolve-1')?.triangleOffset).toBe(4);
    expect(bundle.index.get('missing')).toBeUndefined();
  });

  it('ホバー中のボディだけが hovered になる', () => {
    const bundle = buildSolidGeometry(
      [makeBody('extrude-1', 1, 1), makeBody('revolve-1', 1, 1)],
      'revolve-1',
      [],
    );
    expect(bundle.entries.map((entry) => entry.emphasis)).toEqual(['none', 'hovered']);
  });

  it('選択中のボディが selected になり、ホバーと重なったら選択を優先する', () => {
    const bundle = buildSolidGeometry(
      [makeBody('extrude-1', 1, 1), makeBody('revolve-1', 1, 1), makeBody('cut-1', 1, 1)],
      'revolve-1',
      ['revolve-1', 'cut-1'],
    );
    expect(bundle.entries.map((entry) => entry.emphasis)).toEqual([
      'none',
      'selected',
      'selected',
    ]);
  });

  it('スケッチの要素 id が混ざっていてもボディは強調されない', () => {
    const bundle = buildSolidGeometry(
      [makeBody('extrude-1', 1, 1)],
      'point-1',
      ['point-1', 'pa1#0', 'extrude-10'],
    );
    expect(bundle.entries[0].emphasis).toBe('none');
  });

  it('立体になっていないボディ(isValid が false)は描かない', () => {
    const bundle = buildSolidGeometry(
      [makeBody('extrude-1', 4, 12, false), makeBody('revolve-1', 2, 6)],
      null,
      [],
    );
    expect(bundle.entries.map((entry) => entry.featureId)).toEqual(['revolve-1']);
    expect(bundle.triangleCount).toBe(2);
    expect(bundle.entries[0].drawIndex).toBe(0);
  });

  it('三角形も稜線も無いボディは描かない', () => {
    const bundle = buildSolidGeometry([makeBody('extrude-1', 0, 0)], null, []);
    expect(bundle.entries).toEqual([]);
    expect(bundle.index.size).toBe(0);
  });

  it('稜線だけのボディは描く(ワイヤーフレーム表示のため)', () => {
    const bundle = buildSolidGeometry([makeBody('extrude-1', 0, 4)], null, []);
    expect(bundle.entries.length).toBe(1);
    expect(bundle.entries[0].triangleCount).toBe(0);
    expect(bundle.entries[0].edgeCount).toBe(4);
  });

  it('同じ id のボディが 2 つ来たら先のものだけを描く(§0.a-0.5)', () => {
    const first = makeBody('extrude-1', 4, 12);
    const bundle = buildSolidGeometry([first, makeBody('extrude-1', 2, 6)], null, []);
    expect(bundle.entries.length).toBe(1);
    expect(bundle.entries[0].indices).toBe(first.mesh.indices);
    expect(bundle.triangleCount).toBe(4);
  });

  it('同じ入力を 2 回組み立てると同じ結果になる(決定性)', () => {
    const bodies = [makeBody('extrude-1', 4, 12), makeBody('revolve-1', 2, 6)];
    const first = buildSolidGeometry(bodies, 'extrude-1', ['revolve-1']);
    const second = buildSolidGeometry(bodies, 'extrude-1', ['revolve-1']);
    expect(shapeOf(second)).toEqual(shapeOf(first));
    expect(second.entries[0].positions).toBe(first.entries[0].positions);
  });

  it('faces/edges/vertices を持たないボディ(タスク17 前)は、エントリの範囲表が空配列になる(計画書タスク22)', () => {
    const bundle = buildSolidGeometry([makeBody('extrude-1', 4, 12)], null, []);
    expect(bundle.entries[0].faces).toEqual([]);
    expect(bundle.entries[0].edges).toEqual([]);
    expect(bundle.entries[0].vertices).toEqual([]);
  });

  it('faces/edges/vertices を持つボディは、エントリがその参照をそのまま持つ(タスク22、写さない)', () => {
    const face: SolidFaceEntry = {
      index: 0,
      surfaceKind: 'plane',
      area: 10,
      centroid: [0, 0, 0],
      axis: [0, 0, 1],
      radius: null,
      triangleOffset: 0,
      triangleCount: 4,
    };
    const body: SolidBodyWithSubShapes = { ...makeBody('extrude-1', 4, 12), faces: [face], edges: [], vertices: [] };
    const bundle = buildSolidGeometry([body], null, []);
    expect(bundle.entries[0].faces).toBe(body.faces);
    expect(bundle.entries[0].edges).toBe(body.edges);
    expect(bundle.entries[0].vertices).toBe(body.vertices);
  });
});

describe('solidEmphasisOf(FR-106)', () => {
  it('選択 > ホバー > なし の順に強い', () => {
    expect(solidEmphasisOf('extrude-1', null, new Set())).toBe('none');
    expect(solidEmphasisOf('extrude-1', 'extrude-1', new Set())).toBe('hovered');
    expect(solidEmphasisOf('extrude-1', 'extrude-1', new Set(['extrude-1']))).toBe('selected');
    expect(solidEmphasisOf('extrude-1', 'revolve-1', new Set(['extrude-1']))).toBe('selected');
  });
});

describe('サムネイルの大きさ(§0.a-0.18)', () => {
  it('一辺の上限は 256', () => {
    expect(THUMBNAIL_SIZE).toBe(256);
  });

  it('横長の絵は幅を合わせ、上下を余白にする', () => {
    expect(thumbnailFitRect(800, 600)).toEqual({ x: 0, y: 32, width: 256, height: 192 });
  });

  it('縦長の絵は高さを合わせ、左右を余白にする', () => {
    expect(thumbnailFitRect(600, 800)).toEqual({ x: 32, y: 0, width: 192, height: 256 });
  });

  it('正方形は余白なしで埋まる', () => {
    expect(thumbnailFitRect(512, 512)).toEqual({ x: 0, y: 0, width: 256, height: 256 });
  });

  it('元が小さいときは拡大せず中央に置く', () => {
    expect(thumbnailFitRect(100, 50)).toEqual({ x: 78, y: 103, width: 100, height: 50 });
  });

  it('大きさが決められないときは null', () => {
    expect(thumbnailFitRect(0, 600)).toBeNull();
    expect(thumbnailFitRect(800, -1)).toBeNull();
    expect(thumbnailFitRect(800, 600, 0)).toBeNull();
    expect(thumbnailFitRect(Number.NaN, 600)).toBeNull();
  });
});

describe('サムネイルのバイト列(§0.a-0.18)', () => {
  it('PNG の data URL をバイト列へ直す', () => {
    // "iVBORw0KGgo=" は PNG の署名 8 バイトそのもの。
    const bytes = dataUrlToBytes('data:image/png;base64,iVBORw0KGgo=');
    expect(bytes).not.toBeNull();
    expect([...(bytes ?? [])]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('中身が空でも空のバイト列を返す', () => {
    expect(dataUrlToBytes('data:image/png;base64,')?.length).toBe(0);
  });

  it('PNG でない data URL は受け取らない', () => {
    expect(dataUrlToBytes('data:image/jpeg;base64,iVBORw0KGgo=')).toBeNull();
    expect(dataUrlToBytes('')).toBeNull();
  });

  it('base64 が壊れていたら例外を投げずに null を返す', () => {
    expect(dataUrlToBytes('data:image/png;base64,!!!!')).toBeNull();
  });
});
