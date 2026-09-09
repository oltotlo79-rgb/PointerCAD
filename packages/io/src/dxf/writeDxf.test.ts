import { describe, expect, it } from 'vitest';

import { parseDxfTags, type DxfTag } from './dxfTags.js';
import { readDxf, type DxfEntity, type DxfLineEntity } from './readDxf.js';
import {
  dxfFlattenedCurveMessage,
  DXF_WRITE_ACAD_VERSION,
  DXF_WRITE_INSUNITS,
  DXF_WRITE_INVALID_VALUE_MESSAGE,
  formatDxfNumber,
  writeDxf,
  writeDxfDocument,
} from './writeDxf.js';

/*
 * DXF の書き出しの検査(計画書 docs/plans/P6-入出力.md §2.7 とタスク25 の検証表)。
 *
 * 期待値はすべて注釈の導出から手で出し、計画書の表からは写さない
 * (P0 タスク10・12、P1 タスク11、P3 タスク5・8 で計画書の期待値が誤っていた実績があるため)。
 *
 * 往復(書いて読み直す)は `readDxf`(タスク24)へ通す。**同じ実体が戻ること**を
 * 書き出しの正しさの尺度にできるのは、読み込みの側が別の検査で固定されているため。
 */

const LINE: DxfLineEntity = {
  kind: 'line',
  layer: '0',
  color: null,
  start: { x: 0, y: 0 },
  end: { x: 10, y: 0 },
};

/** 書いた文字列を実体へ戻す(往復の検査に使う)。 */
function readBack(text: string): readonly DxfEntity[] {
  return readDxf(parseDxfTags(text)).entities;
}

/** グループ 0 の値(実体・セクションの名前)を出てきた順に並べる。 */
function structureOf(text: string): readonly string[] {
  return parseDxfTags(text)
    .filter((item: DxfTag) => item.code === 0)
    .map((item: DxfTag) => item.value);
}

/** `code` のタグの値をすべて拾う。 */
function valuesOf(text: string, code: number): readonly string[] {
  return parseDxfTags(text)
    .filter((item: DxfTag) => item.code === code)
    .map((item: DxfTag) => item.value);
}

describe('formatDxfNumber', () => {
  it('小数点以下 9 桁で丸め、末尾の 0 と小数点を落とす', () => {
    // §2.7「小数点以下 9 桁」。`1.5` は `1.500000000` ではなく `1.5` と書く。
    expect(formatDxfNumber(1.5)).toBe('1.5');
    expect(formatDxfNumber(10)).toBe('10');
    expect(formatDxfNumber(1 / 3)).toBe('0.333333333');
    // 9 桁より細かい桁は丸める(0.0000000004 → 0、0.0000000006 → 0.000000001)。
    expect(formatDxfNumber(4e-10)).toBe('0');
    expect(formatDxfNumber(6e-10)).toBe('0.000000001');
  });

  it('`-0` と、丸めて 0 になる負の数は `0` と書く', () => {
    // 同じ形から違うバイト列ができないようにするため(決定性、§0.a-0.62)。
    expect(formatDxfNumber(-0)).toBe('0');
    expect(formatDxfNumber(-1e-12)).toBe('0');
    expect(formatDxfNumber(-1.5)).toBe('-1.5');
  });

  it('有限でない数と、指数表記になる大きさを断る', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1e21]) {
      expect(() => formatDxfNumber(value)).toThrow(DXF_WRITE_INVALID_VALUE_MESSAGE);
    }
  });
});

