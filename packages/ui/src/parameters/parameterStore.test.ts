/**
 * パラメータ表のパネルの配線(要件 FR-207・FR-201・FR-502、
 * 計画書 docs/plans/P4b-スケッチの仕上げ.md タスク11)。
 *
 * ここで確かめるのは 3 つ。
 * ①ストアがパラメータ表の解析(変数表・循環・未使用)を文書から作り直していること。
 * ②**3 つの入口(プロパティの欄・その場入力・コマンドライン)が同じ変数表を見る**こと。
 *   片方だけに渡すと、同じ式が打つ場所によって通ったり通らなかったりする(タスク18 の申し送り)。
 * ③値を変えると参照している押し出しの距離が追従し、取り消しで戻ること(FR-502、FR-505)。
 *
 * 画面の描画そのもの(React)は node 環境の検査では動かせないので、ヘッドレスの撮影で
 * 確かめる(タスク11 手順7)。ここは描画に渡る値までを固定する。
 */

import { evaluateExpression, expressionValueFromNumber } from '@pointercad/expression';
import {
  appendSolid,
  createEmptyPartDocument,
  type ExtrudeFeature,
  type PartDocument,
} from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { commandLineContext } from '../shell/commandLineActions.js';
import {
  createNumericInput,
  evaluateNumericInput,
  reduceNumericInput,
} from '../sketch/numericInput.js';
import { createInitialDocumentState, useAppStore } from '../store/useAppStore.js';
import {
  commitAddParameter,
  commitRemoveParameter,
  commitRenameParameter,
  commitReorderParameters,
  commitReplaceParameter,
  parameterDraftFor,
  parameterRowsOf,
  parameterUsageCounts,
} from './parameterCommands.js';

/**
 * 距離を式で持つ押し出し 1 つ。
 *
 * まだパラメータが決まっていない段階の式(`板厚 * 2`)も置けるように、値は 0 のまま
 * **式の文字列だけ**を入れる(FR-202。`applyParameters` が変数表で値を入れ直す)。
 */
function extrudeWith(source: string): ExtrudeFeature {
  return {
    id: 'extrude-1',
    kind: 'extrude',
    name: '押し出し1',
    suppressed: false,
    profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
    distance: { source, value: 0, display: '0' },
    reversed: false,
    symmetric: false,
  };
}

/** 押し出しの距離を式で持つ部品文書。 */
function partWithExtrude(source: string): PartDocument {
  return appendSolid(createEmptyPartDocument(), extrudeWith(source));
}

/** ストアの文書を差し替える(パネルの確定と同じ入口を通す)。 */
function apply(next: PartDocument): void {
  useAppStore.getState().applyDocument(next);
}

/** いまストアにある文書の押し出しの距離。 */
function extrudeDistance(): { readonly source: string; readonly value: number } {
  const solid = useAppStore.getState().document.solids[0];
  if (solid === undefined || solid.kind !== 'extrude') {
    throw new Error('押し出しが見つかりません');
  }
  return { source: solid.distance.source, value: solid.distance.value };
}

/** 「板厚 = 3」を足したところまで進めた文書をストアへ入れる。 */
function withThickness(): void {
  apply(partWithExtrude('板厚 * 2'));
  const outcome = commitAddParameter(useAppStore.getState().document, {
    name: '板厚',
    value: expressionValueFromNumber(3),
    unit: 'mm',
    description: '板の厚み',
  });
  if (!outcome.ok) {
    throw new Error(outcome.message);
  }
  apply(outcome.document);
}

beforeEach(() => {
  useAppStore.setState(createInitialDocumentState());
});

