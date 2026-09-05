import { describe, expect, it } from 'vitest';

import { DXF_UNSUPPORTED_FORMAT_MESSAGE, parseDxfTags, type DxfTag } from './dxfTags.js';
import {
  DXF_BLOCK_NESTING_MESSAGE,
  DXF_MAX_ENTITY_COUNT,
  DXF_NON_UNIFORM_SCALE_MESSAGE,
  DXF_TOO_MANY_ENTITIES_MESSAGE,
  readDxf,
  type DxfEntity,
} from './readDxf.js';

/*
 * DXF の実体の読み取りの検査(計画書 docs/plans/P6-入出力.md §2.7 とタスク24 の検証表)。
 *
 * **検査に使う DXF は文字列としてこのファイルの中に書く**(ファイルを置かない。
 * テストが追跡ファイルを書き換えないため。rules/03-品質ゲート.md §7.1 #0)。
 *
 * 期待値は注釈の導出から手で出し、計画書の表からは写さない
 * (P0 タスク10・12、P1 タスク11、P3 タスク5・8 で計画書の期待値が誤っていた実績があるため)。
 */

/** DXF のテキストを組み立てて字句の段(タスク22)へ通す。`lines` はコードと値の交互。 */
function toTags(lines: readonly string[]): readonly DxfTag[] {
  return parseDxfTags(lines.join('\n') + '\n');
}

/** ヘッダ・ブロック・実体のセクションを持つ最小の DXF。 */
function buildDxf(sections: {
  readonly header?: readonly string[];
  readonly blocks?: readonly string[];
  readonly entities?: readonly string[];
}): readonly DxfTag[] {
  const lines: string[] = [];
  if (sections.header !== undefined) {
    lines.push('0', 'SECTION', '2', 'HEADER', ...sections.header, '0', 'ENDSEC');
  }
  if (sections.blocks !== undefined) {
    lines.push('0', 'SECTION', '2', 'BLOCKS', ...sections.blocks, '0', 'ENDSEC');
  }
  lines.push('0', 'SECTION', '2', 'ENTITIES', ...(sections.entities ?? []), '0', 'ENDSEC');
  lines.push('0', 'EOF');
  return toTags(lines);
}

/** ブロックの定義 1 つ。`base` はグループ 10 / 20 の基点。 */
function block(
  name: string,
  body: readonly string[],
  base: readonly [string, string] = ['0', '0'],
): readonly string[] {
  return ['0', 'BLOCK', '2', name, '10', base[0], '20', base[1], ...body, '0', 'ENDBLK'];
}

/** (0,0) から (10,0) への線分。 */
const LINE_10: readonly string[] = ['0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '10', '21', '0'];

/** 入れ子のブロック `B1 → B2 → … → B{depth}` を作り、いちばん奥に線分 1 本を置く。 */
function nestedBlocks(depth: number): readonly string[] {
  const lines: string[] = [];
  for (let level = 1; level <= depth; level += 1) {
    const body = level === depth ? LINE_10 : ['0', 'INSERT', '2', `B${String(level + 1)}`];
    lines.push(...block(`B${String(level)}`, body));
  }
  return lines;
}

function kindsOf(entities: readonly DxfEntity[]): readonly string[] {
  return entities.map((entity) => entity.kind);
}

describe('セクションの骨', () => {
  it('空の ENTITIES は実体 0 個で断らない', () => {
    const result = readDxf(buildDxf({}));
    expect(result.entities).toHaveLength(0);
    expect(result.skippedEntityCount).toBe(0);
    expect(result.offPlaneCount).toBe(0);
    expect(result.blockCount).toBe(0);
  });

  it('ENDSEC が無い DXF を断る', () => {
    const tags = toTags(['0', 'SECTION', '2', 'ENTITIES', ...LINE_10, '0', 'EOF']);
    expect(() => readDxf(tags)).toThrow(DXF_UNSUPPORTED_FORMAT_MESSAGE);
  });

  it('セクションの名前(グループ 2)が無い DXF を断る', () => {
    const tags = toTags(['0', 'SECTION', '0', 'ENDSEC', '0', 'EOF']);
    expect(() => readDxf(tags)).toThrow(DXF_UNSUPPORTED_FORMAT_MESSAGE);
  });

  it('知らないセクションは丸ごと飛ばし、EOF より後ろは読まない', () => {
    const tags = toTags([
      '0', 'SECTION', '2', 'TABLES',
      // ここに実体らしいタグがあっても、ENTITIES ではないので読まない。
      ...LINE_10,
      '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES', ...LINE_10, '0', 'ENDSEC',
      '0', 'EOF',
      // EOF の後ろ。読んだら実体が 2 本になる。
      '0', 'SECTION', '2', 'ENTITIES', ...LINE_10, '0', 'ENDSEC',
    ]);
    expect(readDxf(tags).entities).toHaveLength(1);
  });

  it('ENDBLK が無いブロックを断る', () => {
    const tags = toTags([
      '0', 'SECTION', '2', 'BLOCKS',
      '0', 'BLOCK', '2', 'A', '10', '0', '20', '0', ...LINE_10,
      '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES', '0', 'ENDSEC',
      '0', 'EOF',
    ]);
    expect(() => readDxf(tags)).toThrow(DXF_UNSUPPORTED_FORMAT_MESSAGE);
  });

  it('改行が `\\r\\n` の DXF も同じに読める', () => {
    const lines = ['0', 'SECTION', '2', 'ENTITIES', ...LINE_10, '0', 'ENDSEC', '0', 'EOF'];
    const result = readDxf(parseDxfTags(lines.join('\r\n') + '\r\n'));
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].kind).toBe('line');
  });
});