describe('writeDxf の骨組み', () => {
  it('実体が空でも、他 CAD が開ける骨だけの DXF を書く(断らない)', () => {
    const text = writeDxf([]);

    // セクションは HEADER・TABLES・ENTITIES の 3 つで、最後は EOF。
    expect(structureOf(text)).toEqual([
      'SECTION', // HEADER
      'ENDSEC',
      'SECTION', // TABLES
      'TABLE',
      'LTYPE',
      'ENDTAB',
      'TABLE',
      'LAYER',
      'ENDTAB',
      'ENDSEC',
      'SECTION', // ENTITIES
      'ENDSEC',
      'EOF',
    ]);
    expect(readBack(text)).toEqual([]);
  });

  it('版は AC1009(R12)、単位は `$INSUNITS = 4`(mm)', () => {
    const text = writeDxf([LINE]);

    // §0.a-0.30(版は R12)と §0.a-0.7(書き出しは常に mm)。
    expect(valuesOf(text, 9)).toEqual(['$ACADVER', '$INSUNITS']);
    expect(valuesOf(text, 1)).toEqual([DXF_WRITE_ACAD_VERSION]);
    expect(DXF_WRITE_INSUNITS).toBe(4);
    // 単位は読み直しても mm と分かる(`readDxf` が `$INSUNITS` を見る)。
    expect(readDxf(parseDxfTags(text)).insUnits).toBe(4);
    expect(readDxf(parseDxfTags(text)).unit).toBe('mm');
  });

  it('レイヤーの表に、実体が使ったレイヤーが出てきた順に入る(`0` は必ず先頭)', () => {
    const entities: readonly DxfEntity[] = [
      { ...LINE, layer: '外形' },
      { ...LINE, layer: '0' },
      { ...LINE, layer: '外形' },
    ];
    const text = writeDxf(entities);

    // 表の名前(グループ 2)は「セクション名 / 表の種類 / 線種名 / レイヤー名」の順に並ぶ。
    expect(valuesOf(text, 2)).toEqual([
      'HEADER',
      'TABLES',
      'LTYPE',
      'CONTINUOUS',
      'LAYER',
      '0',
      '\\U+5916\\U+5F62',
      'ENTITIES',
    ]);
  });

  it('改行はすべて `\\r\\n`(最後の行にも付く)', () => {
    const text = writeDxf([LINE]);

    // `\n` の数と `\r\n` の数が同じなら、裸の `\n` は 1 つも無い(DXF の慣習。§2.7)。
    expect((text.match(/\n/g) ?? []).length).toBe((text.match(/\r\n/g) ?? []).length);
    expect(text.endsWith('EOF\r\n')).toBe(true);
  });

  it('同じ実体から 2 回書くと文字列が完全に一致する(決定性)', () => {
    const first = writeDxf([LINE, { ...LINE, layer: '外形', color: 3 }]);
    const second = writeDxf([
      {
        kind: 'line',
        layer: '0',
        color: null,
        start: { x: 0, y: 0 },
        end: { x: 10, y: 0 },
      },
      {
        kind: 'line',
        layer: '外形',
        color: 3,
        start: { x: 0, y: 0 },
        end: { x: 10, y: 0 },
      },
    ]);

    // 日時も作成者も乱数も書かないので、別々に作った同じ実体からも同じバイト列になる。
    expect(second).toBe(first);
  });
});