describe('ストアが持つパラメータ表の解析(FR-207)', () => {
  it('パラメータが 1 つも無ければ変数表は空で、循環も未使用も無い', () => {
    const analysis = useAppStore.getState().parameterAnalysis;
    expect(analysis.variables.size).toBe(0);
    expect(analysis.circular).toEqual([]);
    expect(analysis.unused).toEqual([]);
    expect(analysis.failures).toEqual([]);
  });

  it('板厚 = 3 を足すと変数表へ入る', () => {
    withThickness();
    expect(useAppStore.getState().parameterAnalysis.variables.get('板厚')).toBe(3);
  });

  it('板厚 * 2 と書いた押し出しの距離が 6 になる(式は文字列のまま、FR-202)', () => {
    withThickness();
    expect(extrudeDistance()).toEqual({ source: '板厚 * 2', value: 6 });
  });

  it('板厚を 5 にすると押し出しの距離が 10 へ追従する(FR-502、利用者の例)', () => {
    withThickness();
    const outcome = commitReplaceParameter(useAppStore.getState().document, '板厚', {
      value: expressionValueFromNumber(5),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    apply(outcome.document);
    expect(extrudeDistance()).toEqual({ source: '板厚 * 2', value: 10 });
    expect(useAppStore.getState().parameterAnalysis.variables.get('板厚')).toBe(5);
  });

  it('穴径 = 板厚 * 2 も同じ表で解け、板厚を 5 にすると 10 になる', () => {
    withThickness();
    const added = commitAddParameter(useAppStore.getState().document, {
      name: '穴径',
      value: { source: '板厚 * 2', value: 0, display: '0' },
      unit: 'mm',
      description: '',
    });
    expect(added.ok).toBe(true);
    if (!added.ok) {
      return;
    }
    apply(added.document);
    expect(useAppStore.getState().parameterAnalysis.variables.get('穴径')).toBe(6);

    const edited = commitReplaceParameter(useAppStore.getState().document, '板厚', {
      value: expressionValueFromNumber(5),
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) {
      return;
    }
    apply(edited.document);
    expect(useAppStore.getState().parameterAnalysis.variables.get('穴径')).toBe(10);
  });

  it('改名すると押し出しの距離の式も追従し、値は変わらない', () => {
    withThickness();
    const outcome = commitRenameParameter(useAppStore.getState().document, '板厚', '板の厚み');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    apply(outcome.document);
    expect(extrudeDistance()).toEqual({ source: '板の厚み * 2', value: 6 });
    expect(useAppStore.getState().parameterAnalysis.variables.get('板の厚み')).toBe(3);
  });

  it('確定 1 回につき取り消し 1 回で戻る(FR-505)', () => {
    withThickness();
    const outcome = commitReplaceParameter(useAppStore.getState().document, '板厚', {
      value: expressionValueFromNumber(5),
    });
    if (!outcome.ok) {
      throw new Error(outcome.message);
    }
    apply(outcome.document);
    expect(extrudeDistance().value).toBe(10);

    useAppStore.getState().undo();

    expect(extrudeDistance().value).toBe(6);
    expect(useAppStore.getState().parameterAnalysis.variables.get('板厚')).toBe(3);
  });

  it('循環しても例外を投げず、2 つの名前に印が付く(FR-207、FR-504)', () => {
    apply(partWithExtrude('10'));
    const first = commitAddParameter(useAppStore.getState().document, {
      name: 'A',
      value: expressionValueFromNumber(1),
      unit: 'none',
      description: '',
    });
    if (!first.ok) {
      throw new Error(first.message);
    }
    const second = commitAddParameter(first.document, {
      name: 'B',
      value: { source: 'A + 1', value: 2, display: '2' },
      unit: 'none',
      description: '',
    });
    if (!second.ok) {
      throw new Error(second.message);
    }
    const circular = commitReplaceParameter(second.document, 'A', {
      value: { source: 'B + 1', value: 1, display: '1' },
    });
    expect(circular.ok).toBe(true);
    if (!circular.ok) {
      return;
    }
    apply(circular.document);

    const analysis = useAppStore.getState().parameterAnalysis;
    expect([...analysis.circular].sort()).toEqual(['A', 'B']);
    expect(analysis.variables.has('A')).toBe(false);
    expect(analysis.variables.has('B')).toBe(false);
  });

  it('どこからも呼び出されない名前に「未使用」の印が付く(FR-207)', () => {
    apply(partWithExtrude('10'));
    const outcome = commitAddParameter(useAppStore.getState().document, {
      name: '未使用',
      value: expressionValueFromNumber(5),
      unit: 'mm',
      description: '',
    });
    if (!outcome.ok) {
      throw new Error(outcome.message);
    }
    apply(outcome.document);
    expect(useAppStore.getState().parameterAnalysis.unused).toEqual(['未使用']);
  });

  it('参照が残っている名前は消せず、件数の入った理由が返る(NFR-UX-5)', () => {
    withThickness();
    const outcome = commitRemoveParameter(useAppStore.getState().document, '板厚');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toBe('referenced');
    expect(outcome.message).toContain('1');
  });
});

describe('3 つの入口が同じ変数表を見る(タスク18 の申し送り)', () => {
  it('コマンドラインの手掛かりがストアの変数表をそのまま返す', () => {
    withThickness();
    const context = commandLineContext();
    expect(context.variables.get('板厚')).toBe(3);
    expect(context.variables).toBe(useAppStore.getState().parameterAnalysis.variables);
  });

  it('その場入力が変数表つきで「板厚 * 2」を 6 と読む', () => {
    withThickness();
    const base = createNumericInput('extrude', 'extrudeDistance');
    const state = {
      ...base,
      fields: base.fields.map((field) => ({ ...field, source: '板厚 * 2' })),
    };
    const evaluation = evaluateNumericInput(
      state,
      useAppStore.getState().parameterAnalysis.variables,
    );
    expect(evaluation.canCommit).toBe(true);
    expect(evaluation.results[0]?.value?.value).toBe(6);
  });

  it('変数表を渡さないと同じ式が読めない(配線もれの検出)', () => {
    withThickness();
    const base = createNumericInput('extrude', 'extrudeDistance');
    const state = {
      ...base,
      fields: base.fields.map((field) => ({ ...field, source: '板厚 * 2' })),
    };
    expect(evaluateNumericInput(state).canCommit).toBe(false);
  });

  it('プロパティの欄と同じ評価も変数表つきで 6 を返す', () => {
    withThickness();
    const variables = useAppStore.getState().parameterAnalysis.variables;
    const result = evaluateExpression('板厚 * 2', { variables });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.value).toBe(6);
    expect(result.value.source).toBe('板厚 * 2');
  });
});

describe('表の行(パネルが並べるもの)', () => {
  it('行は表の並び順のまま返り、並べ替えても値は変わらない', () => {
    apply(partWithExtrude('10'));
    let document = useAppStore.getState().document;
    for (const name of ['一', '二', '三']) {
      const outcome = commitAddParameter(document, {
        name,
        value: expressionValueFromNumber(1),
        unit: 'none',
        description: '',
      });
      if (!outcome.ok) {
        throw new Error(outcome.message);
      }
      document = outcome.document;
    }
    apply(document);
    expect(
      parameterRowsOf(
        useAppStore.getState().document,
        useAppStore.getState().parameterAnalysis,
      ).map((row) => row.name),
    ).toEqual(['一', '二', '三']);

    const moved = commitReorderParameters(useAppStore.getState().document, 0, 2);
    if (!moved.ok) {
      throw new Error(moved.message);
    }
    apply(moved.document);
    const rows = parameterRowsOf(
      useAppStore.getState().document,
      useAppStore.getState().parameterAnalysis,
    );
    expect(rows.map((row) => row.name)).toEqual(['二', '三', '一']);
    expect(rows.map((row) => row.value)).toEqual([1, 1, 1]);
  });

  it('使われている数は、他のパラメータからの参照と文書の式からの参照を足したもの', () => {
    withThickness();
    const added = commitAddParameter(useAppStore.getState().document, {
      name: '穴径',
      value: { source: '板厚 * 2', value: 6, display: '6' },
      unit: 'mm',
      description: '',
    });
    if (!added.ok) {
      throw new Error(added.message);
    }
    apply(added.document);

    const counts = parameterUsageCounts(useAppStore.getState().document);
    // 穴径の式から 1 か所、押し出しの距離の式から 1 か所。
    expect(counts.get('板厚')).toBe(2);
    expect(counts.get('穴径')).toBe(0);
  });

  it('新しい行の下書きは次の空き名で、値は 0、単位は mm', () => {
    apply(partWithExtrude('10'));
    const draft = parameterDraftFor(useAppStore.getState().document);
    expect(draft.name).toBe('パラメータ1');
    expect(draft.value.value).toBe(0);
    expect(draft.unit).toBe('mm');
    expect(draft.description).toBe('');
  });

  it('行は循環・未使用・評価できなかった理由の印を持つ', () => {
    apply(partWithExtrude('10'));
    const outcome = commitAddParameter(useAppStore.getState().document, {
      name: 'X',
      value: { source: '未知 + 1', value: 0, display: '0' },
      unit: 'none',
      description: '',
    });
    if (!outcome.ok) {
      throw new Error(outcome.message);
    }
    apply(outcome.document);

    const rows = parameterRowsOf(
      useAppStore.getState().document,
      useAppStore.getState().parameterAnalysis,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.circular).toBe(false);
    expect(rows[0]?.unused).toBe(true);
    expect(rows[0]?.failureMessage).not.toBeNull();
  });
});

describe('長さでないパラメータの名前(P6 タスク3b、§0.a-0.63)', () => {
  /** 名前と単位だけを決めてパラメータを 1 つ足す。 */
  const addParameter = (name: string, unit: 'mm' | 'degree' | 'none'): void => {
    const outcome = commitAddParameter(useAppStore.getState().document, {
      name,
      value: expressionValueFromNumber(5),
      unit,
      description: '',
    });
    if (!outcome.ok) {
      throw new Error(outcome.message);
    }
    apply(outcome.document);
  };

  it('パラメータが 1 つも無ければ空(参照も使い回す)', () => {
    expect(useAppStore.getState().nonLengthVariables.size).toBe(0);
    expect(useAppStore.getState().nonLengthVariables).toBe(
      useAppStore.getState().nonLengthVariables,
    );
  });

  it('長さ(mm)は入らず、角度と無次元だけが入る', () => {
    apply(partWithExtrude('板厚 * 2'));
    addParameter('板厚', 'mm');
    addParameter('傾き', 'degree');
    addParameter('個数', 'none');
    const names = useAppStore.getState().nonLengthVariables;
    expect(names.has('板厚')).toBe(false);
    expect(names.has('傾き')).toBe(true);
    expect(names.has('個数')).toBe(true);
  });

  it('その場入力が inch の空間で長さのパラメータだけを換算する(`板厚 + 10` = 279.4mm)', () => {
    apply(partWithExtrude('板厚 * 2'));
    const outcome = commitAddParameter(useAppStore.getState().document, {
      name: '板厚',
      value: expressionValueFromNumber(25.4),
      unit: 'mm',
      description: '',
    });
    if (!outcome.ok) {
      throw new Error(outcome.message);
    }
    apply(outcome.document);
    const store = useAppStore.getState();
    const base = createNumericInput('extrude', 'extrudeDistance');
    const state = reduceNumericInput(base, { type: 'edit', index: 0, source: '板厚 + 10' });
    const evaluation = evaluateNumericInput(state, store.parameterAnalysis.variables, {
      lengthUnit: 'inch',
      nonLengthVariables: store.nonLengthVariables,
    });
    expect(evaluation.results[0].value?.value).toBeCloseTo(279.4, 9);
  });

  it('長さでないパラメータは inch の空間でも割られない(`個数 + 10` = 15in)', () => {
    apply(partWithExtrude('10'));
    addParameter('個数', 'none');
    const store = useAppStore.getState();
    const base = createNumericInput('extrude', 'extrudeDistance');
    const state = reduceNumericInput(base, { type: 'edit', index: 0, source: '個数 + 10' });
    const evaluation = evaluateNumericInput(state, store.parameterAnalysis.variables, {
      lengthUnit: 'inch',
      nonLengthVariables: store.nonLengthVariables,
    });
    // 5 + 10 = 15 を inch として読むので 381mm。割ってしまうと 259.4mm になる。
    expect(evaluation.results[0].value?.value).toBeCloseTo(381, 9);
  });
});
