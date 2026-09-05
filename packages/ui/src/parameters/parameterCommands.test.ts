import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { createEmptyPartDocument, type Parameter, type PartDocument, type SolidFeature } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  commitAddParameter,
  commitReorderParameters,
  commitRemoveParameter,
  commitRenameParameter,
  commitReplaceParameter,
  parameterDraftFor,
  parameterRowsOf,
  REFERENCED_NAME_LIMIT,
  referencingFeatureNames,
  type ParameterCommandOutcome,
} from './parameterCommands.js';

// ---------------------------------------------------------------------------
// 検査の土台(packages/model/src/part/reevaluatePart.test.ts と同じ流儀)
// ---------------------------------------------------------------------------

/** そのまま評価できる式。評価できない式はテストの誤りとして落とす。 */
function expr(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (!result.ok) {
    throw new Error(`テストの式が評価できない: ${source}(${result.error.code})`);
  }
  return result.value;
}

/** 式のまま持つパラメータを1つ作る。他のパラメータを参照する式は単体では評価できないので、
 * そのときは値0の仮の値を入れる(コミット関数は最後に applyParameters を通すので結果には影響しない)。 */
function param(name: string, source: string): Parameter {
  const result = evaluateExpression(source);
  const value: ExpressionValue = result.ok ? result.value : { source, value: 0, display: '0' };
  return { name, value, unit: 'mm', description: '' };
}

function draft(name: string, source: string): Parameter {
  return param(name, source);
}

function extrude(id: string, distance: ExpressionValue): SolidFeature {
  return {
    id,
    name: id,
    suppressed: false,
    kind: 'extrude',
    profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
    distance,
    reversed: false,
    symmetric: false,
  };
}

function documentWith(parameters: readonly Parameter[], solids: readonly SolidFeature[] = []): PartDocument {
  return { ...createEmptyPartDocument(), parameters, solids };
}

/** 表示名を差し替えた立体(断りの文に出る名前を確かめるため)。 */
function named(feature: SolidFeature, name: string): SolidFeature {
  return { ...feature, name };
}

/** 変数を含む式(そのままでは評価できないので値は 0 で置く)。 */
function pending(source: string): ExpressionValue {
  return { source, value: 0, display: '0' };
}

function extrudeDistance(document: PartDocument): number {
  const solid = document.solids[0];
  if (solid === undefined || solid.kind !== 'extrude') {
    throw new Error('押し出しのはず');
  }
  return solid.distance.value;
}

function parameterValue(document: PartDocument, name: string): number {
  const parameter = document.parameters.find((entry) => entry.name === name);
  if (parameter === undefined) {
    throw new Error(`${name} が見つからない`);
  }
  return parameter.value.value;
}

function ok(outcome: ParameterCommandOutcome): asserts outcome is ParameterCommandOutcome & { ok: true } {
  if (!outcome.ok) {
    throw new Error(`成功するはずが断られた: ${outcome.message}`);
  }
}

// ---------------------------------------------------------------------------
// parameterDraftFor
// ---------------------------------------------------------------------------

describe('parameterDraftFor', () => {
  it('次の空き名・式 0・単位 mm を返す', () => {
    const document = documentWith([param('パラメータ1', '1')]);
    const created = parameterDraftFor(document);
    expect(created.name).toBe('パラメータ2');
    expect(created.value.source).toBe('0');
    expect(created.value.value).toBe(0);
    expect(created.unit).toBe('mm');
    expect(created.description).toBe('');
  });

  it('表が空なら「パラメータ1」', () => {
    expect(parameterDraftFor(documentWith([])).name).toBe('パラメータ1');
  });
});

// ---------------------------------------------------------------------------
// commitAddParameter
// ---------------------------------------------------------------------------