describe('$INSUNITS(計画書 §0.a-0.6)', () => {
  it('1 は inch', () => {
    const result = readDxf(buildDxf({ header: ['9', '$INSUNITS', '70', '1'] }));
    expect(result.unit).toBe('inch');
    expect(result.insUnits).toBe(1);
  });

  it('4 は mm', () => {
    const result = readDxf(buildDxf({ header: ['9', '$INSUNITS', '70', '4'] }));
    expect(result.unit).toBe('mm');
    expect(result.insUnits).toBe(4);
  });

  it('無ければ mm とみなし、生の値は null', () => {
    // ヘッダはあるが `$INSUNITS` が無い場合。
    const result = readDxf(buildDxf({ header: ['9', '$ACADVER', '1', 'AC1009'] }));
    expect(result.unit).toBe('mm');
    expect(result.insUnits).toBe(null);
  });

  it('mm でも inch でもない値は other として生の値のまま渡す', () => {
    // 6 = メートル。どう扱うかは上の段(タスク26)の判断。
    const result = readDxf(buildDxf({ header: ['9', '$INSUNITS', '70', '6'] }));
    expect(result.unit).toBe('other');
    expect(result.insUnits).toBe(6);
  });

  it('$INSUNITS の後ろに別の変数が来ても取り違えない', () => {
    const result = readDxf(
      buildDxf({ header: ['9', '$INSBASE', '10', '0', '9', '$INSUNITS', '70', '1'] }),
    );
    expect(result.unit).toBe('inch');
  });
});

