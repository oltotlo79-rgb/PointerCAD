import { describe, expect, it } from 'vitest';
import type { TreeRow } from '../solid/solidSummary.js';
import type { AssemblyTreeRow } from './assemblyTreeRows.js';
import { assemblyNameSearchEntries, partNameSearchEntries, searchNamedEntries, type NameSearchEntry } from './nameSearch.js';

const row = (name: string): TreeRow => ({ id: 'point-1', name, kind: 'point', kindLabelKey: 'nameSearch.sketch',
  hasError: false, errorMessage: null, suppressed: false, consumed: false, hidden: false });

describe('名前検索の結果を実際の所属と選択先へ結び付ける', () => {
  it('別スケッチの同名・同IDをまとめず、それぞれの所属を保持する', () => {
    const entries = partNameSearchEntries([], [
      { sketchId: 'first', name: '正面', active: true, inUse: false, rows: [row('基準点')] },
      { sketchId: 'second', name: '側面', active: false, inUse: false, rows: [row('基準点')] },
    ]);
    const matches = searchNamedEntries(entries, '基準点');
    expect(matches.map(item => [item.entry.selectionId, item.entry.sketchId])).toEqual([['point-1', 'first'], ['point-1', 'second']]);
    expect(new Set(matches.map(item => item.entry.key)).size).toBe(2);
    expect(searchNamedEntries(entries, '側面 基準点').map(item => item.entry.sketchId)).toEqual(['second']);
    expect(searchNamedEntries(entries, '正面')[0].entry.selectionId).toBeNull();
  });

  it('非表示・抑制・統合された項目を省かず、状態と元の選択先を返す', () => {
    const entries = partNameSearchEntries([{ key: 'solid', titleKey: 'nameSearch.sketch', rows: [
      { ...row('箱'), id: 'solid-1', hidden: true, suppressed: true, consumed: true },
    ] }], []);
    const result = searchNamedEntries(entries, '箱');
    expect(result).toHaveLength(1);
    expect(result[0].entry.badges).toEqual(['nameSearch.hidden', 'nameSearch.suppressed', 'nameSearch.consumed']);
    expect(result[0].entry.selectionId).toBe('solid-1');
  });

  it('入れ子部品の同名を親の経路と選択IDで区別する', () => {
    const component = (id: string, name: string, children: readonly AssemblyTreeRow[] = []): AssemblyTreeRow => ({
      key: `component:${id}`, id, name, kind: 'part', kindLabelKey: 'nameSearch.sketch',
      badges: ['hidden'], errorMessage: null, dimmed: false, children,
    });
    const entries = assemblyNameSearchEntries([{ key: 'component', titleKey: 'nameSearch.sketch', emptyKey: 'nameSearch.empty', rows: [
      component('left', '左側', [component('left/bolt', 'ボルト')]),
      component('right', '右側', [component('right/bolt', 'ボルト')]),
    ] }]);
    const result = searchNamedEntries(entries, '右側 ぼると');
    expect(result).toHaveLength(1); expect(result[0].entry.selectionId).toBe('right/bolt');
    expect(result[0].entry.badges).toContain('nameSearch.hidden');
    expect(searchNamedEntries(entries, 'ボルト').map(item => item.ordinal)).toEqual([2, 4]);
  });

  it('空・不存在・長い入力でも名前や配列を変えず、200要素と50部品を100ms以内で検索する', () => {
    const entries: readonly NameSearchEntry[] = Object.freeze(Array.from({ length: 250 }, (_, index) => Object.freeze({
      key: String(index), name: `${index < 200 ? '要素' : '部品'} ${index}`, context: 'ＡＢＣ ボルト',
      selectionId: `id-${index}`, badges: [],
    })));
    const started = performance.now(), matches = searchNamedEntries(entries, 'abc ぼると');
    expect(performance.now() - started).toBeLessThan(100);
    expect(matches).toHaveLength(250);
    expect(searchNamedEntries(entries, '不存在')).toEqual([]);
    expect(searchNamedEntries(entries, '不存在'.repeat(512))).toEqual([]);
    expect(searchNamedEntries(entries, '  ')).toEqual([]);
    expect(entries[0].name).toBe('要素 0');
  });
});
