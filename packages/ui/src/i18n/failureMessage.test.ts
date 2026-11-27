import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateExpression, expressionValueFromNumber as num } from '@pointercad/expression';
import {
  absoluteCoordinate, buildResidualReport, CATALOG_ITEM_REJECTION_CODES, collectVariables,
  mathGeometryUnresolvedMessage, plainText, resolveSketch, SUB_ASSEMBLY_DEPTH_TEXT,
  variableComponentKey, WORK_PLANES, type FailureText, type SketchConstraint, type SketchDocument,
} from '@pointercad/model';
import { InputIssue } from '@pointercad/model/beam-analysis';
import { buildStandardPartFromSourceWithReason, steelMessageRejectionSourcesForUi } from '@pointercad/model/testing/ui-fixtures';
import { describe, expect, it } from 'vitest';

import { failureMessage, issueMessage, messageText, mixedFailureMessages } from './failureMessage.js';
import { MESSAGE_KEYS, t } from './t.js';

const modelSource = fileURLToPath(new URL('../../../model/src/', import.meta.url));

/** model の製品のコード(検査・検査用の補助を除く)の本文。 */
function modelProductSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'testing' ? [] : modelProductSources(path);
    return /\.tsx?$/u.test(entry.name) && !/\.(test|testSupport|spec|fixture|d)\./u.test(entry.name) ? [readFileSync(path, 'utf8')] : [];
  });
}

function collectKeys(text: FailureText, into: Set<string>): void {
  into.add(text.key);
  for (const value of Object.values(text.parameters)) if (typeof value !== 'string') collectKeys(value, into);
}

// residuals.test.ts の縮退事例と同じ要素・拘束・変数の配置を使う。
function collapsedSketchResiduals() {
  const point = (pointId: string) => ({ kind: 'point' as const, pointId });
  const curve = (featureId: string) => ({ kind: 'curve' as const, element: { featureId } });
  const a = curve('line-1');
  const b = curve('line-2');
  const p = point('point-1');
  const q = point('point-2');
  const circle = curve('circle-1');
  const otherCircle = curve('circle-2');
  const constraints: SketchConstraint[] = [
    { id: 'k1', name: '一致1', kind: 'coincident', a: p, b: q },
    { id: 'k2', name: '水平1', kind: 'horizontal', target: a },
    { id: 'k3', name: '垂直1', kind: 'vertical', target: a },
    { id: 'k4', name: '平行1', kind: 'parallel', a, b },
    { id: 'k5', name: '直角1', kind: 'perpendicular', a, b },
    { id: 'k6', name: '接線1', kind: 'tangent', line: a, circle },
    { id: 'k7', name: '同心1', kind: 'concentric', a: circle, b: otherCircle },
    { id: 'k8', name: '等しい1', kind: 'equal', a, b },
    { id: 'k9', name: '等しい2', kind: 'equal', a: circle, b: otherCircle },
    { id: 'k10', name: '対称1', kind: 'symmetric', a: p, b: q, axis: a.element },
    { id: 'k11', name: '距離1', kind: 'distance', a: p, b: q, length: num(10) },
    { id: 'k12', name: '角度1', kind: 'angle', a, b, angle: num(30) },
    { id: 'k13', name: '半径1', kind: 'radius', target: circle, size: num(8) },
    { id: 'k14', name: '直径1', kind: 'diameter', target: circle, size: num(20) },
    { id: 'k15', name: '固定1', kind: 'fix', target: point('point-3') },
  ];
  const document: SketchDocument = {
    id: 'sketch-1', name: 'スケッチ1', constraints,
    features: [
      { id: 'point-1', name: 'point-1', kind: 'point', planeId: 'xy', at: absoluteCoordinate(3, 4, 0) },
      { id: 'point-2', name: 'point-2', kind: 'point', planeId: 'xy', at: absoluteCoordinate(7, 1, 0) },
      { id: 'point-3', name: 'point-3', kind: 'point', planeId: 'xy', at: absoluteCoordinate(-5, -5, 0) },
      { id: 'line-1', name: 'line-1', kind: 'line', planeId: 'xy', construction: false,
        from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(6, 8, 0) },
      { id: 'line-2', name: 'line-2', kind: 'line', planeId: 'xy', construction: false,
        from: absoluteCoordinate(1, 2, 0), to: absoluteCoordinate(9, 4, 0) },
      { id: 'circle-1', name: 'circle-1', kind: 'arc', planeId: 'xy', construction: false,
        center: absoluteCoordinate(2, 3, 0), radius: num(5), startAngle: num(0), endAngle: num(360) },
      { id: 'circle-2', name: 'circle-2', kind: 'arc', planeId: 'xy', construction: false,
        center: absoluteCoordinate(11, -4, 0), radius: num(7), startAngle: num(0), endAngle: num(360) },
      { id: 'arc-1', name: 'arc-1', kind: 'arc', planeId: 'xy', construction: false,
        center: absoluteCoordinate(20, 0, 0), radius: num(4), startAngle: num(0), endAngle: num(90) },
    ],
  };
  const set = collectVariables(document, resolveSketch(document), WORK_PLANES.xy);
  const collapsed: Readonly<Record<string, number>> = {
    'line-1:end.u': 0, 'line-1:end.v': 0, 'line-2:end.u': 1, 'line-2:end.v': 2,
    'circle-1.r': 0, 'point-2.u': 3, 'point-2.v': 4,
  };
  const x = set.variables.map((variable, index) => collapsed[variableComponentKey(variable)] ?? set.initial[index]);
  return buildResidualReport(constraints, set, x);
}

