import { describe, expect, it } from 'vitest';
import type { SemanticTextMetrics } from '../render/types.js';
import { gdtDatumGeometry } from './datumGeometry.js';
import { gdtFrameGeometry, type GdtDisplayRow } from './frameGeometry.js';
import { gdtSymbolGeometry } from './symbolGeometry.js';
import type { ToleranceCharacteristic } from './types.js';

const measure = (text: string, height: number): SemanticTextMetrics => ({ fontId: 'fixture', sizeMm: height,
  advanceMm: text.length * height * 0.6, inkBounds: { left: -0.2, right: text.length * height * 0.6 - 0.3, bottom: -height * 0.2, top: height * 0.8 } });
const flatness: GdtDisplayRow = { characteristic: 'flatness', value: [{ kind: 'text', text: '0.05' }], datums: [] };
const perpendicularity: GdtDisplayRow = { characteristic: 'perpendicularity', value: [{ kind: 'text', text: '0.02' }], datums: [[{ kind: 'text', text: 'A' }]] };
const position: GdtDisplayRow = { characteristic: 'position', value: [{ kind: 'symbol', symbol: 'diameter' }, { kind: 'text', text: '0.1' },
  { kind: 'symbol', symbol: 'maximum' }], datums: ['A', 'B', 'C'].map((text) => [{ kind: 'text', text }]) };

