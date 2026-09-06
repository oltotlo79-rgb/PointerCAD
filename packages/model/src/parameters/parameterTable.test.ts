import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { expectWithinBudget } from '@pointercad/test-utils';
import { describe, expect, it } from 'vitest';

import { createEmptyPartDocument } from '../part/createPartDocument.js';
import {
  addParameter,
  analyzeParameters,
  checkNewParameterName,
  isLengthUnitName,
  LENGTH_UNIT_NAME_MESSAGE,
  nextParameterName,
  parameterDependencies,
  parameterEvaluationOrder,
  referencesTo,
  removeParameter,
  renameParameter,
  reorderParameters,
  replaceParameter,
} from './parameterTable.js';
import { PARAMETER_UNITS, type Parameter, type ParameterUnit } from './types.js';

/**
 * 式のまま持つパラメータを 1 つ作る。他のパラメータを参照する式は単体では評価できないので、
 * そのときは値 0 の仮の値を入れる(解析は `source` だけを見るので結果に影響しない)。
 */
function param(name: string, source: string, unit: ParameterUnit = 'mm'): Parameter {
  const result = evaluateExpression(source);
  const value: ExpressionValue = result.ok ? result.value : { source, value: 0, display: '0' };
  return { name, value, unit, description: '' };
}

/** 変数表を素の物へ直して比べやすくする。 */
function plain(variables: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries(variables);
}

describe('analyzeParameters(変数表)', () => {
  it('板厚 = 3、穴径 = 板厚 * 2 の変数表が {板厚: 3, 穴径: 6} になる', () => {
    const parameters = [param('板厚', '3'), param('穴径', '板厚 * 2')];
    const analysis = analyzeParameters(parameters, []);
    expect(plain(analysis.variables)).toEqual({ 板厚: 3, 穴径: 6 });
    expect(analysis.circular).toEqual([]);
    expect(analysis.failures).toEqual([]);
  });

  it('板厚を 5 に差し替えると穴径が 10 になる', () => {
    const parameters = replaceParameter(
      [param('板厚', '3'), param('穴径', '板厚 * 2')],
      '板厚',
      param('板厚', '5'),
    );
    expect(plain(analyzeParameters(parameters, []).variables)).toEqual({ 板厚: 5, 穴径: 10 });
  });

  it('参照の順が表の並びと逆でも、依存の順に評価される', () => {
    const parameters = [param('C', 'B * 3'), param('B', 'A * 2'), param('A', '1')];
    const analysis = analyzeParameters(parameters, []);
    expect(plain(analysis.variables)).toEqual({ A: 1, B: 2, C: 6 });
    expect(analysis.failures).toEqual([]);
  });

  it('解析しても表の並び順は変わらない(元の配列を書き換えない)', () => {
    const parameters = [param('C', 'B * 3'), param('B', 'A * 2'), param('A', '1')];
    analyzeParameters(parameters, []);
    expect(parameters.map((parameter) => parameter.name)).toEqual(['C', 'B', 'A']);
  });

  it('空の表でも例外を投げず、すべて空を返す', () => {
    const analysis = analyzeParameters([], []);
    expect(plain(analysis.variables)).toEqual({});
    expect(analysis.circular).toEqual([]);
    expect(analysis.unused).toEqual([]);
    expect(analysis.failures).toEqual([]);
  });

  it('式のまま持つので value の欄は解析に使わない(source だけを見る)', () => {
    const stale: Parameter = {
      name: '板厚',
      // 前回の評価値(3)が残っているが、式は 4 になっている。
      value: { source: '4', value: 3, display: '3' },
      unit: 'mm',
      description: '',
    };
    expect(plain(analyzeParameters([stale], []).variables)).toEqual({ 板厚: 4 });
  });

  it('角度・無次元の単位でも数はそのまま(単位で換算しない)', () => {
    const parameters = [param('傾き', '30', 'degree'), param('個数', '4', 'none')];
    expect(plain(analyzeParameters(parameters, []).variables)).toEqual({ 傾き: 30, 個数: 4 });
  });

  it('単位の一覧は 3 種(mm / 度 / 無次元)', () => {
    expect(PARAMETER_UNITS).toEqual(['mm', 'degree', 'none']);
  });
});