describe('commitAddParameter', () => {
  it('板厚 = 3 を足せる', () => {
    const outcome = commitAddParameter(documentWith([]), draft('板厚', '3'));
    ok(outcome);
    expect(outcome.document.parameters).toHaveLength(1);
    expect(parameterValue(outcome.document, '板厚')).toBe(3);
  });

  it('続けて 穴径 = 板厚 * 2 を足すと値は 6(利用者の例)', () => {
    const first = commitAddParameter(documentWith([]), draft('板厚', '3'));
    ok(first);
    const second = commitAddParameter(first.document, draft('穴径', '板厚 * 2'));
    ok(second);
    expect(parameterValue(second.document, '穴径')).toBe(6);
  });

  it('重複した名前は断る', () => {
    const document = documentWith([param('板厚', '3')]);
    const outcome = commitAddParameter(document, draft('板厚', '4'));
    expect(outcome).toEqual({
      ok: false,
      reason: 'duplicateName',
      message: 'その名前はすでにあります。',
    });
  });

  it('数字で始まる名前は断る', () => {
    const outcome = commitAddParameter(documentWith([]), draft('2倍', '3'));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error('断られるはず');
    }
    expect(outcome.reason).toBe('startsWithDigit');
    expect(outcome.message).toBe('名前は数字で始められません。');
  });

  it('予約語(関数名)は断る', () => {
    const outcome = commitAddParameter(documentWith([]), draft('sqrt', '3'));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error('断られるはず');
    }
    expect(outcome.reason).toBe('reserved');
    expect(outcome.message).toContain('計算に使う言葉');
  });

  it('使えない文字を含む名前は断る', () => {
    const outcome = commitAddParameter(documentWith([]), draft('板 厚', '3'));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error('断られるはず');
    }
    expect(outcome.reason).toBe('invalidCharacter');
  });

  it('足した直後の文書は解析済み(analysis.unused に載る)', () => {
    const outcome = commitAddParameter(documentWith([]), draft('未使用', '5'));
    ok(outcome);
    expect(outcome.analysis.unused).toEqual(['未使用']);
  });
});

// ---------------------------------------------------------------------------
// commitReplaceParameter(値の書き換え・追従)
// ---------------------------------------------------------------------------

describe('commitReplaceParameter', () => {
  it('板厚を 5 にすると穴径(板厚 * 2)が 10 になる', () => {
    const document = documentWith([param('板厚', '3'), param('穴径', '板厚 * 2')]);
    const outcome = commitReplaceParameter(document, '板厚', { value: expr('5') });
    ok(outcome);
    expect(parameterValue(outcome.document, '板厚')).toBe(5);
    expect(parameterValue(outcome.document, '穴径')).toBe(10);
  });

  it('板厚を 5 にすると、押し出しの距離(板厚 * 2)も 10 に追従する', () => {
    const document = documentWith(
      [param('板厚', '3')],
      [extrude('extrude-1', { source: '板厚 * 2', value: 6, display: '6' })],
    );
    const outcome = commitReplaceParameter(document, '板厚', { value: expr('5') });
    ok(outcome);
    expect(extrudeDistance(outcome.document)).toBe(10);
  });

  it('名前は変えない(patch.name を渡しても無視する)', () => {
    const document = documentWith([param('板厚', '3')]);
    const outcome = commitReplaceParameter(document, '板厚', {
      name: '別名',
      value: expr('4'),
    });
    ok(outcome);
    expect(outcome.document.parameters.map((parameter) => parameter.name)).toEqual(['板厚']);
    expect(parameterValue(outcome.document, '板厚')).toBe(4);
  });

  it('式が読めない値でも断らない(欄の赤表示に任せる)', () => {
    const document = documentWith([param('板厚', '3')]);
    const outcome = commitReplaceParameter(document, '板厚', {
      value: { source: '未知 + 1', value: 3, display: '3' },
    });
    ok(outcome);
    expect(outcome.analysis.failures.map((failure) => failure.name)).toEqual(['板厚']);
    // 評価できないので前回の値(3)のまま据え置かれる。
    expect(parameterValue(outcome.document, '板厚')).toBe(3);
  });

  it('循環を作る書き換えは断らない(印だけ付く)', () => {
    const document = documentWith([
      param('A', 'B + 1'),
      { ...param('B', '1'), value: { source: '1', value: 1, display: '1' } },
    ]);
    // B を A に依存する式へ書き換えると、A ⇄ B の循環になる。
    const outcome = commitReplaceParameter(document, 'B', { value: { source: 'A + 1', value: 1, display: '1' } });
    ok(outcome);
    expect(outcome.analysis.circular.slice().sort()).toEqual(['A', 'B']);
  });

  it('無い名前を差し替えようとすると断る', () => {
    const outcome = commitReplaceParameter(documentWith([]), '板厚', { value: expr('1') });
    expect(outcome).toEqual({ ok: false, reason: 'notFound', message: 'その名前が見つかりません。' });
  });
});

