import { addVec3, polarOffset, WORK_PLANES } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  COMMAND_WORDS,
  parseCommandLine,
  suggestCommands,
  type CommandLineContext,
} from './commandLine.js';

const NO_VARIABLES: ReadonlyMap<string, number> = new Map();

/** 既定の手掛かり(作図面 XY、直前の点あり、変数なし)。個々のテストで上書きする。 */
function context(overrides: Partial<CommandLineContext> = {}): CommandLineContext {
  return {
    plane: WORK_PLANES.xy,
    variables: NO_VARIABLES,
    hasPrevious: true,
    ...overrides,
  };
}

describe('COMMAND_WORDS(道具の語の表)', () => {
  it('対象の 23 道具(スケッチ 6 + 図形 8 + 編集 7 + クリック整形 2)を持つ', () => {
    expect(COMMAND_WORDS.length).toBe(23);
  });

  it('語(ja/en/短縮)に重複が無い(大文字小文字を区別しない)', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const entry of COMMAND_WORDS) {
      for (const word of entry.words) {
        const key = word.toLowerCase();
        if (seen.has(key)) {
          duplicates.push(word);
        }
        seen.add(key);
      }
    }
    expect(duplicates).toEqual([]);
  });

  it('計画書が明示した 17 道具の語をそのまま持つ', () => {
    const byTool = new Map(COMMAND_WORDS.map((entry) => [entry.tool, entry.words]));
    expect(byTool.get('line')).toEqual(['線分', 'line', 'l']);
    expect(byTool.get('circle')).toEqual(['円', 'circle', 'c']);
    expect(byTool.get('arc')).toEqual(['円弧', 'arc', 'a']);
    expect(byTool.get('point')).toEqual(['点', 'point', 'po']);
    expect(byTool.get('rectangle')).toEqual(['矩形', '長方形', 'rectangle', 'rec']);
    expect(byTool.get('polygon')).toEqual(['正多角形', '多角形', 'polygon', 'pol']);
    expect(byTool.get('slot')).toEqual(['長穴', 'slot', 'sl']);
    expect(byTool.get('ellipse')).toEqual(['楕円', 'ellipse', 'el']);
    expect(byTool.get('spline')).toEqual(['スプライン', 'spline', 'spl']);
    expect(byTool.get('copy')).toEqual(['複写', 'copy', 'co']);
    expect(byTool.get('mirror')).toEqual(['ミラー', '鏡像', 'mirror', 'mi']);
    expect(byTool.get('offset')).toEqual(['オフセット', 'offset', 'o']);
    expect(byTool.get('trim')).toEqual(['トリム', 'trim', 'tr']);
    expect(byTool.get('extend')).toEqual(['延長', 'extend', 'ex']);
    expect(byTool.get('sketchFillet')).toEqual(['フィレット', 'fillet', 'f']);
    expect(byTool.get('sketchChamfer')).toEqual(['面取り', 'chamfer', 'cha']);
    expect(byTool.get('face')).toEqual(['面', 'face', 'fa']);
  });

  it('担当が自分で決めた 6 道具の語を持つ(短縮の根拠は commandLine.ts 冒頭の注釈)', () => {
    const byTool = new Map(COMMAND_WORDS.map((entry) => [entry.tool, entry.words]));
    expect(byTool.get('select')).toEqual(['選択', 'select', 's']);
    expect(byTool.get('pointArray')).toEqual(['点列', 'pointarray', 'pa']);
    expect(byTool.get('twoPointArc')).toEqual(['2点円弧', 'twopointarc', 'ta']);
    expect(byTool.get('threePointArc')).toEqual(['3点の円弧', 'threepointarc', 'tpa']);
    expect(byTool.get('linearArray')).toEqual(['直線配列', 'lineararray', 'ar']);
    expect(byTool.get('circularArray')).toEqual(['円形配列', 'circulararray', 'par']);
  });
});

describe('parseCommandLine: 道具の切替', () => {
  it.each(['LINE', 'line', 'L', 'l', '線分'])('%s は線分の道具になる', (word) => {
    expect(parseCommandLine(word, context())).toEqual({ kind: 'tool', tool: 'line' });
  });

  it.each(['CIRCLE', 'C', '円'])('%s は円の道具になる', (word) => {
    expect(parseCommandLine(word, context())).toEqual({ kind: 'tool', tool: 'circle' });
  });

  it('CO は複写になる(C は円、CO は複写)', () => {
    expect(parseCommandLine('CO', context())).toEqual({ kind: 'tool', tool: 'copy' });
  });
});

