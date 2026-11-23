import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG_ITEM_REJECTION_CODES, SUB_ASSEMBLY_DEPTH_TEXT, mathGeometryUnresolvedMessage, plainText, type FailureText } from '@pointercad/model';
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

describe('失敗の文の鍵と差し込む値から画面の文を作る(D4)', () => {
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
