import { describe, expect, it } from 'vitest';

import type { BomRow } from '@pointercad/model';

import { bomSelectionIds, bomTableRows, formatBomMass } from './bomTableRows.js';

function row(extra: Partial<BomRow> = {}): BomRow {
  return {
    rowKey: 'bom:root:part-a:steel',
    number: 1,
    name: 'ブラケット',
    quantity: 2,
    materialId: 'steel',
    materialName: 'steel',
    massEach: 62.8,
    massTotal: 125.6,
    componentIds: ['component-1', 'component-2'],
    occurrencePath: ['component-1'],
    occurrencePaths: [['component-1'], ['component-2']],
    ...extra,
  };
}

describe('formatBomMass', () => {
  it('gを小数2桁で表示する', () => {
    expect(formatBomMass(62.8)).toBe('62.80 g');
  });

  it('1000g以上をkgへ切り替える', () => {
    expect(formatBomMass(1000)).toBe('1.00 kg');
    expect(formatBomMass(1256)).toBe('1.26 kg');
  });

  it('負の大きな値も絶対値1000gを境にkgへ切り替える', () => {
    expect(formatBomMass(-1500)).toBe('-1.50 kg');
  });

  it('nullと有限でない値は空欄にする', () => {
    expect(formatBomMass(null)).toBe('');
    expect(formatBomMass(Number.NaN)).toBe('');
  });

  it('負のゼロを0.00gと表示する', () => {
    expect(formatBomMass(-0)).toBe('0.00 g');
  });
});

describe('bomSelectionIds', () => {
  it('ルートの全出現を選択IDにする', () => {
    expect(bomSelectionIds(row())).toEqual(['component-1', 'component-2']);
  });

  it('入れ子では画面に存在する最上位インスタンスを重複なく返す', () => {
    expect(bomSelectionIds(row({
      occurrencePaths: [['sub-1', 'part-1'], ['sub-1', 'part-2'], ['sub-2', 'part-1']],
    }))).toEqual(['sub-1', 'sub-2']);
  });
});

describe('bomTableRows', () => {
  it('modelの安定したrowKeyを表のkeyに使う', () => {
    expect(bomTableRows([row()], [])[0]?.key).toBe('bom:root:part-a:steel');
  });

  it('番号・名前・数量・材質・合計質量を各セルへ変換する', () => {
    expect(bomTableRows([row()], [])[0]?.cells).toEqual({
      number: '1', name: 'ブラケット', quantity: '2', material: 'steel', mass: '125.60 g',
    });
  });

  it('材料の表示名をUIの翻訳関数から受け取る', () => {
    const tableRow = bomTableRows([row()], [], (id) => id === 'steel' ? '鋼(SS400)' : id)[0];
    expect(tableRow?.cells.material).toBe('鋼(SS400)');
  });

  it('質量nullを文字列nullやNaNにせず空欄にする', () => {
    const tableRow = bomTableRows([row({ massEach: null, massTotal: null })], [])[0];
    expect(tableRow?.cells.mass).toBe('');
  });

  it('対応部品のどれかが選択中なら行を選択状態にする', () => {
    expect(bomTableRows([row()], ['component-2'])[0]?.active).toBe(true);
    expect(bomTableRows([row()], ['component-9'])[0]?.active).toBe(false);
  });

  it('入力行と選択を変更せず同じ結果を返す', () => {
    const source = [row()];
    const selection = ['component-1'];
    expect(bomTableRows(source, selection)).toEqual(bomTableRows(source, selection));
    expect(source[0]?.componentIds).toEqual(['component-1', 'component-2']);
    expect(selection).toEqual(['component-1']);
  });
});