describe('実体(§2.7 の表)', () => {
  it('LINE を線分 1 本として読む', () => {
    const result = readDxf(buildDxf({ entities: LINE_10 }));
    const [entity] = result.entities;
    expect(entity.kind).toBe('line');
    if (entity.kind !== 'line') {
      throw new Error('線分として読めていない');
    }
    expect(entity.start).toEqual({ x: 0, y: 0 });
    expect(entity.end).toEqual({ x: 10, y: 0 });
  });

  it('POINT を点として読む', () => {
    const result = readDxf(
      buildDxf({ entities: ['0', 'POINT', '10', '-3.5', '20', '2', '30', '0'] }),
    );
    const [entity] = result.entities;
    if (entity.kind !== 'point') {
      throw new Error('点として読めていない');
    }
    expect(entity.position).toEqual({ x: -3.5, y: 2 });
    expect(result.offPlaneCount).toBe(0);
  });

  it('CIRCLE は開始 0 度・終了 360 度の円弧になる', () => {
    const result = readDxf(
      buildDxf({ entities: ['0', 'CIRCLE', '10', '0', '20', '0', '40', '10'] }),
    );
    const [entity] = result.entities;
    if (entity.kind !== 'arc') {
      throw new Error('円弧として読めていない');
    }
    expect(entity.center).toEqual({ x: 0, y: 0 });
    expect(entity.radius).toBe(10);
    // 全周の指定で円になる(P1 の約束)。差がちょうど 360 度であることが要。
    expect(entity.startAngle).toBe(0);
    expect(entity.endAngle).toBe(360);
  });

  it('ARC は 50 から 51 へ反時計回りに回る', () => {
    const result = readDxf(
      buildDxf({
        entities: ['0', 'ARC', '10', '0', '20', '0', '40', '10', '50', '0', '51', '90'],
      }),
    );
    const [entity] = result.entities;
    if (entity.kind !== 'arc') {
      throw new Error('円弧として読めていない');
    }
    expect(entity.startAngle).toBe(0);
    expect(entity.endAngle).toBe(90);
    // 弧長 = 2π·10/4 = 15.707963267948966。
    const arcLength = ((entity.endAngle - entity.startAngle) / 180) * Math.PI * entity.radius;
    expect(arcLength).toBeCloseTo(15.707963267948966, 12);
  });

  it('ARC の終了角が開始角より小さければ 360 度を足す', () => {
    const result = readDxf(
      buildDxf({
        entities: ['0', 'ARC', '10', '0', '20', '0', '40', '5', '50', '350', '51', '10'],
      }),
    );
    const [entity] = result.entities;
    if (entity.kind !== 'arc') {
      throw new Error('円弧として読めていない');
    }
    // 350 度から反時計回りに 20 度回って 10 度(= 370 度)に着く。
    expect(entity.startAngle).toBe(350);
    expect(entity.endAngle).toBe(370);
  });

  it('半径が 0 以下の CIRCLE を断る', () => {
    const tags = buildDxf({ entities: ['0', 'CIRCLE', '10', '0', '20', '0', '40', '0'] });
    expect(() => readDxf(tags)).toThrow(DXF_UNSUPPORTED_FORMAT_MESSAGE);
  });

  it('必要なグループコードが欠けた LINE を断る', () => {
    // 終点の Y(グループ 21)が無い。
    const tags = buildDxf({ entities: ['0', 'LINE', '10', '0', '20', '0', '11', '10'] });
    expect(() => readDxf(tags)).toThrow(DXF_UNSUPPORTED_FORMAT_MESSAGE);
  });

  it('ELLIPSE を長軸・短軸・傾きへ直す', () => {
    const result = readDxf(
      buildDxf({
        // 中心 (0,0)、長軸の端は中心から (20,0)、短軸比 0.5、41/42 が無いので全周。
        entities: ['0', 'ELLIPSE', '10', '0', '20', '0', '11', '20', '21', '0', '40', '0.5'],
      }),
    );
    const [entity] = result.entities;
    if (entity.kind !== 'ellipse') {
      throw new Error('楕円として読めていない');
    }
    expect(entity.majorRadius).toBe(20);
    expect(entity.minorRadius).toBe(10);
    expect(entity.rotation).toBe(0);
    expect(entity.startAngle).toBe(0);
    expect(entity.endAngle).toBe(360);
    // 面積 = π·20·10 = 628.3185307179587。
    expect(Math.PI * entity.majorRadius * entity.minorRadius).toBeCloseTo(628.3185307179587, 12);
  });

  it('SPLINE を制御点の版として読む', () => {
    const result = readDxf(
      buildDxf({
        entities: [
          '0', 'SPLINE', '71', '3',
          '10', '0', '20', '0',
          '10', '1', '20', '2',
          '10', '3', '20', '2',
          '10', '4', '20', '0',
        ],
      }),
    );
    const [entity] = result.entities;
    if (entity.kind !== 'spline') {
      throw new Error('自由曲線として読めていない');
    }
    expect(entity.mode).toBe('control');
    expect(entity.degree).toBe(3);
    expect(entity.points).toHaveLength(4);
    expect(entity.points[1]).toEqual({ x: 1, y: 2 });
    expect(entity.closed).toBe(false);
    expect(entity.warnings).toHaveLength(0);
  });

  it('SPLINE のフィット点だけなら通過点の版として読む', () => {
    const result = readDxf(
      buildDxf({
        entities: [
          '0', 'SPLINE', '71', '3',
          '11', '0', '21', '0',
          '11', '5', '21', '5',
          '11', '10', '21', '0',
        ],
      }),
    );
    const [entity] = result.entities;
    if (entity.kind !== 'spline') {
      throw new Error('自由曲線として読めていない');
    }
    expect(entity.mode).toBe('interpolate');
    expect(entity.points).toHaveLength(3);
  });

  it('LWPOLYLINE の 70 の bit 1 で最後の 1 本が増える', () => {
    const open: readonly string[] = [
      '0', 'LWPOLYLINE', '90', '4',
      '10', '0', '20', '0',
      '10', '10', '20', '0',
      '10', '10', '20', '10',
      '10', '0', '20', '10',
    ];
    // 開いた 4 点は線分 3 本。
    expect(readDxf(buildDxf({ entities: open })).entities).toHaveLength(3);
    // 閉じる旗(70 = 1)を足すと、最後の点から最初の点へ 1 本増えて 4 本。
    const closed = readDxf(buildDxf({ entities: [...open, '70', '1'] }));
    expect(closed.entities).toHaveLength(4);
    expect(kindsOf(closed.entities)).toEqual(['line', 'line', 'line', 'line']);
    const last = closed.entities[3];
    if (last.kind !== 'line') {
      throw new Error('線分として読めていない');
    }
    expect(last.start).toEqual({ x: 0, y: 10 });
    expect(last.end).toEqual({ x: 0, y: 0 });
  });

  it('LWPOLYLINE のふくらみ(42)がある区間は円弧になる', () => {
    const result = readDxf(
      buildDxf({
        entities: [
          '0', 'LWPOLYLINE', '90', '2',
          '10', '0', '20', '0', '42', '1',
          '10', '20', '20', '0',
        ],
      }),
    );
    expect(kindsOf(result.entities)).toEqual(['arc']);
    const [entity] = result.entities;
    if (entity.kind !== 'arc') {
      throw new Error('円弧として読めていない');
    }
    // bulge = 1 は中心角 4·atan(1) = π(半円)。弦 20 の半円なので半径 10、中心は弦の中点。
    expect(entity.center).toEqual({ x: 10, y: 0 });
    expect(entity.radius).toBe(10);
    expect(entity.endAngle - entity.startAngle).toBeCloseTo(180, 12);
  });

  it('POLYLINE + VERTEX + SEQEND は LWPOLYLINE と同じに読める', () => {
    const lwPolyline = readDxf(
      buildDxf({
        entities: [
          '0', 'LWPOLYLINE', '70', '1', '90', '3',
          '10', '0', '20', '0',
          '10', '10', '20', '0', '42', '1',
          '10', '10', '20', '10',
        ],
      }),
    );
    const polyline = readDxf(
      buildDxf({
        entities: [
          '0', 'POLYLINE', '70', '1',
          '0', 'VERTEX', '10', '0', '20', '0',
          '0', 'VERTEX', '10', '10', '20', '0', '42', '1',
          '0', 'VERTEX', '10', '10', '20', '10',
          '0', 'SEQEND',
        ],
      }),
    );
    expect(polyline.entities).toEqual(lwPolyline.entities);
    expect(kindsOf(polyline.entities)).toEqual(['line', 'arc', 'line']);
  });

  it('SEQEND が無い POLYLINE も頂点を取り違えない', () => {
    const result = readDxf(
      buildDxf({
        entities: [
          '0', 'POLYLINE',
          '0', 'VERTEX', '10', '0', '20', '0',
          '0', 'VERTEX', '10', '10', '20', '0',
          ...LINE_10,
        ],
      }),
    );
    // 多角形の線分 1 本 + 後ろの LINE 1 本。
    expect(result.entities).toHaveLength(2);
  });

  it('レイヤー名の空白を残し、色(62)を整数のまま持つ', () => {
    const result = readDxf(
      buildDxf({
        entities: ['0', 'LINE', '8', ' 外形 ', '62', '7', '10', '0', '20', '0', '11', '1', '21', '1'],
      }),
    );
    const [entity] = result.entities;
    // 前後の空白を落とすと別のレイヤーに化けるので、値はそのまま持つ(タスク22 の決めと揃える)。
    expect(entity.layer).toBe(' 外形 ');
    expect(entity.color).toBe(7);
  });

  it('レイヤーと色が無ければ既定の `0` と null になる', () => {
    const result = readDxf(buildDxf({ entities: ['0', 'POINT', '10', '1', '20', '1'] }));
    expect(result.entities[0].layer).toBe('0');
    expect(result.entities[0].color).toBe(null);
  });

  it('知らない実体(HATCH)は飛ばして残りを読む', () => {
    const result = readDxf(
      buildDxf({
        entities: [
          '0', 'HATCH', '8', '0', '91', '1', '10', '0', '20', '0',
          ...LINE_10,
          '0', 'TEXT', '1', 'ABC', '10', '0', '20', '0',
        ],
      }),
    );
    expect(result.entities).toHaveLength(1);
    expect(result.skippedEntityCount).toBe(2);
  });

  it('Z が 0 でない実体を平らにして数える(§0.a-0.33)', () => {
    const result = readDxf(
      buildDxf({
        entities: [
          '0', 'LINE', '10', '0', '20', '0', '30', '5', '11', '10', '21', '0', '31', '5',
          ...LINE_10,
          '0', 'LWPOLYLINE', '38', '2.5', '10', '0', '20', '0', '10', '5', '20', '0',
        ],
      }),
    );
    // 数えるのは「元の図形の数」。多角形は開いても 1 個(§0.33 の「図形が N 個」)。
    expect(result.offPlaneCount).toBe(2);
    const [first] = result.entities;
    if (first.kind !== 'line') {
      throw new Error('線分として読めていない');
    }
    // Z は捨てて平らに取り込む。
    expect(first.start).toEqual({ x: 0, y: 0 });
    expect(first.end).toEqual({ x: 10, y: 0 });
  });
});