describe('幾何公差の記号・枠・データムは紙上mmのベクトル', () => {
  it('軸の指示線の最後はサイズ寸法線に沿い、データム三角の底辺も同じ線へ合わせる', () => {
    const geometry = gdtFrameGeometry({ rows: [position], position: [30, 40], target: [0, 0], targetDirection: [0, 1], height: 3.5, measure });
    const last = geometry?.curves.at(-1); expect(last?.kind).toBe('segment');
    if (last?.kind !== 'segment') throw new Error('指示線なし');
    expect(last.from[0]).toBe(0); expect(last.to).toEqual([0, 0]); expect(last.from[1]).toBeGreaterThan(0);
    const datum = gdtDatumGeometry({ label: 'A', position: [30, 40], target: [0, 0], targetDirection: [0, 1], height: 3.5, measure });
    expect(datum?.fills[0].subpaths[0].commands[1]).toMatchObject({ kind: 'L', to: [0, 3.5 * 0.7 * 0.58] });
    expect(datum?.fills[0].subpaths[0].commands[2]).toMatchObject({ kind: 'L', to: [0, -3.5 * 0.7 * 0.58] });
  });
  const symbols: readonly ToleranceCharacteristic[] = ['straightness', 'flatness', 'roundness', 'cylindricity', 'lineProfile', 'surfaceProfile',
    'parallelism', 'perpendicularity', 'angularity', 'position', 'coaxiality', 'symmetry', 'circularRunout', 'totalRunout'];
  it.each(symbols)('%sを字体なしで作り、平行移動で形と大きさを変えない', (symbol) => {
    const first = gdtSymbolGeometry(symbol, 3.5), moved = gdtSymbolGeometry(symbol, 3.5, [100, 200]);
    expect(first).not.toBeNull(); expect(moved).not.toBeNull();
    expect((first?.curves.length ?? 0) + (first?.fills.length ?? 0)).toBeGreaterThan(0);
    expect(moved?.bounds.right).toBeCloseTo((first?.bounds.right ?? 0) + 100, 12);
    expect(moved?.bounds.top).toBeCloseTo((first?.bounds.top ?? 0) + 200, 12);
    expect(moved?.curves.map((curve) => curve.kind)).toEqual(first?.curves.map((curve) => curve.kind));
  });
  it('14記号は同一のダミー形状ではなく、全て異なる幾何を持つ', () => {
    expect(new Set(symbols.map((symbol) => JSON.stringify(gdtSymbolGeometry(symbol, 3.5)))).size).toBe(14);
  });
  it.each([flatness, perpendicularity, position])('$characteristicの第1欄を7×7mmにし、紙面位置を変えても幅は同じ', (row) => {
    const original = gdtFrameGeometry({ rows: [row], position: [10, 20], height: 3.5, measure });
    const moved = gdtFrameGeometry({ rows: [row], position: [100, 200], height: 3.5, measure });
    expect(original).not.toBeNull(); expect(original?.compartmentWidths[0][0]).toBe(7);
    expect(original?.bounds.top).toBe(27); expect(moved?.rowWidths).toEqual(original?.rowWidths);
    expect(original?.texts.every((text) => text.sizeMm === 3.5)).toBe(true);
  });
  it('数値とデータムの実輪郭から左右1mm以上空け、囲みMを文字へ代用しない', () => {
    const geometry = gdtFrameGeometry({ rows: [position], position: [10, 20], height: 3.5, measure });
    expect(geometry).not.toBeNull(); if (geometry === null) return;
    let left = 10;
    for (const width of geometry.compartmentWidths[0]) {
      for (const text of geometry.texts.filter((text) => text.position[0] >= left && text.position[0] < left + width)) {
        const ink = measure(text.text, text.sizeMm).inkBounds;
        expect(text.position[0] + ink.left - left).toBeGreaterThanOrEqual(1 - 1e-10);
        expect(left + width - text.position[0] - ink.right).toBeGreaterThanOrEqual(1 - 1e-10);
      }
      left += width;
    }
    expect(geometry.texts.map((text) => text.text)).toEqual(['0.1', 'A', 'B', 'C']);
    expect(geometry.curves.some((curve) => curve.kind === 'arc')).toBe(true);
  });
  it('段ごとの欄を保持し、共通A-Bは一つのデータム欄として作る', () => {
    const common: GdtDisplayRow = { ...perpendicularity, datums: [[{ kind: 'text', text: 'A' }, { kind: 'text', text: '-' }, { kind: 'text', text: 'B' }]] };
    const geometry = gdtFrameGeometry({ rows: [position, common], position: [0, 0], height: 3.5, measure, target: [-20, 10] });
    expect(geometry?.compartmentWidths.map((row) => row.length)).toEqual([5, 3]); expect(geometry?.bounds.top).toBe(14);
    expect(geometry?.fills.length).toBeGreaterThan(0);
    expect(geometry?.texts.filter((text) => ['A', '-', 'B'].includes(text.text)).length).toBe(5);
  });
  it('欠字・字体未読込・非有限の寸法では製作用の枠を作らない', () => {
    expect(gdtFrameGeometry({ rows: [flatness], position: [0, 0], height: 3.5, measure: () => null })).toBeNull();
    expect(gdtFrameGeometry({ rows: [flatness], position: [0, 0], height: NaN, measure })).toBeNull();
    expect(gdtFrameGeometry({ rows: [], position: [0, 0], height: 3.5, measure })).toBeNull();
    expect(gdtSymbolGeometry('maximum', Infinity)).toBeNull();
  });
  it('データム枠は文字輪郭を中央へ置き、対象位置に塗り三角を付ける', () => {
    const geometry = gdtDatumGeometry({ label: 'A', position: [10, 20], target: [13.5, 0], height: 3.5, measure });
    expect(geometry?.bounds).toEqual({ left: 10, bottom: 20, right: 17, top: 27 });
    const commands = geometry?.fills[0].subpaths[0].commands;
    expect(commands?.[0]).toEqual({ kind: 'M', to: [13.5, 3.5 * 0.7] });
    const base = commands?.slice(1, 3).flatMap((command) => command.kind === 'L' ? [command.to] : []) ?? [];
    expect(base).toHaveLength(2);
    expect(base[0][1]).toBe(0); expect(base[1][1]).toBe(0); expect((base[0][0] + base[1][0]) / 2).toBe(13.5);
    expect(geometry?.texts[0].text).toBe('A');
    expect(gdtDatumGeometry({ label: 'AA', position: [10, 20], target: [13.5, 0], height: 3.5, measure })).toBeNull();
  });
});