describe('analyzeParameters(循環)', () => {
  it('互いに参照する 2 つを循環として返し、どちらも変数表に入れない', () => {
    const parameters = [param('A', 'B + 1'), param('B', 'A + 1')];
    const analysis = analyzeParameters(parameters, []);
    expect(analysis.circular).toEqual(['A', 'B']);
    expect(plain(analysis.variables)).toEqual({});
  });

  it('自分自身を参照する名前も循環になる', () => {
    const analysis = analyzeParameters([param('A', 'A + 1')], []);
    expect(analysis.circular).toEqual(['A']);
    expect(plain(analysis.variables)).toEqual({});
  });

  it('循環に含まれない名前は、循環があっても正しく評価される', () => {
    const parameters = [param('A', 'B + 1'), param('B', 'A + 1'), param('板厚', '3')];
    const analysis = analyzeParameters(parameters, []);
    expect(analysis.circular).toEqual(['A', 'B']);
    expect(plain(analysis.variables)).toEqual({ 板厚: 3 });
  });

  it('循環を参照している名前は循環ではなく「評価できなかった」に入る', () => {
    const parameters = [param('A', 'B + 1'), param('B', 'A + 1'), param('D', 'A + 1')];
    const analysis = analyzeParameters(parameters, []);
    expect(analysis.circular).toEqual(['A', 'B']);
    expect(analysis.failures.map((failure) => failure.name)).toEqual(['D']);
    expect(plain(analysis.variables)).toEqual({});
  });

  it('循環の並びは表の並び順で返る', () => {
    const analysis = analyzeParameters([param('B', 'A + 1'), param('A', 'B + 1')], []);
    expect(analysis.circular).toEqual(['B', 'A']);
  });

  it('3 つの輪も循環として返る', () => {
    const parameters = [param('A', 'B'), param('B', 'C'), param('C', 'A')];
    expect(analyzeParameters(parameters, []).circular).toEqual(['A', 'B', 'C']);
  });

  it('循環があっても例外を投げない', () => {
    expect(() => analyzeParameters([param('A', 'A * 2')], [])).not.toThrow();
  });
});

describe('analyzeParameters(評価できなかった名前)', () => {
  it('知らない名前を含む式は理由つきで failures へ入り、変数表には入らない', () => {
    const analysis = analyzeParameters([param('A', '未知 + 1')], []);
    expect(analysis.failures).toHaveLength(1);
    expect(analysis.failures[0].name).toBe('A');
    expect(analysis.failures[0].message).toContain('未知');
    expect(plain(analysis.variables)).toEqual({});
  });

  it('読めない式も理由つきで failures へ入る', () => {
    const analysis = analyzeParameters([param('A', '3 +')], []);
    expect(analysis.failures.map((failure) => failure.name)).toEqual(['A']);
  });

  it('ゼロ除算も理由つきで failures へ入る', () => {
    const analysis = analyzeParameters([param('A', '1 / 0')], []);
    expect(analysis.failures.map((failure) => failure.name)).toEqual(['A']);
    expect(plain(analysis.variables)).toEqual({});
  });
});

describe('analyzeParameters(使われていない名前)', () => {
  it('どこからも参照されない名前は unused に入る', () => {
    expect(analyzeParameters([param('未使用', '5')], []).unused).toEqual(['未使用']);
  });

  it('文書の式から参照されていれば unused に入らない', () => {
    expect(analyzeParameters([param('板厚', '3')], ['板厚 * 2']).unused).toEqual([]);
  });

  it('他のパラメータから参照されていれば unused に入らない', () => {
    const parameters = [param('板厚', '3'), param('穴径', '板厚 * 2')];
    expect(analyzeParameters(parameters, []).unused).toEqual(['穴径']);
  });

  it('名前の一部が一致するだけの式では使われたことにならない', () => {
    expect(analyzeParameters([param('板厚', '3')], ['板厚さ * 2']).unused).toEqual(['板厚']);
  });

  it('自分自身を参照するだけの名前は使われていない扱いにする', () => {
    expect(analyzeParameters([param('A', 'A + 1')], []).unused).toEqual(['A']);
  });

  it('読めない式が文書にあっても落ちず、他の参照は数えられる', () => {
    expect(analyzeParameters([param('板厚', '3')], ['3 +', '板厚']).unused).toEqual([]);
  });
});

describe('parameterDependencies / parameterEvaluationOrder(依存グラフ)', () => {
  it('参照している「表にある名前」だけを辺にする', () => {
    const parameters = [param('板厚', '3'), param('穴径', '板厚 * 2 + 未知')];
    const graph = parameterDependencies(parameters);
    expect(graph.get('板厚')).toEqual([]);
    expect(graph.get('穴径')).toEqual(['板厚']);
  });

  it('自分自身への参照は辺として残す(自己参照の循環を見つけるため)', () => {
    expect(parameterDependencies([param('A', 'A + 1')]).get('A')).toEqual(['A']);
  });

  it('評価順は参照される側が先になる', () => {
    const parameters = [param('C', 'B * 3'), param('B', 'A * 2'), param('A', '1')];
    expect(parameterEvaluationOrder(parameters).order).toEqual(['A', 'B', 'C']);
  });

  it('循環に含まれる名前は評価順に入らない', () => {
    const parameters = [param('A', 'B + 1'), param('B', 'A + 1'), param('板厚', '3')];
    const { order, circular } = parameterEvaluationOrder(parameters);
    expect(order).toEqual(['板厚']);
    expect(circular).toEqual(['A', 'B']);
  });

  it('参照し合わない名前は表の並びのまま評価順になる', () => {
    const parameters = [param('A', '1'), param('B', '2')];
    expect(parameterEvaluationOrder(parameters).order).toEqual(['A', 'B']);
  });
});

