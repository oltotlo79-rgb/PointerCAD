/**
 * 選択フィルタ(FR-112)の純関数の検査
 * (計画書 docs/plans/P6-入出力.md §2.13 の検証表、タスク36、§0.43)。
 *
 * 期待値の導出は §2.13 の表のとおり。「全部入では 1 件も減らない」は既定の振る舞いを
 * P4b までから 1 つも変えないための性質で、**同じ配列がそのまま返る**ことまで固定する
 * (絞り込みを常に通しても配列を作らない = 費用が増えない、NFR-PF-1)。
 */

import { describe, expect, it } from 'vitest';

import { t } from '../i18n/t.js';
import { expectWithinBudget } from '../testUtils/perfBudget.js';
import {
  ALL_SELECTABLE,
  filterPickCandidates,
  isAllSelectable,
  isNoneSelectable,
  isSelectableKind,
  isSelectionFilter,
  SELECTION_FILTER_KINDS,
  SELECTION_KIND_LABEL_KEYS,
  toggleSelectionFilter,
  type PickCandidate,
  type SelectionFilter,
} from './selectionFilter.js';

/** 4 種を 1 件ずつ持つ候補の一覧(絞り込みの結果を種類ごとに数えられる)。 */
const CANDIDATES: readonly PickCandidate[] = [
  { elementId: 'extrude-1#vertex:0', kind: 'vertex' },
  { elementId: 'extrude-1#edge:3', kind: 'edge' },
  { elementId: 'extrude-1#face:5', kind: 'face' },
  { elementId: 'extrude-1', kind: 'body' },
];

/** 1 種類だけを入にしたフィルタ。 */
function onlyKind(kind: PickCandidate['kind']): SelectionFilter {
  return {
    vertex: kind === 'vertex',
    edge: kind === 'edge',
    face: kind === 'face',
    body: kind === 'body',
  };
}

/** 1 コマぶんの予算(60fps、NFR-PF-1。§2.17-8 の「選択フィルタの切替 16ms」)。 */
const FRAME_BUDGET_MS = 16;

describe('selectionFilter の並びと札', () => {
  it('4 種を小さいものから大きいものへ並べる(頂点・辺・面・立体)', () => {
    expect(SELECTION_FILTER_KINDS).toEqual(['vertex', 'edge', 'face', 'body']);
  });

  it('既定は全部入(P4b までと同じ振る舞い)', () => {
    expect(ALL_SELECTABLE).toEqual({ vertex: true, edge: true, face: true, body: true });
    expect(isAllSelectable(ALL_SELECTABLE)).toBe(true);
    expect(isNoneSelectable(ALL_SELECTABLE)).toBe(false);
  });

  it('4 種の札はすべて ja.json にあり、日本語が引ける(NFR-MA-5)', () => {
    for (const kind of SELECTION_FILTER_KINDS) {
      expect(t(SELECTION_KIND_LABEL_KEYS[kind]).length).toBeGreaterThan(0);
    }
    expect(t(SELECTION_KIND_LABEL_KEYS.face)).toBe('面');
    expect(t(SELECTION_KIND_LABEL_KEYS.body)).toBe('立体');
  });
});