describe('writeDxf の実体', () => {
  it('線分は `LINE` の 10/20/11/21 に座標が入り、読み直すと同じ線分が戻る', () => {
    const entity: DxfLineEntity = {
      ...LINE,
      start: { x: 1.5, y: -3.5 },
      end: { x: 10, y: 20.25 },
    };
    const text = writeDxf([entity]);

    expect(structureOf(text)).toContain('LINE');
    expect(valuesOf(text, 10)).toEqual(['1.5']);
    expect(valuesOf(text, 20)).toEqual(['-3.5']);
    expect(valuesOf(text, 11)).toEqual(['10']);
    expect(valuesOf(text, 21)).toEqual(['20.25']);
    expect(readBack(text)).toEqual([entity]);
  });

  it('点は `POINT` として書き、読み直すと同じ点が戻る', () => {
    const entity: DxfEntity = {
      kind: 'point',
      layer: '0',
      color: null,
      position: { x: -2.125, y: 7 },
    };
    const text = writeDxf([entity]);

    expect(structureOf(text)).toContain('POINT');
    expect(readBack(text)).toEqual([entity]);
  });

  it('全周の円弧は `CIRCLE`(40 が半径)として書く', () => {
    const entity: DxfEntity = {
      kind: 'arc',
      layer: '0',
      color: null,
      center: { x: 0, y: 0 },
      radius: 10,
      startAngle: 0,
      endAngle: 360,
    };
    const text = writeDxf([entity]);

    expect(structureOf(text)).toContain('CIRCLE');
    expect(structureOf(text)).not.toContain('ARC');
    // 40 は線種の表(模様の長さ 0)にも出るので、後ろの 1 つが半径。
    expect(valuesOf(text, 40)).toEqual(['0', '10']);
    expect(readBack(text)).toEqual([entity]);
  });

  it('0〜90 度の円弧は `ARC` の 50 = 0・51 = 90(度)になる', () => {
    const entity: DxfEntity = {
      kind: 'arc',
      layer: '0',
      color: null,
      center: { x: 1, y: 2 },
      radius: 10,
      startAngle: 0,
      endAngle: 90,
    };
    const text = writeDxf([entity]);

    expect(structureOf(text)).toContain('ARC');
    expect(valuesOf(text, 50)).toEqual(['0']);
    expect(valuesOf(text, 51)).toEqual(['90']);
    expect(readBack(text)).toEqual([entity]);
  });

  it('時計回りの円弧は始めと終わりを入れ替えて書く(DXF の `ARC` は必ず反時計回り)', () => {
    // 90 度から 0 度へ時計回りに回る円弧は、0 度から 90 度へ反時計回りに回る円弧と同じ形。
    const clockwise: DxfEntity = {
      kind: 'arc',
      layer: '0',
      color: null,
      center: { x: 0, y: 0 },
      radius: 10,
      startAngle: 90,
      endAngle: 0,
    };
    const text = writeDxf([clockwise]);

    expect(valuesOf(text, 50)).toEqual(['0']);
    expect(valuesOf(text, 51)).toEqual(['90']);
    // 向きは DXF に書けないので、読み直すと反時計回りの同じ形が戻る(形は変わらない)。
    expect(readBack(text)).toEqual([{ ...clockwise, startAngle: 0, endAngle: 90 }]);
  });

  it('負の角度・360 度を超える角度は `[0, 360)` へ畳んで書く', () => {
    const entity: DxfEntity = {
      kind: 'arc',
      layer: '0',
      color: null,
      center: { x: 0, y: 0 },
      radius: 5,
      startAngle: 350,
      endAngle: 380, // 350 度から 30 度ぶん回る(終わりは 20 度)。
    };
    const text = writeDxf([entity]);

    expect(valuesOf(text, 50)).toEqual(['350']);
    expect(valuesOf(text, 51)).toEqual(['20']);
    // 読み直すと開始 350 度・中心角 30 度(終了 380 度)に戻る。
    expect(readBack(text)).toEqual([entity]);
  });

  it('レイヤーと色(62)を書き、読み直すと同じ欄が戻る', () => {
    const entity: DxfEntity = { ...LINE, layer: '外形', color: 3 };
    const text = writeDxf([entity]);

    // 色は実体ごとの 62。レイヤーの表の 62(7)と合わせて 2 つ出る。
    expect(valuesOf(text, 62)).toEqual(['7', '7', '3']);
    expect(valuesOf(text, 8)).toEqual(['\\U+5916\\U+5F62']);
    expect(readBack(text)).toEqual([entity]);
  });

  it('色を持たない実体には 62 を書かない', () => {
    // `null` は「色の指定が無い」で、`0`(ブロックに従う)とは違う。
    const text = writeDxf([LINE]);
    // レイヤーの表の 2 行(`0` の 1 枚)ぶんだけが残る。
    expect(valuesOf(text, 62)).toEqual(['7']);
    expect(readBack(text)[0].color).toBeNull();
  });
});