describe('parseCommandLine: 絶対座標', () => {
  it('10,20(作図面 XY)は絶対 (10, 20, 0) になる', () => {
    const outcome = parseCommandLine('10,20', context({ plane: WORK_PLANES.xy }));
    expect(outcome.kind).toBe('coordinate');
    if (outcome.kind !== 'coordinate' || outcome.value.mode !== 'absolute') {
      throw new Error('絶対座標になっていない');
    }
    expect(outcome.value.x.value).toBeCloseTo(10, 9);
    expect(outcome.value.y.value).toBeCloseTo(20, 9);
    expect(outcome.value.z.value).toBeCloseTo(0, 9);
  });

  it('10,20(作図面 XZ)は絶対 (10, 0, 20) になる(XZ の axisV = (0,0,1))', () => {
    const outcome = parseCommandLine('10,20', context({ plane: WORK_PLANES.xz }));
    if (outcome.kind !== 'coordinate' || outcome.value.mode !== 'absolute') {
      throw new Error('絶対座標になっていない');
    }
    expect(outcome.value.x.value).toBeCloseTo(10, 9);
    expect(outcome.value.y.value).toBeCloseTo(0, 9);
    expect(outcome.value.z.value).toBeCloseTo(20, 9);
  });

  it('10,20,5(作図面あり)は値が多すぎるエラーになる(2 軸しかない)', () => {
    const outcome = parseCommandLine('10,20,5', context({ plane: WORK_PLANES.xy }));
    expect(outcome).toEqual({ kind: 'error', message: '値が多すぎます', suggestions: [] });
  });

  it('10,20,5(3D スケッチ)は絶対 (10, 20, 5) になる', () => {
    const outcome = parseCommandLine('10,20,5', context({ plane: null }));
    if (outcome.kind !== 'coordinate' || outcome.value.mode !== 'absolute') {
      throw new Error('絶対座標になっていない');
    }
    expect(outcome.value.x.value).toBeCloseTo(10, 9);
    expect(outcome.value.y.value).toBeCloseTo(20, 9);
    expect(outcome.value.z.value).toBeCloseTo(5, 9);
  });

  it('10,20(3D スケッチ)は z が足りないエラーになる', () => {
    const outcome = parseCommandLine('10,20', context({ plane: null }));
    expect(outcome).toEqual({ kind: 'error', message: '値が足りません', suggestions: [] });
  });

  it('10/2, 3^2 は絶対 (5, 9, 0) になる(式を評価)', () => {
    const outcome = parseCommandLine('10/2, 3^2', context());
    if (outcome.kind !== 'coordinate' || outcome.value.mode !== 'absolute') {
      throw new Error('絶対座標になっていない');
    }
    expect(outcome.value.x.value).toBeCloseTo(5, 9);
    expect(outcome.value.y.value).toBeCloseTo(9, 9);
  });

  it('root(8,3), 5 は絶対 (2, 5, 0) になる(括弧の中の , で分けない)', () => {
    const outcome = parseCommandLine('root(8,3), 5', context());
    if (outcome.kind !== 'coordinate' || outcome.value.mode !== 'absolute') {
      throw new Error('絶対座標になっていない');
    }
    expect(outcome.value.x.value).toBeCloseTo(2, 9);
    expect(outcome.value.y.value).toBeCloseTo(5, 9);
  });

  it('１０，２０(全角)は絶対 (10, 20, 0) になる', () => {
    const outcome = parseCommandLine('１０，２０', context());
    if (outcome.kind !== 'coordinate' || outcome.value.mode !== 'absolute') {
      throw new Error('絶対座標になっていない');
    }
    expect(outcome.value.x.value).toBeCloseTo(10, 9);
    expect(outcome.value.y.value).toBeCloseTo(20, 9);
  });

  it('10, は値が足りないエラーになる(空の成分)', () => {
    const outcome = parseCommandLine('10,', context());
    expect(outcome).toEqual({ kind: 'error', message: '値が足りません', suggestions: [] });
  });

  it('10,,20 はエラーになる(空の成分)', () => {
    const outcome = parseCommandLine('10,,20', context());
    expect(outcome.kind).toBe('error');
  });

  it('10,1/0 は式のエラー(0 で割る)がそのまま出る', () => {
    const outcome = parseCommandLine('10,1/0', context());
    expect(outcome).toEqual({
      kind: 'error',
      message: '0 で割ることはできません。',
      suggestions: [],
    });
  });
});

