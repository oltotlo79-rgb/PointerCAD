import { describe, expect, it } from 'vitest';
import type { AssemblyInterferencePair, AssemblyInterferenceReport } from '@pointercad/model';
import {
  formatInterferenceVolume, interferencePairKey, interferenceRows, selectedInterferencePair,
} from './interferenceView.js';

function pair(a: string, b: string, volume: number): AssemblyInterferencePair {
  return {
    aComponentId: a, bComponentId: b, volume,
    mesh: { positions: new Float32Array(), normals: new Float32Array(),
      indices: new Uint32Array(), triangleCount: 0 },
  };
}

function report(pairs: readonly AssemblyInterferencePair[]): Pick<AssemblyInterferenceReport, 'pairs'> {
  return { pairs };
}

describe('P7-26 干渉一覧', () => {
  it('体積の大きい順に並べる', () => {
    expect(interferenceRows(report([pair('a', 'b', 2), pair('c', 'd', 9)]))
      .map((row) => row.pair.volume)).toEqual([9, 2]);
  });

  it('同じ体積は接頭辞つきの安定キー順に並べる', () => {
    expect(interferenceRows(report([pair('z', 'a', 3), pair('b', 'a', 3)]))
      .map((row) => row.key)).toEqual(['interference:a:b', 'interference:a:z']);
  });

  it('組の向きが逆でも同じキーになる', () => {
    expect(interferencePairKey('component-9', 'component-2')).toBe('interference:component-2:component-9');
    expect(interferencePairKey('component-2', 'component-9')).toBe('interference:component-2:component-9');
  });

  it.each([
    [2000, '2000.000 mm³'], [1 / 3, '0.333 mm³'], [-0, '0.000 mm³'],
  ])('体積 %s を小数3桁とmm³で表示する', (volume, expected) => {
    expect(formatInterferenceVolume(volume)).toBe(expected);
  });

  it('部品名を一覧へ写す', () => {
    expect(interferenceRows(report([pair('a', 'b', 1)]), (id) => `名前:${id}`)[0])
      .toMatchObject({ aName: '名前:a', bName: '名前:b' });
  });

  it('選択キーに対応する組だけを返す', () => {
    const first = pair('a', 'b', 1); const second = pair('a', 'c', 2);
    expect(selectedInterferencePair(report([first, second]), 'interference:a:c')).toBe(second);
    expect(selectedInterferencePair(report([first]), 'interference:a:x')).toBeNull();
    expect(selectedInterferencePair(null, 'interference:a:b')).toBeNull();
  });
});
