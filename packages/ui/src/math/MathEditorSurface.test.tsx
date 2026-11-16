import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MathEditorSurface, type MathEditorViewController, type MathInsertGroup } from './MathEditorSurface.js';
import { mathEditorLabels } from './mathEditorLabels.js';

const textInput = { identity: { documentId: 'part', documentVersion: 1, editorId: 'editor', inputRevision: 1 },
  source: 'erf(1/7)', notation: 'text' as const, angleUnit: 'radian' as const };
const controller: MathEditorViewController = {
  current: () => textInput, isCurrent: () => true, sourceChanged: () => {}, apply: () => {}, cancel: () => {},
  sourceLimit: () => {}, moveOut: () => {}, bindInsertion: () => () => {}, insert: () => {},
  requestNotation: () => {}, changeAngleUnit: () => {},
};
const groups: readonly MathInsertGroup[] = [
  { id: 'coefficients', label: '係数（名前を付けた値）', choices: [] },
  { id: 'constants', label: '定数', choices: [{ id: 'pi', label: 'π', meaning: '円周率', template: 'pi' }] },
];
const base = { input: textInput, controller, createField: () => { throw new Error('静的描画では構造欄を作らない'); },
  labels: mathEditorLabels(), groups, palette: [], query: '', onQuery: () => {},
  resultMessage: '= 6', resultDetail: '', hasError: false, busy: false, canApply: true,
  canChangeNotation: true, readOnly: false, onHelp: () => {}, maximumSourceLength: 1000 };
const render = (props: Partial<Parameters<typeof MathEditorSurface>[0]>) =>
  renderToStaticMarkup(createElement(MathEditorSurface, { ...base, ...props }));

describe('「数式を編集」の窓の読みやすさ(UI の点検の指摘 36)', () => {
  it('窓の題と同じ見出しを中で繰り返さず、領域の名前だけに使う', () => {
    const markup = render({});
    expect(markup).not.toContain('<h3');
    expect(markup).toContain('<section class="pcad-math-editor" aria-label="数式を編集">');
  });

  it('空の挿入の枠には「まだありません」を出し、中身のある枠には出さない', () => {
    const markup = render({});
    expect(markup).toContain('<legend>係数（名前を付けた値）</legend><p class="pcad-math-editor__empty">まだありません</p>');
    expect(markup.match(/まだありません/gu)?.length).toBe(1);
  });

  it('丸めた結果の全部の桁は、畳んだ details と summary に置き、キーボードと読み上げで開ける', () => {
    const markup = render({ resultMessage: '≈ 0.157299', resultFull: '= 0.1572992070502851306587793649173907407039' });
    expect(markup).toContain('<p>≈ 0.157299</p>');
    expect(markup).toMatch(/<details class="pcad-math-editor__full"><summary>全部の桁<\/summary><p class="pcad-math-editor__full-value">= 0\.1572992070502851306587793649173907407039<\/p><\/details>/u);
    expect(markup).not.toMatch(/<details[^>]*open/u);
    expect(markup).not.toMatch(/<summary[^>]*(tabindex="-1"|aria-hidden)/u);
    expect(render({ resultMessage: '= 6', resultFull: '' })).not.toContain('pcad-math-editor__full');
  });

  it('「この式を使う」が使えない時は、理由をボタンの直前に 1 行で出し、使える時は出さない', () => {
    const reason = 'この欄には一意に決まる実数が必要です。式と条件を確認してください。';
    const markup = render({ canApply: false, applyBlockedReason: reason });
    expect(markup).toMatch(new RegExp(`<p class="pcad-math-editor__apply-reason">${reason}</p><button[^>]*disabled`, 'u'));
    expect(render({ canApply: true, applyBlockedReason: reason })).not.toContain('pcad-math-editor__apply-reason');
    expect(render({ canApply: false })).not.toContain('pcad-math-editor__apply-reason');
  });
});

describe('計算中も前の結果を薄く残す(外部検査 run 43803122461 の調べ、統括の決定)', () => {
  const previous = { resultMessage: '≈ 1.85407', resultDetail: '誤差の上限: 1e-12', resultFull: '= 1.8540746773013719184',
    canApply: false, applyBlockedReason: '数の欄には実数の値が要ります。' };
  /** 結果の欄(role=status)の中身。 */
  const status = (markup: string) => /<div id="[^"]*-message" class="pcad-math-editor__result[^"]*"[^>]*>([\s\S]*?)<\/div>/u.exec(markup)?.[1] ?? '';
  /** 欄の見えている行(1 行目・説明・全部の桁)の数。畳んだ details は summary の 1 行と数える(中の値の行は見えない)。 */
  const rows = (inner: string) => (inner.replace(/<details[\s\S]*?<\/details>/gu, '<details>').match(/<p[ >]|<details>/gu) ?? []).length;
  const text = (inner: string) => inner.replace(/<[^>]+>/gu, '');
  it('前の結果を残す時は、同じ数の行を、文字を持たない影(data-text と aria-hidden)として置き、計算中と分かる印を付ける', () => {
    const settled = render(previous), stale = render({ ...previous, resultStale: true });
    expect(stale).toContain('pcad-math-editor__result pcad-math-editor__result--stale');
    expect(stale).toContain('aria-busy="true"');
    expect(stale).toContain('<span class="pcad-math-editor__stale">数式を計算しています。</span>');
    expect(stale).toContain('data-text="≈ 1.85407" aria-hidden="true"');
    expect(stale).toContain('data-text="誤差の上限: 1e-12" aria-hidden="true"');
    expect(stale).toContain('<p class="pcad-math-editor__apply-reason pcad-math-editor__shadow" data-text="数の欄には実数の値が要ります。" aria-hidden="true">');
    // 行の数が同じ(高さが変わらない)。
    expect(rows(status(stale))).toBe(rows(status(settled)));
  });

  it('前の結果を残す間、欄の文字(読み上げと検査が読む文字)は「計算中」だけで、古い値と全部の桁を持たない', () => {
    const inner = status(render({ ...previous, resultStale: true }));
    expect(text(inner)).toBe('数式を計算しています。');
    expect(inner).not.toContain('pcad-math-editor__full-value');
    expect(inner).not.toContain('1.85407</');
  });

  it('前の結果を残さない時は印を付けない', () => {
    const markup = render(previous);
    expect(markup).not.toContain('pcad-math-editor__stale');
    expect(markup).not.toContain('pcad-math-editor__result--stale');
  });
});