// ---------------------------------------------------------------------------
// commitRemoveParameter
// ---------------------------------------------------------------------------

describe('commitRemoveParameter', () => {
  it('他のパラメータから参照されていれば断り、件数を文へ差し込む', () => {
    const document = documentWith([param('板厚', '3'), param('穴径', '板厚 * 2')]);
    const outcome = commitRemoveParameter(document, '板厚');
    expect(outcome).toEqual({
      ok: false,
      reason: 'referenced',
      message: 'この名前は 1 か所から使われています。先にそちらを直してください。',
    });
  });

  it('文書の側から参照されていたら、参照元のフィーチャー名を並べて断る(タスク22b)', () => {
    const document = documentWith(
      [param('板厚', '3')],
      [
        named(extrude('extrude-1', pending('板厚 * 2')), '押し出し1'),
        named(extrude('extrude-2', pending('板厚')), '穴1'),
      ],
    );
    const outcome = commitRemoveParameter(document, '板厚');
    expect(outcome).toEqual({
      ok: false,
      reason: 'referenced',
      message: 'この名前は 押し出し1、穴1 から使われています。先にそちらを直してください。',
    });
  });

  it('参照元が 3 件を超えたら「ほか N 件」でまとめる(帯の 1 行に収める)', () => {
    const document = documentWith(
      [param('板厚', '3')],
      ['押し出し1', '穴1', '面取り1', 'フィレット1', 'ばね1'].map((name, index) =>
        named(extrude(`extrude-${String(index + 1)}`, pending('板厚')), name),
      ),
    );
    const outcome = commitRemoveParameter(document, '板厚');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error('断られるはず');
    }
    expect(outcome.message).toBe(
      'この名前は 押し出し1、穴1、面取り1、ほか 2 件 から使われています。先にそちらを直してください。',
    );
    expect(REFERENCED_NAME_LIMIT).toBe(3);
  });

  it('参照元がパラメータ表の中だけなら、従来どおり件数で断る', () => {
    const document = documentWith([param('板厚', '3'), param('穴径', '板厚 * 2')]);
    expect(referencingFeatureNames(document, '板厚')).toEqual([]);
  });

  it('誰からも参照されていなければ消せる', () => {
    const document = documentWith([param('板厚', '3'), param('穴径', '板厚 * 2')]);
    const outcome = commitRemoveParameter(document, '穴径');
    ok(outcome);
    expect(outcome.document.parameters.map((parameter) => parameter.name)).toEqual(['板厚']);
  });

  it('無い名前を消そうとすると断る', () => {
    const outcome = commitRemoveParameter(documentWith([]), '板厚');
    expect(outcome).toEqual({ ok: false, reason: 'notFound', message: 'その名前が見つかりません。' });
  });
});

// ---------------------------------------------------------------------------
// commitRenameParameter
// ---------------------------------------------------------------------------

describe('commitRenameParameter', () => {
  it('参照している式が追従し、値は変わらない', () => {
    const document = documentWith([param('板厚', '3'), param('穴径', '板厚 * 2')]);
    const outcome = commitRenameParameter(document, '板厚', '板の厚み');
    ok(outcome);
    expect(outcome.document.parameters.map((parameter) => parameter.name)).toEqual([
      '板の厚み',
      '穴径',
    ]);
    expect(outcome.document.parameters[1].value.source).toBe('板の厚み * 2');
    expect(parameterValue(outcome.document, '穴径')).toBe(6);
  });

  it('文書の側(押し出しの距離)の式も追従する', () => {
    const document = documentWith(
      [param('板厚', '3')],
      [extrude('extrude-1', { source: '板厚 + 1', value: 4, display: '4' })],
    );
    const outcome = commitRenameParameter(document, '板厚', '板の厚み');
    ok(outcome);
    const solid = outcome.document.solids[0];
    if (solid === undefined || solid.kind !== 'extrude') {
      throw new Error('押し出しのはず');
    }
    expect(solid.distance.source).toBe('板の厚み + 1');
    expect(solid.distance.value).toBe(4);
  });

  it('改名先が重複していれば断る', () => {
    const document = documentWith([param('板厚', '3'), param('穴径', '6')]);
    const outcome = commitRenameParameter(document, '板厚', '穴径');
    expect(outcome).toEqual({
      ok: false,
      reason: 'duplicateRename',
      message: 'その名前はすでにあります。',
    });
  });

  it('改名先が不正な名前なら断る', () => {
    const document = documentWith([param('板厚', '3')]);
    const outcome = commitRenameParameter(document, '板厚', '2倍');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error('断られるはず');
    }
    expect(outcome.reason).toBe('startsWithDigit');
  });

  it('無い名前を改名しようとすると断る', () => {
    const outcome = commitRenameParameter(documentWith([]), '板厚', '板の厚み');
    expect(outcome).toEqual({ ok: false, reason: 'notFound', message: 'その名前が見つかりません。' });
  });

  it('同じ名前への改名は何もしない(applyParameters だけ通る)', () => {
    const document = documentWith([param('板厚', '3')]);
    const outcome = commitRenameParameter(document, '板厚', '板厚');
    ok(outcome);
    expect(outcome.document.parameters.map((parameter) => parameter.name)).toEqual(['板厚']);
  });
});