describe('表の編集(追加・削除・差し替え・並べ替え)', () => {
  it('addParameter は末尾へ足し、元の配列を変えない', () => {
    const before = [param('板厚', '3')];
    const after = addParameter(before, param('穴径', '6'));
    expect(after.map((parameter) => parameter.name)).toEqual(['板厚', '穴径']);
    expect(before).toHaveLength(1);
  });

  it('removeParameter は参照が残っていても消す(可否の判断は呼び出し側)', () => {
    const parameters = [param('板厚', '3'), param('穴径', '板厚 * 2')];
    expect(removeParameter(parameters, '板厚').map((p) => p.name)).toEqual(['穴径']);
  });

  it('removeParameter は無い名前を渡されても何も起きない', () => {
    const parameters = [param('板厚', '3')];
    expect(removeParameter(parameters, '穴径')).toEqual(parameters);
  });

  it('replaceParameter は並び順を保ったまま 1 つを差し替える', () => {
    const parameters = [param('板厚', '3'), param('穴径', '板厚 * 2')];
    const next = replaceParameter(parameters, '板厚', param('板厚', '5'));
    expect(next.map((parameter) => parameter.name)).toEqual(['板厚', '穴径']);
    expect(next[0].value.source).toBe('5');
  });

  it('reorderParameters は行を抜いて差し込む', () => {
    const parameters = [param('A', '1'), param('B', '2'), param('C', '3')];
    expect(reorderParameters(parameters, 0, 2).map((p) => p.name)).toEqual(['B', 'C', 'A']);
  });

  it('reorderParameters は範囲の外の位置では何もしない', () => {
    const parameters = [param('A', '1'), param('B', '2')];
    expect(reorderParameters(parameters, 0, 5)).toEqual(parameters);
    expect(reorderParameters(parameters, -1, 1)).toEqual(parameters);
    expect(reorderParameters(parameters, 1, 1)).toEqual(parameters);
  });

  it('並べ替えても評価の結果は変わらない', () => {
    const parameters = [param('板厚', '3'), param('穴径', '板厚 * 2')];
    const moved = reorderParameters(parameters, 1, 0);
    expect(plain(analyzeParameters(moved, []).variables)).toEqual({ 板厚: 3, 穴径: 6 });
  });
});

describe('renameParameter(改名)', () => {
  it('参照している式が追従する', () => {
    const parameters = [param('板厚', '3'), param('穴径', '板厚 * 2')];
    const next = renameParameter(parameters, '板厚', '板の厚み');
    expect(next.map((parameter) => parameter.name)).toEqual(['板の厚み', '穴径']);
    expect(next[1].value.source).toBe('板の厚み * 2');
    expect(plain(analyzeParameters(next, []).variables)).toEqual({ 板の厚み: 3, 穴径: 6 });
  });

  it('名前の一部が一致するだけの別の名前は変わらない', () => {
    const parameters = [param('板厚', '3'), param('板厚さ', '4'), param('合計', '板厚さ + 板厚')];
    const next = renameParameter(parameters, '板厚', '厚み');
    expect(next.map((parameter) => parameter.name)).toEqual(['厚み', '板厚さ', '合計']);
    expect(next[2].value.source).toBe('板厚さ + 厚み');
  });

  it('改名では評価値を変えない(数は変わらないため)', () => {
    const parameters = [param('板厚', '3'), param('穴径', '板厚 * 2')];
    const before = parameters[1].value;
    const next = renameParameter(parameters, '板厚', '板の厚み');
    expect(next[1].value.value).toBe(before.value);
    expect(next[1].value.display).toBe(before.display);
  });

  it('自分自身を参照する式も追従する', () => {
    const next = renameParameter([param('A', 'A + 1')], 'A', 'B');
    expect(next[0].name).toBe('B');
    expect(next[0].value.source).toBe('B + 1');
  });

  it('表に無い名前を渡されたら何もしない', () => {
    const parameters = [param('板厚', '3')];
    expect(renameParameter(parameters, '穴径', '直径')).toEqual(parameters);
  });
});