describe('writeDxf の曲線の落とし方(R12 に ELLIPSE / SPLINE が無い)', () => {
  it('楕円は折れ線(POLYLINE + VERTEX + SEQEND)へ落とし、件数を返す', () => {
    const entity: DxfEntity = {
      kind: 'ellipse',
      layer: '0',
      color: null,
      center: { x: 0, y: 0 },
      majorRadius: 20,
      minorRadius: 10,
      rotation: 0,
      startAngle: 0,
      endAngle: 360,
    };
    const result = writeDxfDocument([entity]);

    // R13 の実体は書かない(AC1009 と名乗るファイルに混ぜると読めない CAD がある)。
    expect(result.text).not.toContain('ELLIPSE');
    expect(structureOf(result.text)).toContain('POLYLINE');
    expect(structureOf(result.text)).toContain('SEQEND');
    expect(result.flattenedCurveCount).toBe(1);

    // 全周は 5 度ごとの 72 分割。閉じた折れ線なので線分も 72 本に開ける。
    const entities = readBack(result.text);
    expect(entities).toHaveLength(72);
    for (const line of entities) {
      expect(line.kind).toBe('line');
      if (line.kind === 'line') {
        // 楕円の式 x²/a² + y²/b² = 1 の上に乗っている(9 桁の丸めのぶんだけ許す)。
        const value = (line.start.x / 20) ** 2 + (line.start.y / 10) ** 2;
        expect(Math.abs(value - 1)).toBeLessThan(1e-9);
      }
    }
  });

  it('楕円の弧は両端を含む折れ線になり、端の点が指定した方位角に来る', () => {
    const entity: DxfEntity = {
      kind: 'ellipse',
      layer: '0',
      color: null,
      center: { x: 0, y: 0 },
      majorRadius: 20,
      minorRadius: 10,
      rotation: 0,
      startAngle: 0,
      endAngle: 90,
    };
    const result = writeDxfDocument([entity]);
    const entities = readBack(result.text);

    // 90 度は 72 × (90/360) = 18 分割。開いた折れ線なので線分は 18 本。
    expect(entities).toHaveLength(18);
    const first = entities[0];
    const last = entities[entities.length - 1];
    expect(first.kind).toBe('line');
    expect(last.kind).toBe('line');
    if (first.kind === 'line' && last.kind === 'line') {
      // 方位角 0 度の端は長軸の端(20, 0)、90 度の端は短軸の端(0, 10)。
      expect(first.start.x).toBeCloseTo(20, 9);
      expect(first.start.y).toBeCloseTo(0, 9);
      expect(last.end.x).toBeCloseTo(0, 9);
      expect(last.end.y).toBeCloseTo(10, 9);
    }
  });

  it('自由曲線は折れ線へ落とし、両端が最初と最後の点に来る', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: -10 },
      { x: 30, y: 0 },
    ];
    const entity: DxfEntity = {
      kind: 'spline',
      layer: '0',
      color: null,
      mode: 'control',
      points,
      closed: false,
      degree: 3,
      warnings: [],
    };
    const result = writeDxfDocument([entity]);

    expect(result.text).not.toContain('SPLINE');
    expect(result.flattenedCurveCount).toBe(1);
    // `sampleSpline` の既定は 1 スパン 16 分割。開いた 4 点は 3 スパンで 48 本。
    const entities = readBack(result.text);
    expect(entities).toHaveLength(48);
    const first = entities[0];
    const last = entities[entities.length - 1];
    if (first.kind === 'line' && last.kind === 'line') {
      // 制御点方式の B スプラインは、両端の極を必ず通る(節点を端で重ねているため)。
      expect(first.start.x).toBeCloseTo(0, 9);
      expect(first.start.y).toBeCloseTo(0, 9);
      expect(last.end.x).toBeCloseTo(30, 9);
      expect(last.end.y).toBeCloseTo(0, 9);
    }
  });

  it('閉じた自由曲線は閉じた折れ線になる(先頭へ戻る点を重ねて置かない)', () => {
    const entity: DxfEntity = {
      kind: 'spline',
      layer: '0',
      color: null,
      mode: 'control',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      closed: true,
      degree: 3,
      warnings: [],
    };
    const result = writeDxfDocument([entity]);

    // 70 は線種の表(0)・レイヤーの表(枚数と各行)にも出るので、最後の 1 つが折れ線の旗。
    const flags = valuesOf(result.text, 70);
    expect(flags[flags.length - 1]).toBe('1');
    // 閉じた 4 点は 4 スパン。16 分割で 64 本の線分になる(重複点が無いので 64 本ちょうど)。
    expect(readBack(result.text)).toHaveLength(64);
  });

  it('折れ線へ落とした本数の案内は 1 か所の文言から作る', () => {
    const result = writeDxfDocument([
      {
        kind: 'ellipse',
        layer: '0',
        color: null,
        center: { x: 0, y: 0 },
        majorRadius: 20,
        minorRadius: 10,
        rotation: 0,
        startAngle: 0,
        endAngle: 360,
      },
      LINE,
      {
        kind: 'spline',
        layer: '0',
        color: null,
        mode: 'interpolate',
        points: [
          { x: 0, y: 0 },
          { x: 5, y: 5 },
          { x: 10, y: 0 },
        ],
        closed: false,
        degree: 3,
        warnings: [],
      },
    ]);

    // 線分は数えない(形が変わらないため)。
    expect(result.flattenedCurveCount).toBe(2);
    expect(dxfFlattenedCurveMessage(result.flattenedCurveCount)).toBe(
      '2 個の曲線は折れ線に近づけて書き出しました。',
    );
  });
});

