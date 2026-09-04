import { describe, expect, it } from 'vitest';

import type { SubShapeRef } from '../geometry/subShapeRef.js';
import {
  assignAppearance,
  bodyAppearanceOf,
  clearAppearance,
  emptyAppearanceTable,
  isSameAppearanceTarget,
  nextAppearanceId,
  pruneAppearance,
  removeAppearance,
} from './appearanceTable.js';
import { appearanceFromPreset, DEFAULT_APPEARANCE } from './materialPresets.js';
import type { AppearanceTable, AppearanceTarget } from './types.js';

/** 面 1 枚の参照(P3 §2.2.2 の指紋の形。計画書の subShapeRef.test.ts と同じ流儀)。 */
function faceRef(bodyFeatureId: string, index: number): SubShapeRef {
  return {
    bodyFeatureId,
    index,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'plane',
      area: 1200,
      position: [20, 15, 10],
      axis: [0, 0, 1],
      radius: null,
    },
  };
}

function bodyTarget(bodyFeatureId: string): AppearanceTarget {
  return { kind: 'body', bodyFeatureId };
}

function faceTarget(bodyFeatureId: string, index: number): AppearanceTarget {
  return { kind: 'face', ref: faceRef(bodyFeatureId, index) };
}

describe('emptyAppearanceTable', () => {
  it('空の表を返す', () => {
    expect(emptyAppearanceTable().entries).toEqual([]);
  });
});

describe('isSameAppearanceTarget', () => {
  it('同じボディの立体割り当ては同一', () => {
    expect(isSameAppearanceTarget(bodyTarget('extrude-1'), bodyTarget('extrude-1'))).toBe(true);
  });

  it('別のボディの立体割り当ては別対象', () => {
    expect(isSameAppearanceTarget(bodyTarget('extrude-1'), bodyTarget('extrude-2'))).toBe(false);
  });

  it('同じボディ・同じ通し番号の面は同一', () => {
    expect(isSameAppearanceTarget(faceTarget('extrude-1', 0), faceTarget('extrude-1', 0))).toBe(true);
  });

  it('種類が違えば別対象(立体と面)', () => {
    expect(isSameAppearanceTarget(bodyTarget('extrude-1'), faceTarget('extrude-1', 0))).toBe(false);
  });
});

describe('assignAppearance / nextAppearanceId', () => {
  it('新規の対象へ割り当てると1件増え、id は appearance-1', () => {
    const table = assignAppearance(emptyAppearanceTable(), bodyTarget('extrude-1'), DEFAULT_APPEARANCE);
    expect(table.entries.length).toBe(1);
    expect(table.entries[0]?.id).toBe('appearance-1');
  });

  it('同じ面へ2回割り当てると差し替わり、件数は1のまま', () => {
    const target = faceTarget('extrude-1', 0);
    const first = assignAppearance(emptyAppearanceTable(), target, DEFAULT_APPEARANCE);
    const glass = appearanceFromPreset('glass');
    const second = assignAppearance(first, target, glass);
    expect(second.entries.length).toBe(1);
    expect(second.entries[0]?.appearance.preset).toBe('glass');
    expect(second.entries[0]?.id).toBe(first.entries[0]?.id);
  });

  it('別の面へ2回割り当てると2件になる', () => {
    const first = assignAppearance(emptyAppearanceTable(), faceTarget('extrude-1', 0), DEFAULT_APPEARANCE);
    const second = assignAppearance(first, faceTarget('extrude-1', 1), DEFAULT_APPEARANCE);
    expect(second.entries.length).toBe(2);
  });

  it('採番は既存の最大連番+1で、削除しても重複しない', () => {
    let table = emptyAppearanceTable();
    table = assignAppearance(table, bodyTarget('a'), DEFAULT_APPEARANCE);
    table = assignAppearance(table, bodyTarget('b'), DEFAULT_APPEARANCE);
    table = removeAppearance(table, 'appearance-1');
    expect(nextAppearanceId(table)).toBe('appearance-3');
  });
});

describe('removeAppearance', () => {
  it('存在しない id を渡すと同一参照のまま返る(無駄な作り直しをしない)', () => {
    const table = assignAppearance(emptyAppearanceTable(), bodyTarget('extrude-1'), DEFAULT_APPEARANCE);
    expect(removeAppearance(table, 'appearance-999')).toBe(table);
  });

  it('存在する id を外すと件数が減る', () => {
    const table = assignAppearance(emptyAppearanceTable(), bodyTarget('extrude-1'), DEFAULT_APPEARANCE);
    const removed = removeAppearance(table, 'appearance-1');
    expect(removed.entries.length).toBe(0);
  });
});

describe('clearAppearance', () => {
  it('すべて既定に戻す(FR-1110)', () => {
    let table = emptyAppearanceTable();
    table = assignAppearance(table, bodyTarget('a'), DEFAULT_APPEARANCE);
    table = assignAppearance(table, bodyTarget('b'), DEFAULT_APPEARANCE);
    expect(clearAppearance(table).entries.length).toBe(0);
  });

  it('すでに空なら同一参照のまま返る', () => {
    const table = emptyAppearanceTable();
    expect(clearAppearance(table)).toBe(table);
  });
});

describe('bodyAppearanceOf', () => {
  it('割り当てられたボディの外観を引ける', () => {
    const glass = appearanceFromPreset('glass');
    const table = assignAppearance(emptyAppearanceTable(), bodyTarget('extrude-1'), glass);
    expect(bodyAppearanceOf(table, 'extrude-1')?.preset).toBe('glass');
  });

  it('割り当てが無ければ null', () => {
    expect(bodyAppearanceOf(emptyAppearanceTable(), 'extrude-1')).toBeNull();
  });

  it('面の割り当てはボディの割り当てとして拾わない', () => {
    const table = assignAppearance(emptyAppearanceTable(), faceTarget('extrude-1', 0), DEFAULT_APPEARANCE);
    expect(bodyAppearanceOf(table, 'extrude-1')).toBeNull();
  });
});

describe('pruneAppearance', () => {
  function tableWithBodyAndFace(): AppearanceTable {
    let table = emptyAppearanceTable();
    table = assignAppearance(table, bodyTarget('extrude-1'), DEFAULT_APPEARANCE);
    table = assignAppearance(table, faceTarget('extrude-2', 0), DEFAULT_APPEARANCE);
    return table;
  }

  it('生きているボディだけの割り当てを残す(立体・面とも)', () => {
    const table = tableWithBodyAndFace();
    const pruned = pruneAppearance(table, ['extrude-1']);
    expect(pruned.entries.length).toBe(1);
    expect(pruned.entries[0]?.target.kind).toBe('body');
  });

  it('すべて生きていれば同一参照のまま返る', () => {
    const table = tableWithBodyAndFace();
    expect(pruneAppearance(table, ['extrude-1', 'extrude-2'])).toBe(table);
  });

  it('すべて消えたボディなら空になる', () => {
    const table = tableWithBodyAndFace();
    expect(pruneAppearance(table, []).entries.length).toBe(0);
  });
});