describe('referencesTo / nextParameterName', () => {
  it('その名前を参照しているパラメータの名前を返す', () => {
    const parameters = [param('板厚', '3'), param('穴径', '板厚 * 2')];
    expect(referencesTo(parameters, '板厚')).toEqual(['穴径']);
    expect(referencesTo(parameters, '穴径')).toEqual([]);
  });

  it('自分自身への参照は数えない', () => {
    expect(referencesTo([param('A', 'A + 1')], 'A')).toEqual([]);
  });

  it('名前の一部が一致するだけの式は数えない', () => {
    const parameters = [param('板厚', '3'), param('合計', '板厚さ * 2')];
    expect(referencesTo(parameters, '板厚')).toEqual([]);
  });

  it('次の空き名は最大連番 + 1 になる', () => {
    const parameters = [param('パラメータ1', '1'), param('パラメータ3', '3')];
    expect(nextParameterName(parameters)).toBe('パラメータ4');
  });

  it('表が空なら「パラメータ1」', () => {
    expect(nextParameterName([])).toBe('パラメータ1');
  });
});

describe('部品文書のパラメータ表', () => {
  it('新しい部品文書のパラメータ表は空', () => {
    expect(createEmptyPartDocument().parameters).toEqual([]);
  });
});

describe('checkNewParameterName(新しく付ける名前。P6 §0.a-0.1)', () => {
  it('単位の綴り in / mm / " は新しい名前として断る', () => {
    expect(checkNewParameterName('in')).toBe('lengthUnitName');
    expect(checkNewParameterName('mm')).toBe('lengthUnitName');
    expect(checkNewParameterName('"')).toBe('lengthUnitName');
  });

  it('大文字小文字を問わず断る(式の字句が大文字小文字を問わないため)', () => {
    expect(checkNewParameterName('IN')).toBe('lengthUnitName');
    expect(checkNewParameterName('Mm')).toBe('lengthUnitName');
  });

  it('断りの文言は「in と mm は単位の名前なので、パラメータの名前には使えません。」', () => {
    expect(LENGTH_UNIT_NAME_MESSAGE).toBe(
      'in と mm は単位の名前なので、パラメータの名前には使えません。',
    );
  });

  it('単位でない名前はこれまでどおり通る', () => {
    expect(checkNewParameterName('板厚')).toBeNull();
    expect(checkNewParameterName('inch')).toBeNull();
    expect(checkNewParameterName('mm2')).toBeNull();
  });

  it('これまでの理由(予約語・数字始まり・空・使えない文字)はそのまま返る', () => {
    expect(checkNewParameterName('sqrt')).toBe('reserved');
    expect(checkNewParameterName('2倍')).toBe('startsWithDigit');
    expect(checkNewParameterName('')).toBe('empty');
    expect(checkNewParameterName('板 厚')).toBe('invalidCharacter');
  });

  it('isLengthUnitName は綴りだけを見る', () => {
    expect(isLengthUnitName('in')).toBe(true);
    expect(isLengthUnitName('inch')).toBe(false);
    expect(isLengthUnitName('')).toBe(false);
  });

  it('既存の文書に mm / in という名前があっても読み込みと評価は通る(弾かない)', () => {
    // 断るのは「これから打つ名前」だけ(統括の決定)。表の解析は何も変えていない。
    const parameters = [param('mm', '5'), param('in', 'mm * 2')];
    const analysis = analyzeParameters(parameters, []);
    expect(plain(analysis.variables)).toEqual({ mm: 5, in: 10 });
    expect(analysis.failures).toEqual([]);
    expect(analysis.circular).toEqual([]);
  });
});

describe('性能(NFR-PF-3 の内訳)', () => {
  it('200 件の連鎖の解析が 50ms 以内に終わる', () => {
    // A1 = 1、A2 = A1 + 1、… A200 = A199 + 1。値は 1 から 200 まで。
    const parameters: Parameter[] = [param('A1', '1')];
    for (let index = 2; index <= 200; index += 1) {
      parameters.push(param(`A${String(index)}`, `A${String(index - 1)} + 1`));
    }
    const startedAt = performance.now();
    const analysis = analyzeParameters(parameters, []);
    const elapsedMs = performance.now() - startedAt;
    console.log(`パラメータ 200 件の連鎖の解析: ${elapsedMs.toFixed(1)}ms / 上限 50ms`);
    expect(analysis.variables.get('A200')).toBe(200);
    expect(analysis.circular).toEqual([]);
    expectWithinBudget(elapsedMs, 50, '200 件の連鎖の解析');
  });
});