describe('writeDxf が断るもの', () => {
  it('有限でない座標を断る', () => {
    expect(() => writeDxf([{ ...LINE, end: { x: Number.NaN, y: 0 } }])).toThrow(
      DXF_WRITE_INVALID_VALUE_MESSAGE,
    );
  });

  it('半径が 0 以下の円弧・楕円を断る', () => {
    // `readDxf` が 0 以下の半径を断るので、読み直せない DXF を作らない。
    expect(() =>
      writeDxf([
        {
          kind: 'arc',
          layer: '0',
          color: null,
          center: { x: 0, y: 0 },
          radius: 0,
          startAngle: 0,
          endAngle: 90,
        },
      ]),
    ).toThrow(DXF_WRITE_INVALID_VALUE_MESSAGE);
    expect(() =>
      writeDxf([
        {
          kind: 'ellipse',
          layer: '0',
          color: null,
          center: { x: 0, y: 0 },
          majorRadius: 20,
          minorRadius: 0,
          rotation: 0,
          startAngle: 0,
          endAngle: 360,
        },
      ]),
    ).toThrow(DXF_WRITE_INVALID_VALUE_MESSAGE);
  });

  it('点が 1 つしかない自由曲線を断る', () => {
    // 折れ線にすると線分 0 本になり、書いても読み直すと消えてしまうため。
    expect(() =>
      writeDxf([
        {
          kind: 'spline',
          layer: '0',
          color: null,
          mode: 'control',
          points: [{ x: 1, y: 2 }],
          closed: false,
          degree: 1,
          warnings: [],
        },
      ]),
    ).toThrow(DXF_WRITE_INVALID_VALUE_MESSAGE);
  });

  it('改行を含むレイヤー名と、範囲の外の色を断る', () => {
    // 改行の入った名前を書くと、タグの対応がずれた読めないファイルになる。
    expect(() => writeDxf([{ ...LINE, layer: '外\n形' }])).toThrow(
      DXF_WRITE_INVALID_VALUE_MESSAGE,
    );
    expect(() => writeDxf([{ ...LINE, color: 300 }])).toThrow(DXF_WRITE_INVALID_VALUE_MESSAGE);
    expect(() => writeDxf([{ ...LINE, color: 1.5 }])).toThrow(DXF_WRITE_INVALID_VALUE_MESSAGE);
  });

  it('レイヤー名が空なら `0` として書く(DXF は空の名前を持てない)', () => {
    const text = writeDxf([{ ...LINE, layer: '' }]);
    expect(valuesOf(text, 8)).toEqual(['0']);
    expect(readBack(text)[0].layer).toBe('0');
  });
});