describe('parseCommandLine: 相対座標', () => {
  it('@5,0 は相対(直前の点を基準に dx=5, dy=0)になる', () => {
    const outcome = parseCommandLine('@5,0', context({ hasPrevious: true }));
    if (outcome.kind !== 'coordinate' || outcome.value.mode !== 'relative') {
      throw new Error('相対座標になっていない');
    }
    expect(outcome.value.base).toEqual({ kind: 'previous' });
    expect(outcome.value.dx.value).toBeCloseTo(5, 9);
    expect(outcome.value.dy.value).toBeCloseTo(0, 9);
    expect(outcome.value.dz.value).toBeCloseTo(0, 9);
  });

  it('@5,0(直前の点なし)はエラーになる', () => {
    const outcome = parseCommandLine('@5,0', context({ hasPrevious: false }));
    expect(outcome).toEqual({
      kind: 'error',
      message: '直前の点がありません',
      suggestions: [],
    });
  });

  it('＠５，０(全角)は相対 dx=5, dy=0 になる', () => {
    const outcome = parseCommandLine('＠５，０', context({ hasPrevious: true }));
    if (outcome.kind !== 'coordinate' || outcome.value.mode !== 'relative') {
      throw new Error('相対座標になっていない');
    }
    expect(outcome.value.dx.value).toBeCloseTo(5, 9);
    expect(outcome.value.dy.value).toBeCloseTo(0, 9);
  });

  it('@板厚*2,0(板厚=3)は相対 dx=6 になる(変数表を使う)', () => {
    const variables = new Map([['板厚', 3]]);
    const outcome = parseCommandLine('@板厚*2,0', context({ variables }));
    if (outcome.kind !== 'coordinate' || outcome.value.mode !== 'relative') {
      throw new Error('相対座標になっていない');
    }
    expect(outcome.value.dx.value).toBeCloseTo(6, 9);
    expect(outcome.value.dy.value).toBeCloseTo(0, 9);
  });

  it('@1,2,3(3D スケッチ)は相対 dx=1,dy=2,dz=3 になる', () => {
    const outcome = parseCommandLine('@1,2,3', context({ plane: null, hasPrevious: true }));
    if (outcome.kind !== 'coordinate' || outcome.value.mode !== 'relative') {
      throw new Error('相対座標になっていない');
    }
    expect(outcome.value.dx.value).toBeCloseTo(1, 9);
    expect(outcome.value.dy.value).toBeCloseTo(2, 9);
    expect(outcome.value.dz.value).toBeCloseTo(3, 9);
  });

  it('@1,2,3(作図面あり)は値が多すぎるエラーになる', () => {
    const outcome = parseCommandLine('@1,2,3', context({ plane: WORK_PLANES.xy, hasPrevious: true }));
    expect(outcome).toEqual({ kind: 'error', message: '値が多すぎます', suggestions: [] });
  });

  it('@x*2,0(x は未定義)は式のエラーがそのまま出る', () => {
    const outcome = parseCommandLine('@x*2,0', context({ hasPrevious: true }));
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.message).toContain('決まっていない名前です');
    }
  });
});

describe('parseCommandLine: 極座標', () => {
  it('@10<45 は距離 10・角度 45・仰角 0 の極座標になる', () => {
    const outcome = parseCommandLine('@10<45', context({ hasPrevious: true }));
    if (outcome.kind !== 'coordinate' || outcome.value.mode !== 'polar') {
      throw new Error('極座標になっていない');
    }
    expect(outcome.value.base).toEqual({ kind: 'previous' });
    expect(outcome.value.distance.value).toBeCloseTo(10, 9);
    expect(outcome.value.azimuth.value).toBeCloseTo(45, 9);
    expect(outcome.value.elevation.value).toBeCloseTo(0, 9);
  });

  it('自分で計算した検算: @10<45 を実際に解決すると (7.0710678, 7.0710678) 相当になる', () => {
    const offset = polarOffset(WORK_PLANES.xy, 10, 45, 0);
    const resolved = addVec3([0, 0, 0], offset);
    expect(resolved[0]).toBeCloseTo(7.0710678, 6);
    expect(resolved[1]).toBeCloseTo(7.0710678, 6);
    expect(resolved[2]).toBeCloseTo(0, 9);
  });

  it('@10<45+15 は角度 60 になる(角度も式、括弧の外の最初の < で分ける)', () => {
    const outcome = parseCommandLine('@10<45+15', context({ hasPrevious: true }));
    if (outcome.kind !== 'coordinate' || outcome.value.mode !== 'polar') {
      throw new Error('極座標になっていない');
    }
    expect(outcome.value.azimuth.value).toBeCloseTo(60, 9);
  });

  it('@10<-45 は角度 -45 になる(< の後ろの - は符号)', () => {
    const outcome = parseCommandLine('@10<-45', context({ hasPrevious: true }));
    if (outcome.kind !== 'coordinate' || outcome.value.mode !== 'polar') {
      throw new Error('極座標になっていない');
    }
    expect(outcome.value.azimuth.value).toBeCloseTo(-45, 9);
  });

  it('<45 は距離が無いエラーになる', () => {
    const outcome = parseCommandLine('<45', context());
    expect(outcome).toEqual({
      kind: 'error',
      message: '距離を先に打ってください',
      suggestions: [],
    });
  });

  it('10<45(@ が無い)は @ が要るエラーになる', () => {
    const outcome = parseCommandLine('10<45', context());
    expect(outcome).toEqual({
      kind: 'error',
      message: '極座標を書くときは、先頭に @ を付けてください。',
      suggestions: [],
    });
  });

  it('@10<(角度が無い)はエラーになる', () => {
    const outcome = parseCommandLine('@10<', context({ hasPrevious: true }));
    expect(outcome).toEqual({
      kind: 'error',
      message: '角度を打ってください。',
      suggestions: [],
    });
  });

  it('@10<45(3D スケッチ)は極座標が使えないエラーになる', () => {
    const outcome = parseCommandLine('@10<45', context({ plane: null, hasPrevious: true }));
    expect(outcome).toEqual({
      kind: 'error',
      message: '3D スケッチでは角度と距離での指定は使えません。座標かずれで指定してください。',
      suggestions: [],
    });
  });
});