describe('失敗の文の鍵と差し込む値から画面の文を作る(D4)', () => {
  it('縮退で見送った7件は、鍵へ移す前と同じ日本語で表示する', () => {
    const { skipped } = collapsedSketchResiduals();
    // 期待する全文は、鍵へ移す前の buildResidualReport が実際に返した文。
    expect(skipped.map(({ constraintId, text }) => [constraintId, failureMessage(text)])).toEqual([
      ['k4', '平行1は、長さ 0 の線分・重なった点・半径 0 の円には付けられません。'],
      ['k5', '直角1は、長さ 0 の線分・重なった点・半径 0 の円には付けられません。'],
      ['k6', '接線1は、長さ 0 の線分・重なった点・半径 0 の円には付けられません。'],
      ['k8', '等しい1は、長さ 0 の線分・重なった点・半径 0 の円には付けられません。'],
      ['k10', '対称1は、長さ 0 の線分・重なった点・半径 0 の円には付けられません。'],
      ['k11', '距離1は、長さ 0 の線分・重なった点・半径 0 の円には付けられません。'],
      ['k12', '角度1は、長さ 0 の線分・重なった点・半径 0 の円には付けられません。'],
    ]);
  });
  it('面とオフセットは理由を操作名で包み、旧応答と共通の内部エラーも表示する', () => {
    const show = (key: string, reason: FailureText) => failureMessage({ key, parameters: { reason } });
    expect(show('partError.sketchKernel.face', { key: 'partError.sketchFaceHole.outsideOuter',
      parameters: { label: { key: 'partError.sketchKernel.holeLabel', parameters: { index: '2' } } } }))
      .toBe('面を作れませんでした: 穴2が外周の外にはみ出しています。');
    expect(show('partError.sketchKernel.offset', { key: 'partError.sketchKernel.offsetInside', parameters: {} }))
      .toBe('ずらした線を作れませんでした: これ以上内側にはオフセットできません。');
    expect(show('partError.sketchKernel.face', plainText('旧応答 {index}')))
      .toBe('面を作れませんでした: 旧応答 {index}');
    expect(failureMessage({ key: 'assembly.error.internal', parameters: {} })).toBe('内部の誤りが起きました。');
  });

  it('鍵の文へ値を差し込み、値が鍵と値なら入れ子で作る', () => {
    expect(failureMessage(SUB_ASSEMBLY_DEPTH_TEXT)).toBe('組の入れ子が深すぎます(8 段まで)。');
    expect(failureMessage({ key: 'assembly.steel.rejection.pipe-outside-scope', parameters: {
      reason: { key: 'assembly.steel.reason.lightGaugeOutsideGrade', parameters: { grade: 'SS400' } },
      basis: 'JIS G 3350（一般構造用軽量形鋼） 表1 種類の記号（SSC400 の 1 種類）' } }))
      .toBe('SS400の軽量形鋼は扱わない。JIS G 3350（一般構造用軽量形鋼）の種類の記号はSSC400の1種類だけなので、軽量形鋼はSSC400で選ぶ。'
        + '（JIS G 3350（一般構造用軽量形鋼） 表1 種類の記号（SSC400 の 1 種類））');
    expect(mixedFailureMessages(['合致の断りの文', SUB_ASSEMBLY_DEPTH_TEXT])).toEqual(['合致の断りの文', '組の入れ子が深すぎます(8 段まで)。']);
  });

  it('値は 1 回で差し込み、値の中の波かっこを読み直さない。値の無い目印はそのまま残す(0b-3h2)', () => {
    // 前の置き換え(値ごとに split/join)では、先に入れた値の中の「{text}」「{index}」が、後の値に置き換わっていた。
    expect(failureMessage({ key: 'partError.numberedHole', parameters: { index: '{text}', text: '輪郭が開いています。' } }))
      .toBe('穴{text}: 輪郭が開いています。');
    expect(failureMessage({ key: 'partError.numberedHole',
      parameters: { text: { key: 'partError.plainText', parameters: { text: '{index} の式' } }, index: '2' } }))
      .toBe('穴2: {index} の式');
    expect(failureMessage({ key: 'partError.plainText', parameters: { text: '式 {a} と {text} を読めません' } }))
      .toBe('式 {a} と {text} を読めません');
    expect(failureMessage({ key: 'partError.numberedHole', parameters: { index: '3' } })).toBe('穴3: {text}');
  });

  it.each([
    ['partError.functionPoint.recomputeDeadline', '関数上の点の計算が時間内に終わりませんでした。もう一度計算してください。'],
    ['partError.functionPoint.recomputeIncomplete', '関数上の点を計算しきれませんでした。範囲と指定座標を確認してください。'],
    ['partError.functionPoint.recomputeUnconfirmed', '選択した関数上の点の追従を確認できません。候補を選び直してください。'],
  ])('関数上の点の再計算は既存の案内を表示する（%s）', (key, message) => {
    expect(failureMessage({ key, parameters: {} })).toBe(message);
  });

  it('数式の失敗の入れ子の鍵 3 つは、鍵へ移す前の文と 1 文字も違わない(0b-3h2)', () => {
    // 付録C の文(model の単体が文字で留めていた物。0b-3h2 で model は鍵と値を返すので、文はここで文字のまま留める)。
    expect(failureMessage(mathGeometryUnresolvedMessage('箱1体積', '幅B', plainText('参照先の形を正しく計算できませんでした。'))))
      .toBe('図形の測定値「箱1体積」を測れないため、係数「幅B」を計算できません: 参照先の形を正しく計算できませんでした。');
    // 座標の値が数でない基準点を測る数式の未解決の理由(mathGeometry.test.ts が鍵と値を留める)は、鍵へ移す前の model の文と同じ。
    expect(failureMessage({ key: 'partError.coordinate.notFinite', parameters: { label: 'X' } })).toBe('Xの値が数になっていません。');
    expect(failureMessage({ key: 'mathGeometry.error.unresolved', parameters: { definition: '幅', coefficient: 'a', reason: { key: 'partError.plainText', parameters: { text: '参照する現在の図形を確認できません。参照先を選び直してください。' } } } }))
      .toBe('図形の測定値「幅」を測れないため、係数「a」を計算できません: 参照する現在の図形を確認できません。参照先を選び直してください。');
    expect(failureMessage({ key: 'math.error.dependentCoefficient', parameters: { name: 'b', reason: { key: 'partError.plainText', parameters: { text: '係数の参照が循環しています。' } } } }))
      .toBe('参照する係数「b」を計算できません: 係数の参照が循環しています。');
    expect(failureMessage({ key: 'math.error.lines', parameters: { first: { key: 'partError.plainText', parameters: { text: '参照する現在の図形を確認できません。参照先を選び直してください。' } },
      rest: { key: 'math.error.lines', parameters: { first: { key: 'partError.plainText', parameters: { text: '係数の参照が循環しています。' } }, rest: { key: 'partError.plainText', parameters: { text: '係数の参照が循環しています。' } } } } } }))
      .toBe('参照する現在の図形を確認できません。参照先を選び直してください。\n係数の参照が循環しています。\n係数の参照が循環しています。');
  });

  it('鍵へ移した図形の測定値の誤りの文は、移す前の model の文と 1 文字も違わない(0b3h2-text-keys-measure)', () => {
    // 右の文は、道具が移す前の model の文字(定数・呼び出しの文字に同じ値を入れた物)から写した物(文言の表は読まない)。
    const cases: readonly (readonly [string, Readonly<Record<string, string>>, string])[] = [
      ['mathGeometry.error.missingReference', {}, '参照する現在の図形を確認できません。参照先を選び直してください。'],
      ['mathGeometry.error.unsupportedShape', {}, 'この種類の図形からは指定した量を求められません。'],
      ['mathGeometry.reason.ambiguous-reference', {}, '形が変わり、参照先を1つに決められません。選び直してください。'],
      ['mathGeometry.error.failedShape', {}, '参照先の形を正しく計算できませんでした。'],
      ['mathGeometry.error.failedFrame', {}, '参照先の座標系を正しく計算できませんでした。'],
      ['mathGeometry.error.frameAxes', {}, '座標系の原点と軸を正しく取得できませんでした。'],
      ['mathGeometry.error.arcDimensions', {}, '円弧の半径と中心角を正しく取得できませんでした。'],
      ['mathGeometry.error.profileLength', {}, '楕円や自由曲線を含む輪郭の長さには対応していません。'],
      ['mathGeometry.error.nonPlanarFace', {}, '平面でない面からは角度・平行・垂直を求められません。'],
      ['mathGeometry.error.invalidRequest', {}, '参照する文書・識別番号・許容差を確認してください。'],
      ['mathGeometry.error.nonFiniteValue', {}, '図形から有限で妥当な測定値を取得できませんでした。'],
      ['mathGeometry.error.congruence.invalidShape', {}, '合同・相似を比べる図形の寸法を正しく取得できませんでした。'],
      ['mathGeometry.error.congruence.degenerate', {}, '比べる幅以下の長さや退化した図形では合同・相似を判定できません。'],
      ['mathGeometry.error.congruence.duplicateEdges', {}, '同じ辺が重複した輪郭は比べられません。'],
      ['mathGeometry.error.congruence.branching', {}, '枝分かれした輪郭では合同・相似を判定できません。'],
      ['mathGeometry.error.congruence.notClosed', {}, '閉じた1つの多角形でない輪郭は比べられません。'],
      ['mathGeometry.error.congruence.tooFewSegments', {}, '多角形の比較には3本以上の線分で閉じた輪郭が必要です。'],
      ['mathGeometry.error.congruence.nonPlanar', {}, '同じ平面にない輪郭では多角形の合同・相似を判定できません。'],
      ['mathGeometry.error.congruence.selfIntersecting', {}, '交差したり重なったりする輪郭では多角形の合同・相似を判定できません。'],
      ['mathGeometry.error.congruence.invalidTolerance', {}, '合同・相似の比べる幅を確認してください。'],
      ['mathGeometry.error.congruence.edgeCountMismatch', {}, '辺の数が違う多角形どうしは比べられません。'],
      ['mathGeometry.error.congruence.unsupportedPair', {}, '線分どうし、円弧・円どうし、または同じ辺数の多角形どうしを選んでください。'],
      ['mathGeometry.error.referenceMismatch', { label: '箱1体積' }, '図形の測定値の参照先を確認できません: 箱1体積'],
      ['mathGeometry.error.booleanResult', { definitionName: '箱1体積' }, '平行・垂直などの判定の結果は係数の式に使えません: 箱1体積'],
      ['mathGeometry.error.discontinuousOperation', { operation: 'floor' }, '図形の測定値から計算する式では「floor」を使えません。値の境目で結果が変わる計算は使えません。'],
      ['mathGeometry.error.pending', { definitionName: '箱1体積' }, '図形の測定値「箱1体積」を計算中です。形の計算が終わると使えます。'],
      ['mathGeometry.error.outsideCoefficient', { label: '箱1体積' }, '図形の測定値は係数の式の中でだけ使えます: 箱1体積'],
      ['mathGeometry.error.cycle', { coefficient: '幅B', definition: '箱1体積', shape: '箱1' }, '係数「幅B」は図形の測定値「箱1体積」を使っていますが、その測る形「箱1」が「幅B」を使って作られているため循環しています。'],
      ['mathGeometry.error.order', { feature: '箱1', target: '箱2', definition: '箱2体積', coefficient: '幅B' }, '「箱1」は、後ろにある「箱2」を測った値（図形の測定値「箱2体積」）を係数「幅B」から使っています。「箱2」より後ろへ移してください。'],
      ['mathGeometry.error.tooDeep', { limit: '8' }, '図形の測定値を使う係数の連なりが上限（8段）を超えています。'],
    ];
    expect(cases.map(([key, parameters]) => failureMessage({ key, parameters }))).toEqual(cases.map(([, , before]) => before));
  });

  it('鍵へ移した数式の評価・名前の変更・関数の作図の誤りの文は、移す前の model の文と 1 文字も違わない(0b3h2-text-keys-part)', () => {
    // 右の文は、道具が移す前の model の文字(定数・呼び出しの文字に同じ値を入れた物)から写した物(文言の表は読まない)。
    const cases: readonly (readonly [string, Readonly<Record<string, string>>, string])[] = [
      ['math.error.invalidParameterName', {}, '係数の名前または参照先が不正・重複しています。'],
      ['math.error.definitionMismatch', {}, '保存された原式と数学定義が一致しません。'],
      ['math.error.circular', {}, '係数の参照が循環しています。'],
      ['math.error.geometryRename.cancelled', {}, '図形の測定値の名前の変更を中止しました。'],
      ['math.error.geometryRename.notFound', {}, '名前を変える図形の測定値がありません。'],
      ['math.error.geometryRename.invalidName', {}, '図形の測定値の新しい名前が不正、または既に使われています。'],
      ['math.error.geometryRename.unverifiedReference', {}, '保存された式の参照先を確認できません。'],
      ['math.error.geometryRename.rewriteFailed', {}, '数式の参照先を保った名前の変更ができませんでした。'],
      ['math.error.geometryRename.invalidDocument', {}, '名前を変えた文書を計算し直せませんでした。'],
      ['math.error.rename.cancelled', {}, '係数の改名を中止しました。'],
      ['math.error.rename.notFound', {}, '改名する係数がありません。'],
      ['math.error.rename.invalidName', {}, '係数の新しい名前が不正、または既に使われています。'],
      ['math.error.rename.unverifiedReference', {}, '係数の参照先を確認できません。'],
      ['math.error.rename.unverifiedStoredReference', {}, '保存された係数の参照先を確認できません。'],
      ['math.error.rename.rewriteFailed', {}, '数式の参照先を保った改名ができませんでした。'],
      ['math.error.rename.invalidDocument', {}, '係数を改名した文書を再計算できませんでした。'],
      ['math.error.needsMathEngine', {}, 'この数式は数学計算部での再計算が必要です。'],
      ['math.error.function.engineUnavailable', {}, '関数の計算部を準備できません。再計算してから作図してください。'],
      ['math.error.function.emptyCurve', {}, '指定したXYZの範囲に曲線がありません。'],
      ['math.error.referenceUnverified', { label: 'P' }, '係数の参照先を確認できません: P'],
      ['math.error.referenceUncomputable', { label: 'P' }, '参照する係数を計算できません: P'],
      ['math.error.calculationIncomplete', { status: 'invalid' }, '数式の計算を完了できませんでした: invalid'],
      ['math.error.stageFailed', {}, '数式の再計算を完了できませんでした。'],
    ];
    expect(cases.map(([key, parameters]) => failureMessage({ key, parameters }))).toEqual(cases.map(([, , before]) => before));
  });

  it('鍵が文言の表に無い時は、内部の鍵を出さず「内部の誤りが起きました。」にする', () => {
    expect(failureMessage({ key: 'no.such.key', parameters: {} })).toBe('内部の誤りが起きました。');
    expect(t('assembly.error.internal')).toBe('内部の誤りが起きました。');
  });

  it('model の製品のコードが返す失敗の文の鍵は、全部が文言の表にある(内部の誤りの文へ落ちない)', () => {
    const code = modelProductSources(modelSource).join('\n');
    const namespaces = '(?:assembly[.]error|assembly[.]steel[.]reason|assembly[.]steel[.]rejection|catalog[.]rejection|partError)';
    const literals = [...code.matchAll(new RegExp(`key: '(${namespaces}[.][A-Za-z0-9-]+)'`, 'gu'))].map((match) => match[1] ?? '');
    const templates = [...new Set([...code.matchAll(new RegExp('key: `(' + namespaces + '[.])[$][{]code[}]`', 'gu'))]
      .map((match) => match[1] ?? ''))].sort();
    expect(literals.length).toBeGreaterThan(0);
    // 符号で組む鍵は 2 つの形だけ。ほかの形を足した時は、ここで全部の符号を回す形を足す。
    expect(templates).toEqual(['assembly.steel.rejection.', 'catalog.rejection.']);
    const keys = new Set(literals);
    for (const code of CATALOG_ITEM_REJECTION_CODES) keys.add(`catalog.rejection.${code}`);
    const steelCodes = new Set<string>();
    for (const source of steelMessageRejectionSourcesForUi()) {
      const rejection = buildStandardPartFromSourceWithReason(source).rejection;
      if (rejection === null) continue;
      if (rejection.text.key.startsWith('assembly.steel.rejection.')) steelCodes.add(rejection.code);
      collectKeys(rejection.text, keys);
    }
    expect(steelCodes.size).toBe(11);
    expect([...keys].filter((key) => !MESSAGE_KEYS.some((candidate) => candidate === key))).toEqual([]);
  });

  it('梁の解析の断りの目印 {failures} へ、組立の誤りの文を鍵へ移す前と同じ並びと区切り(「; 」)で入れる', () => {
    // 鍵へ移す前の文は `CAD ${solved.reason} could not be solved: ${solved.messages.join('; ')}`(messages は日本語の文)。
    const before = 'CAD constraints could not be solved: 組の入れ子が深すぎます(8 段まで)。; 合致の断りの文';
    const issue = { code: 'unresolved-assembly', path: '$', message: 'CAD constraints could not be solved: {failures}',
      failures: [SUB_ASSEMBLY_DEPTH_TEXT, '合致の断りの文'] };
    expect(issueMessage(issue)).toBe(before);
    // 摩擦の道は fem が前置きを付けて投げ直す。前置きごと、目印の所だけが置き換わる。
    expect(issueMessage(new InputIssue('unresolved-assembly', '$', `friction-cad: unresolved-assembly at $: ${issue.message}`, issue.failures)))
      .toBe(`friction-cad: unresolved-assembly at $: ${before}`);
    expect(issueMessage(new Error('Axial bolt input could not be prepared'))).toBe('Axial bolt input could not be prepared');
    const changed = { code: 'changed-source', path: 'm1', message: 'Member size, options or source revisions changed' };
    expect(issueMessage(changed)).toBe('Member size, options or source revisions changed');
  });

  it('鍵と差し込む値の組の文(読めなかった理由の知らせ)は、値を入れた文。値の無い組は鍵の文のまま', () => {
    expect(messageText({ key: 'assembly.error.subAssemblyDepth', parameters: { max: '8' } })).toBe(failureMessage(SUB_ASSEMBLY_DEPTH_TEXT));
    expect(messageText({ key: 'assembly.error.subAssemblyDepth', parameters: { max: '8' } })).not.toContain('{max}');
    expect(messageText({ key: 'file.error.corrupted' })).toBe(t('file.error.corrupted'));
  });
});

describe('文字式から係数再計算へ伝わる診断', () => {
  it('鍵の日本語と位置、入力値、上限を表示する', () => {
    const legacy = evaluateExpression('Z+1');
    const diagnostic = legacy.ok ? undefined : legacy.error.diagnostic;
    expect(diagnostic === undefined ? null : failureMessage(diagnostic)).toBe('決まっていない名前です: 「Z」(1 文字目)');
    expect(failureMessage({ key: 'math.input.unsupportedFunction', parameters: { name: 'NoSuchFn', position: '1' } }))
      .toBe('関数「NoSuchFn」を確認してください。係数はcoef("名前")で挿入します（1文字目）。');
    expect(failureMessage({ key: 'math.input.decimalExponent', parameters: { value: '10001', limit: '10000' } }))
      .toBe('指数が大きすぎます（入力 10001、絶対値の上限 10000）。');
    expect(failureMessage({ key: 'assembly.error.internal', parameters: {} }))
      .toBe('内部の誤りが起きました。');
  });
});