// ---------------------------------------------------------------------------
// commitReorderParameters
// ---------------------------------------------------------------------------

describe('commitReorderParameters', () => {
  it('並びが変わり、値は変わらない(評価は依存順)', () => {
    const document = documentWith([param('板厚', '3'), param('穴径', '板厚 * 2'), param('C', '1')]);
    const outcome = commitReorderParameters(document, 0, 2);
    ok(outcome);
    expect(outcome.document.parameters.map((parameter) => parameter.name)).toEqual([
      '穴径',
      'C',
      '板厚',
    ]);
    expect(parameterValue(outcome.document, '穴径')).toBe(6);
  });

  it('範囲の外の位置では何も変わらない', () => {
    const document = documentWith([param('A', '1'), param('B', '2')]);
    const outcome = commitReorderParameters(document, 0, 5);
    ok(outcome);
    expect(outcome.document.parameters.map((parameter) => parameter.name)).toEqual(['A', 'B']);
  });
});

// ---------------------------------------------------------------------------
// parameterRowsOf
// ---------------------------------------------------------------------------

describe('parameterRowsOf', () => {
  it('表の並び順のまま、名前・式・値・単位・説明を並べる', () => {
    const document = documentWith([{ ...param('板厚', '3'), description: '板の厚み' }]);
    const applied = commitAddParameter(document, draft('穴径', '板厚 * 2'));
    ok(applied);
    const rows = parameterRowsOf(applied.document, applied.analysis);
    expect(rows).toEqual([
      {
        name: '板厚',
        source: '3',
        value: 3,
        unit: 'mm',
        description: '板の厚み',
        circular: false,
        unused: false,
        failureMessage: null,
      },
      {
        name: '穴径',
        source: '板厚 * 2',
        value: 6,
        unit: 'mm',
        description: '',
        circular: false,
        unused: true,
        failureMessage: null,
      },
    ]);
  });

  it('循環している行には circular の印が付く', () => {
    // A = 'B + 1'、B = '1' から出発し、B を 'A + 1' へ書き換えて A ⇄ B の循環を作る。
    const document = documentWith([
      { ...param('A', '1'), value: { source: 'B + 1', value: 1, display: '1' } },
      param('B', '1'),
    ]);
    const applied = commitReplaceParameter(document, 'B', {
      value: { source: 'A + 1', value: 1, display: '1' },
    });
    ok(applied);
    expect(applied.analysis.circular.slice().sort()).toEqual(['A', 'B']);
    const rows = parameterRowsOf(applied.document, applied.analysis);
    expect(rows.filter((row) => row.circular).map((row) => row.name).sort()).toEqual(['A', 'B']);
  });

  it('評価できなかった行には failureMessage が付く', () => {
    const document = documentWith([{ ...param('A', '1'), value: { source: '未知 + 1', value: 1, display: '1' } }]);
    const applied = commitAddParameter(document, draft('板厚', '3'));
    ok(applied);
    const rows = parameterRowsOf(applied.document, applied.analysis);
    const row = rows.find((entry) => entry.name === 'A');
    expect(row?.failureMessage).not.toBeNull();
  });
});
