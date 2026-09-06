/**
 * 書き出しのパネルの判断(P6 §0.a-0.20、タスク32)。
 *
 * 画面そのものは描かず、**押す前に決まること**だけを固定する。パネルの見せ方
 * (どの欄が出るか)は `exchangeFile.ts` の `exportPanelShape` の検査が持っているので、
 * ここは「選んでいる立体をどう数えるか」だけを見る。
 */

import { describe, expect, it } from 'vitest';

import { selectedBodyFeatureIds } from './ExchangePanel.js';

describe('選んでいる立体の数え方(FR-427)', () => {
  it('立体そのものを選んでいれば、その id がそのまま出る', () => {
    expect([...selectedBodyFeatureIds(['extrude-1', 'revolve-2'])])
      .toEqual(['extrude-1', 'revolve-2']);
  });

  it('同じ立体の面を何枚選んでも、立体は 1 つに数える', () => {
    expect([...selectedBodyFeatureIds(['extrude-1#face-3', 'extrude-1#face-4'])])
      .toEqual(['extrude-1']);
  });

  it('面と立体そのものが混ざっても重複しない', () => {
    expect([...selectedBodyFeatureIds(['extrude-1', 'extrude-1#edge-2', 'hole-3#face-1'])])
      .toEqual(['extrude-1', 'hole-3']);
  });

  it('何も選んでいなければ空', () => {
    expect([...selectedBodyFeatureIds([])]).toEqual([]);
  });
});
