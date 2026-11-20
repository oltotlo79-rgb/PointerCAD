import { WORK_PLANES } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import type { CommandLineContext } from './commandLine.js';
import { parseCommandTable } from './commandLineTable.js';

const xy: CommandLineContext = { plane: WORK_PLANES.xy, variables: new Map([['幅', 4]]), hasPrevious: false };
const free = { ...xy, plane: null };

function positions(source: string, context = xy): number[][] {
  return Array.from(parseCommandTable(source, context), (result) => {
    if ('reason' in result) throw new Error(result.reason);
    const { x, y, z } = result.coordinate;
    return [x.value, y.value, z.value];
  });
}

describe('測った座標の表', () => {
  it('先頭の見出し・空行・CRLF を飛ばし、深さ 0 のタブ・コンマ・空白で分ける', () => {
    expect(positions('\r\n測定-X [mm],測定-Y [mm]\r\n  \r\n１， ２\r\n３\t４\r\n５   ６\r\n')).toEqual([
      [1, 2, 0], [3, 4, 0], [5, 6, 0],
    ]);
  });

  it('全角の括弧と演算子、関数の引数のコンマと空白、変数表を使う', () => {
    expect(positions('root（８， ３）\t（幅 ＋ １）\n幅＊２，－１')).toEqual([
      [2, 5, 0], [8, -1, 0],
    ]);
  });

  it('作図面の 2 列を世界座標に移し、3D の 3 列は式のまま保存できる', () => {
    expect(positions('12,5', { ...xy, plane: WORK_PLANES.yz })).toEqual([[0, 12, 5]]);
    const first = Array.from(parseCommandTable('幅*2,3,4', free));
    expect(first).toMatchObject([{ row: 1, coordinate: {
      mode: 'absolute', x: { source: '幅*2', value: 8 }, y: { value: 3 }, z: { value: 4 },
    } }]);
  });

  it('定義された変数だけの先頭行も座標として読む', () => {
    expect(positions('幅,幅\n0,1')).toEqual([[4, 4, 0], [0, 1, 0]]);
  });

  it.each([
    ['0,1,2\n1,2', xy, 1], ['0,1\n1,2,3', free, 1], ['x,y\n\n0,1\n未定義,2\n1,?', xy, 4],
    ['0,未定義\n1,2', xy, 1], ['1,2,\n3,4', xy, 1], ['0,1\nx,y', xy, 2],
    ['1/0,4\n1,2', xy, 1], ['@1,2\n3,4', xy, 1], ['\n \n', xy, 1], ['\nX,Y\n', xy, 2],
  ] as const)('最初に読めない元の行を知らせる (%s)', (text, context, row) => {
    const results = Array.from(parseCommandTable(text, context));
    const last = results.at(-1);
    if (last === undefined || !('reason' in last)) throw new Error('断りの理由がありません');
    expect(last.row).toBe(row);
    expect(last.reason.length).toBeGreaterThan(0);
    expect(results.filter((entry) => 'reason' in entry)).toHaveLength(1);
  });

  it('見出しと空行を除いて 1000 行を受け、1001 個目の元の行番号で止まる', () => {
    const full = 'x,y\n\n' + Array<string>(1000).fill('1,2').join('\n');
    expect(positions(full)).toHaveLength(1000);
    const result = Array.from(parseCommandTable(full + '\n\n3,4\n5,6', xy));
    expect(result).toHaveLength(1001);
    expect(result.at(-1)).toEqual({ row: 1004, reason: '値が多すぎます' });
  });
});