describe('filterPickCandidates', () => {
  it('全部入のフィルタでは候補が 1 つも減らず、同じ配列がそのまま返る', () => {
    const filtered = filterPickCandidates(CANDIDATES, ALL_SELECTABLE);
    expect(filtered).toBe(CANDIDATES);
    expect(filtered).toHaveLength(4);
  });

  it('面だけ入にすると、頂点・辺・立体の候補が 0 件になる', () => {
    const filtered = filterPickCandidates(CANDIDATES, onlyKind('face'));
    expect(filtered.map((candidate) => candidate.kind)).toEqual(['face']);
    expect(filtered.filter((candidate) => candidate.kind !== 'face')).toHaveLength(0);
  });

  it('種類を 1 つずつ入にすると、その種類だけが残る(4 通り)', () => {
    for (const kind of SELECTION_FILTER_KINDS) {
      const filtered = filterPickCandidates(CANDIDATES, onlyKind(kind));
      expect(filtered.map((candidate) => candidate.kind)).toEqual([kind]);
    }
  });

  it('全部切のフィルタでは候補が 0 件(何も選べない)', () => {
    const none: SelectionFilter = { vertex: false, edge: false, face: false, body: false };
    expect(filterPickCandidates(CANDIDATES, none)).toHaveLength(0);
    expect(isNoneSelectable(none)).toBe(true);
    // 何も選べないことを画面へ出す文言も ja.json にある(NFR-UX-5)。
    expect(t('statusBar.selectionFilterNone')).toBe('選べるものがありません');
  });

  it('候補が空なら、どのフィルタでも空のまま(同じ配列を返す)', () => {
    const empty: readonly PickCandidate[] = [];
    expect(filterPickCandidates(empty, onlyKind('edge'))).toBe(empty);
  });

  it('並びは変えない(残るものの順序はもとのまま)', () => {
    const filtered = filterPickCandidates(CANDIDATES, {
      vertex: false,
      edge: true,
      face: true,
      body: false,
    });
    expect(filtered.map((candidate) => candidate.elementId)).toEqual([
      'extrude-1#edge:3',
      'extrude-1#face:5',
    ]);
  });

  it('同じ種類が何件あってもすべて残る(1 件だけに絞らない)', () => {
    const faces: readonly PickCandidate[] = [
      { elementId: 'a#face:0', kind: 'face' },
      { elementId: 'a#face:1', kind: 'face' },
      { elementId: 'a#edge:0', kind: 'edge' },
    ];
    expect(filterPickCandidates(faces, onlyKind('face'))).toHaveLength(2);
  });

  it('当たり判定の結果(距離つき)もそのまま通せる(欄を落とさない)', () => {
    const picked = [{ elementId: 'a#edge:2', kind: 'edge', distance: 3.5 } as const];
    const [kept] = filterPickCandidates(picked, ALL_SELECTABLE);
    expect(kept).toEqual({ elementId: 'a#edge:2', kind: 'edge', distance: 3.5 });
  });

  it('切替の所要は 1 コマ(16ms)に収まる(§2.17-8)', () => {
    // 立体 20 個 × 4 種(§1.5 の実測の規模)の候補を、4 種すべての切替ぶん絞り込む。
    const many: PickCandidate[] = [];
    for (let body = 0; body < 20; body += 1) {
      for (const kind of SELECTION_FILTER_KINDS) {
        many.push({ elementId: `extrude-${String(body)}#${kind}`, kind });
      }
    }
    const started = performance.now();
    let filter = ALL_SELECTABLE;
    let total = 0;
    for (const kind of SELECTION_FILTER_KINDS) {
      filter = toggleSelectionFilter(filter, kind);
      total += filterPickCandidates(many, filter).length;
    }
    const elapsed = performance.now() - started;
    // 4 回の切替で残る件数: 60 + 40 + 20 + 0 = 120(1 種類ずつ切っていくため)。
    expect(total).toBe(120);
    console.log(`選択フィルタの切替(候補 80 件 × 4 回): ${elapsed.toFixed(3)} ms`);
    expectWithinBudget(elapsed, FRAME_BUDGET_MS, '選択フィルタの切替');
  });
});

describe('isSelectableKind / toggleSelectionFilter', () => {
  it('種類ごとに入切を引ける', () => {
    const filter = onlyKind('edge');
    expect(isSelectableKind(filter, 'edge')).toBe(true);
    expect(isSelectableKind(filter, 'face')).toBe(false);
  });

  it('ひっくり返すのは指した 1 種類だけ(他の 3 つは変わらない)', () => {
    const next = toggleSelectionFilter(ALL_SELECTABLE, 'vertex');
    expect(next).toEqual({ vertex: false, edge: true, face: true, body: true });
    // もとのフィルタは変わらない(値として扱う)。
    expect(ALL_SELECTABLE.vertex).toBe(true);
  });

  it('2 回ひっくり返すと元に戻る', () => {
    const back = toggleSelectionFilter(toggleSelectionFilter(ALL_SELECTABLE, 'face'), 'face');
    expect(back).toEqual(ALL_SELECTABLE);
  });
});

describe('isSelectionFilter(保存された値の検証)', () => {
  it('4 欄そろって真偽なら受け付ける', () => {
    expect(isSelectionFilter({ vertex: true, edge: false, face: true, body: false })).toBe(true);
  });

  it('欄が欠けている・真偽でない・object でないものは受け付けない', () => {
    expect(isSelectionFilter({ vertex: true, edge: true, face: true })).toBe(false);
    expect(isSelectionFilter({ vertex: 1, edge: true, face: true, body: true })).toBe(false);
    expect(isSelectionFilter(null)).toBe(false);
    expect(isSelectionFilter('all')).toBe(false);
  });
});