describe('parseCommandLine: 名前付きの欄', () => {
  it('r=5 は fieldKey: radius, source: 5 になる', () => {
    expect(parseCommandLine('r=5', context())).toEqual({
      kind: 'field',
      fieldKey: 'radius',
      source: '5',
    });
  });

  it('d=20 は fieldKey: diameter になる', () => {
    expect(parseCommandLine('d=20', context())).toEqual({
      kind: 'field',
      fieldKey: 'diameter',
      source: '20',
    });
  });

  it('a=30 は fieldKey: angle になる', () => {
    expect(parseCommandLine('a=30', context())).toEqual({
      kind: 'field',
      fieldKey: 'angle',
      source: '30',
    });
  });

  it('l=100 は fieldKey: length になる', () => {
    expect(parseCommandLine('l=100', context())).toEqual({
      kind: 'field',
      fieldKey: 'length',
      source: '100',
    });
  });

  it('n=6 は fieldKey: count になる(要件の例 n=6 への対応)', () => {
    expect(parseCommandLine('n=6', context())).toEqual({
      kind: 'field',
      fieldKey: 'count',
      source: '6',
    });
  });

  it('R=5(大文字)は fieldKey: radius になる(区別しない)', () => {
    expect(parseCommandLine('R=5', context())).toEqual({
      kind: 'field',
      fieldKey: 'radius',
      source: '5',
    });
  });

  it('未知の欄名(width=10)はそのまま fieldKey: width になる(汎用の欄名=値)', () => {
    expect(parseCommandLine('width=10', context())).toEqual({
      kind: 'field',
      fieldKey: 'width',
      source: '10',
    });
  });

  it('r=(値が無い)はエラーになる', () => {
    expect(parseCommandLine('r=', context())).toEqual({
      kind: 'error',
      message: '値がありません。',
      suggestions: [],
    });
  });
});

describe('parseCommandLine: 確定と誤り', () => {
  it('空文字は commit になる(空の Enter)', () => {
    expect(parseCommandLine('', context())).toEqual({ kind: 'commit' });
  });

  it('空白だけも commit になる', () => {
    expect(parseCommandLine('   ', context())).toEqual({ kind: 'commit' });
  });

  it('XYZ はそのような道具はありませんエラーになる', () => {
    const outcome = parseCommandLine('XYZ', context());
    expect(outcome).toEqual({
      kind: 'error',
      message: 'そのような道具はありません',
      suggestions: [],
    });
  });

  it('LL はエラーになり、候補に l(線分)を含む(前方一致)', () => {
    const outcome = parseCommandLine('LL', context());
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.suggestions).toContain('l');
    }
  });
});

describe('suggestCommands', () => {
  it("'c' は円が1件目、最大5件", () => {
    const result = suggestCommands('c');
    expect(result.length).toBeLessThanOrEqual(5);
    expect(result[0]?.tool).toBe('circle');
  });

  it('空文字は候補を返さない', () => {
    expect(suggestCommands('')).toEqual([]);
  });

  it('limit を渡すとその件数までに絞られる', () => {
    expect(suggestCommands('c', 1).length).toBe(1);
  });
});