describe('INSERT の展開(計画書 §0.a-0.32)', () => {
  it('ブロックの LINE を挿入点ぶん平行移動して展開する', () => {
    const result = readDxf(
      buildDxf({
        blocks: block('A', LINE_10),
        entities: ['0', 'INSERT', '2', 'A', '10', '100', '20', '50'],
      }),
    );
    expect(result.blockCount).toBe(1);
    const [entity] = result.entities;
    if (entity.kind !== 'line') {
      throw new Error('線分として読めていない');
    }
    expect(entity.start).toEqual({ x: 100, y: 50 });
    expect(entity.end).toEqual({ x: 110, y: 50 });
  });

  it('ブロックの基点(10/20)を引いてから配置する', () => {
    const result = readDxf(
      buildDxf({
        // 基点 (5,0) のブロックに、(5,0)→(15,0) の線分を入れる。
        blocks: block(
          'A',
          ['0', 'LINE', '10', '5', '20', '0', '11', '15', '21', '0'],
          ['5', '0'],
        ),
        entities: ['0', 'INSERT', '2', 'A', '10', '100', '20', '0'],
      }),
    );
    const [entity] = result.entities;
    if (entity.kind !== 'line') {
      throw new Error('線分として読めていない');
    }
    expect(entity.start.x).toBeCloseTo(100, 12);
    expect(entity.end.x).toBeCloseTo(110, 12);
  });

  it('ブロック名は大文字小文字を区別せずに引く', () => {
    const result = readDxf(
      buildDxf({ blocks: block('Frame', LINE_10), entities: ['0', 'INSERT', '2', 'FRAME'] }),
    );
    expect(result.entities).toHaveLength(1);
  });

  it('倍率 2・回転 90 度で座標が 2 倍になって 90 度回る', () => {
    const result = readDxf(
      buildDxf({
        blocks: block('A', LINE_10),
        entities: ['0', 'INSERT', '2', 'A', '10', '0', '20', '0', '41', '2', '42', '2', '50', '90'],
      }),
    );
    const [entity] = result.entities;
    if (entity.kind !== 'line') {
      throw new Error('線分として読めていない');
    }
    // (10,0) を 2 倍して 90 度回すと (0,20)。cos(90°) が厳密に 0 にならないので近似で見る。
    expect(entity.start.x).toBeCloseTo(0, 12);
    expect(entity.start.y).toBeCloseTo(0, 12);
    expect(entity.end.x).toBeCloseTo(0, 12);
    expect(entity.end.y).toBeCloseTo(20, 12);
  });

  it('倍率が等しければ円弧も半径ごと写る', () => {
    const result = readDxf(
      buildDxf({
        blocks: block('A', ['0', 'ARC', '10', '0', '20', '0', '40', '10', '50', '0', '51', '90']),
        entities: ['0', 'INSERT', '2', 'A', '10', '0', '20', '0', '41', '3', '42', '3'],
      }),
    );
    const [entity] = result.entities;
    if (entity.kind !== 'arc') {
      throw new Error('円弧として読めていない');
    }
    expect(entity.radius).toBe(30);
    expect(entity.startAngle).toBeCloseTo(0, 12);
    expect(entity.endAngle).toBeCloseTo(90, 12);
  });

  it('鏡像(倍率が負)では円弧の回る向きが反転する', () => {
    const result = readDxf(
      buildDxf({
        blocks: block('A', ['0', 'ARC', '10', '0', '20', '0', '40', '10', '50', '0', '51', '90']),
        entities: ['0', 'INSERT', '2', 'A', '41', '-1', '42', '1'],
      }),
    );
    const [entity] = result.entities;
    if (entity.kind !== 'arc') {
      throw new Error('円弧として読めていない');
    }
    // X を反転すると、始点 (10,0) は (−10,0)(= 180 度)へ移り、掃過は −90 度になる。
    // 元の中間点 45 度 = (7.07, 7.07) の像 (−7.07, 7.07) = 135 度が、180 度と 90 度の間にある。
    expect(entity.radius).toBe(10);
    expect(entity.startAngle).toBeCloseTo(180, 12);
    expect(entity.endAngle).toBeCloseTo(90, 12);
  });

  it('縦横で倍率が違う配置の中に円弧があれば断る', () => {
    const tags = buildDxf({
      blocks: block('A', ['0', 'CIRCLE', '10', '0', '20', '0', '40', '10']),
      entities: ['0', 'INSERT', '2', 'A', '41', '2', '42', '3'],
    });
    // 円は楕円へ、楕円は別の楕円へ化けるので、黙って形を変えずに断る。
    expect(() => readDxf(tags)).toThrow(DXF_NON_UNIFORM_SCALE_MESSAGE);
  });

  it('縦横で倍率が違っても、点・線分・自由曲線は写せる', () => {
    const result = readDxf(
      buildDxf({
        blocks: block('A', LINE_10),
        entities: ['0', 'INSERT', '2', 'A', '41', '2', '42', '3'],
      }),
    );
    const [entity] = result.entities;
    if (entity.kind !== 'line') {
      throw new Error('線分として読めていない');
    }
    expect(entity.end).toEqual({ x: 20, y: 0 });
  });

  it('入れ子 8 段は展開できる', () => {
    const result = readDxf(
      buildDxf({ blocks: nestedBlocks(8), entities: ['0', 'INSERT', '2', 'B1'] }),
    );
    expect(result.entities).toHaveLength(1);
    expect(result.blockCount).toBe(8);
  });

  it('入れ子 9 段は断る', () => {
    const tags = buildDxf({ blocks: nestedBlocks(9), entities: ['0', 'INSERT', '2', 'B1'] });
    expect(() => readDxf(tags)).toThrow(DXF_BLOCK_NESTING_MESSAGE);
  });

  it('自分自身を置くブロックは 8 段で止まって断る(無限に回らない)', () => {
    const tags = buildDxf({
      blocks: block('SELF', [...LINE_10, '0', 'INSERT', '2', 'SELF']),
      entities: ['0', 'INSERT', '2', 'SELF'],
    });
    expect(() => readDxf(tags)).toThrow(DXF_BLOCK_NESTING_MESSAGE);
  });

  it('定義の無いブロックを置く INSERT は飛ばす', () => {
    const result = readDxf(
      buildDxf({ blocks: block('A', LINE_10), entities: ['0', 'INSERT', '2', 'MISSING'] }),
    );
    expect(result.entities).toHaveLength(0);
    expect(result.skippedEntityCount).toBe(1);
  });

  it('ブロックの中の知らない実体と、外れた Z も数える', () => {
    const result = readDxf(
      buildDxf({
        blocks: block('A', [...LINE_10, '0', 'MTEXT', '1', 'ABC']),
        // 同じブロックを 2 回置くので、飛ばした数も外れた数も 2 回ぶん増える。
        entities: [
          '0', 'INSERT', '2', 'A', '10', '0', '20', '0', '30', '3',
          '0', 'INSERT', '2', 'A', '10', '50', '20', '0', '30', '3',
        ],
      }),
    );
    expect(result.entities).toHaveLength(2);
    expect(result.skippedEntityCount).toBe(2);
    expect(result.offPlaneCount).toBe(2);
  });

  it('展開した実体が上限を超えたら断る', () => {
    // 1 段あたり 6 個置く入れ子を 8 段作ると、いちばん奥は 6⁷ = 279,936 本になる。
    const lines: string[] = [];
    for (let level = 1; level <= 8; level += 1) {
      const body =
        level === 8
          ? LINE_10
          : Array.from({ length: 6 }, () => ['0', 'INSERT', '2', `B${String(level + 1)}`]).flat();
      lines.push(...block(`B${String(level)}`, body));
    }
    const tags = buildDxf({ blocks: lines, entities: ['0', 'INSERT', '2', 'B1'] });
    expect(6 ** 7).toBeGreaterThan(DXF_MAX_ENTITY_COUNT);
    expect(() => readDxf(tags)).toThrow(DXF_TOO_MANY_ENTITIES_MESSAGE);
  });
});
