import { createElement, type FocusEvent, type InputHTMLAttributes } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExpressionField } from './ExpressionField.js';
import { createNumericInput, evaluateNumericInput, reduceNumericInput, type NumericInputState } from './numericInput.js';
import { useAppStore } from '../store/useAppStore.js';
import { t, type MessageKey } from '../i18n/t.js';
import type * as ImportedJsxRuntimeTypes from 'react/jsx-runtime';
import type * as ImportedJsxDevRuntimeTypes from 'react/jsx-dev-runtime';

// 欄の input に渡した props(value と焦点・変更の手)を、描画の中から拾う。
const rendered = vi.hoisted(() => ({ inputs: [] as InputHTMLAttributes<HTMLInputElement>[] }));
vi.mock('react/jsx-runtime', async importOriginal => {
  const runtime = await importOriginal<typeof ImportedJsxRuntimeTypes>();
  const capture = (factory: typeof runtime.jsx): typeof runtime.jsx => (type, props, key) => {
    if (type === 'input') rendered.inputs.push(props as InputHTMLAttributes<HTMLInputElement>);
    return factory(type, props, key);
  };
  return { ...runtime, jsx: capture(runtime.jsx), jsxs: capture(runtime.jsxs) };
});
vi.mock('react/jsx-dev-runtime', async importOriginal => {
  const runtime = await importOriginal<typeof ImportedJsxDevRuntimeTypes>();
  const jsxDEV: typeof runtime.jsxDEV = (type, props, key, isStatic, source, self) => {
    if (type === 'input') rendered.inputs.push(props as InputHTMLAttributes<HTMLInputElement>);
    return runtime.jsxDEV(type, props, key, isStatic, source, self);
  };
  return { ...runtime, jsxDEV };
});
afterEach(() => { rendered.inputs = []; });

function render(state: NumericInputState): string {
  const result = evaluateNumericInput(state, new Map(), { lengthUnit: 'inch' });
  return renderToStaticMarkup(createElement(ExpressionField, {
    field: state.fields[0], result: result.results[0], lengthUnit: 'inch', focused: false,
    onChange: () => {}, onFocus: () => {},
  }));
}

describe('数値欄の原式と単位表示', () => {
  it('設定由来の25.4mmと、手入力した1inchを正しい札と同じ評価値で表示する(焦点の無い間は重ねた表示で 1 in。指摘 45)', () => {
    const configured = createNumericInput('circle', 'circleRadius', 'absolute', {
      defaultSources: { 'circleRadius/absolute/radius': '25.4' },
    });
    const configuredMarkup = render(configured);
    // 欄の値と札は中身(内部 mm の 25.4)のまま。焦点の無い間だけ、重ねた表示が表示の単位 inch の 1 in を見せる。
    expect(configuredMarkup).toContain('value="25.4"');
    expect(configuredMarkup).toContain('class="pcad-field__unit">mm</span>');
    expect(configuredMarkup).toContain('<span class="pcad-field__resting" aria-hidden="true">1 in</span>');
    expect(configuredMarkup).toContain('pcad-field--resting-unit');
    expect(configuredMarkup).toContain('= 1 in');
    const typed = reduceNumericInput(configured, { type: 'edit', index: 0, source: '1' });
    const typedMarkup = render(typed);
    expect(typedMarkup).toContain('value="1"');
    expect(typedMarkup).toContain('class="pcad-field__unit">in</span>');
    expect(typedMarkup).toContain('= 1 in');
    expect(configured.fields[0].source).toBe('25.4');
  });

  it('空欄へ戻すとmmの初期値を使い、クリックで入った座標もmmと表示する', () => {
    const configured = createNumericInput('point', 'point', 'absolute', {
      defaultSources: { 'point/absolute/x': '25.4' },
    });
    const blank = render(reduceNumericInput(configured, { type: 'edit', index: 0, source: '' }));
    expect(blank).toContain('class="pcad-field__unit">mm</span>'); expect(blank).toContain('= 1 in');
    const clicked = render(reduceNumericInput(configured, { type: 'setValues', values: [50.8, 0, 0] }));
    expect(clicked).toContain('value="50.8"');
    expect(clicked).toContain('class="pcad-field__unit">mm</span>'); expect(clicked).toContain('= 2 in');
    expect(clicked).toContain('<span class="pcad-field__resting" aria-hidden="true">2 in</span>');
  });

  it('分数インチで打った長さは、欄の下に小数と分数インチを並べて出す(FR-814)', () => {
    const typed = reduceNumericInput(createNumericInput('circle', 'circleRadius', 'absolute'),
      { type: 'edit', index: 0, source: '3/8"' });
    const markup = render(typed);
    expect(markup).toContain('value="3/8&quot;"');
    expect(markup).toContain('= 0.375 in (3/8&quot;)');
    expect(typed.fields[0].source).toBe('3/8"');
  });

  it('焦点のある入力だけ原式の明示単位を案内し、評価と保存sourceを変えない', () => {
    const before = useAppStore.getState();
    const typed = reduceNumericInput(createNumericInput('circle', 'circleRadius', 'absolute'),
      { type: 'edit', index: 0, source: '1in*2' });
    const evaluated = evaluateNumericInput(typed, new Map(), { lengthUnit: 'inch' });
    const markup = renderToStaticMarkup(createElement(ExpressionField, {
      field: typed.fields[0], result: evaluated.results[0], lengthUnit: 'inch', focused: true,
      onChange: () => {}, onFocus: () => {},
    }));
    expect(markup).toContain('value="1in*2"');
    expect(markup).toContain('式に書かれた単位: in');
    expect(evaluated.results[0].value?.value).toBe(50.8);
    expect(typed.fields[0].source).toBe('1in*2');
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
  });
});

function renderMm(source: string, focused = false, label?: MessageKey): string {
  const state = reduceNumericInput(createNumericInput('circle', 'circleRadius', 'absolute'), { type: 'edit', index: 0, source });
  const result = evaluateNumericInput(state, new Map(), { lengthUnit: 'mm' });
  const field = label === undefined ? state.fields[0] : { ...state.fields[0], labelKey: label };
  return renderToStaticMarkup(createElement(ExpressionField, {
    field, result: result.results[0], lengthUnit: 'mm', focused, onChange: () => {}, onFocus: () => {},
  }));
}

describe('数だけの欄に重ねる 6 桁の見せ方(UI の点検の指摘 26・48・3)', () => {
  it('焦点の無い数だけの欄は、欄の値を変えずに有効 6 桁を重ね、許容差以内は 0 を重ねる', () => {
    const long = renderMm('4.917468245269452');
    expect(long).toContain('value="4.917468245269452"');
    expect(long).toContain('<span class="pcad-field__resting" aria-hidden="true">4.91747</span>');
    expect(long).toContain('>= 4.91747</p>');
    expect(long).toContain('title="= 4.91746824527"');
    const tiny = renderMm('0.00000000000000091848');
    expect(tiny).toContain('value="0.00000000000000091848"');
    expect(tiny).toContain('<span class="pcad-field__resting" aria-hidden="true">0</span>');
  });

  it('焦点のある欄・式の欄・見せ方が中身と同じ短い数には重ねない', () => {
    expect(renderMm('4.917468245269452', true)).not.toContain('pcad-field__resting');
    expect(renderMm('10*2')).not.toContain('pcad-field__resting');
    expect(renderMm('12.5')).not.toContain('pcad-field__resting');
  });

  it('7 字以上の名前の欄だけ、名前を欄の上の行に置く', () => {
    expect(renderMm('1')).not.toContain('pcad-field--stacked');
    expect([...t('propertyPanel.repair.original')].length).toBeGreaterThanOrEqual(7);
    expect(renderMm('1', false, 'propertyPanel.repair.original')).toContain('class="pcad-field pcad-field--stacked"');
  });
});

describe('焦点の無い欄の見せ方は、利用者の値を 1 ビットも変えない(UI の点検の指摘 26・48、統括の決定 4)', () => {
  it('入る・確定するだけでは onChange を呼ばず、欄の値・中身・確定する値は全部の桁のまま', () => {
    const source = '4.917468245269452';
    const state = reduceNumericInput(createNumericInput('circle', 'circleRadius', 'absolute'), { type: 'edit', index: 0, source });
    const snapshot = JSON.stringify(state);
    const result = evaluateNumericInput(state, new Map(), { lengthUnit: 'mm' });
    const changes: string[] = [];
    let focuses = 0;
    const markup = renderToStaticMarkup(createElement(ExpressionField, {
      field: state.fields[0], result: result.results[0], lengthUnit: 'mm', focused: false,
      onChange: (next: string) => { changes.push(next); }, onFocus: () => { focuses += 1; },
    }));
    // 見せるのは重ねた表示だけ。欄の値(打つ・読む対象)は全部の桁。
    expect(markup).toContain('>4.91747</span>');
    const input = rendered.inputs[0];
    expect(input.value).toBe(source);
    input.onFocus?.({} as FocusEvent<HTMLInputElement>);
    expect(focuses).toBe(1);
    expect(changes).toEqual([]);
    // 確定(Enter)は状態機械の中身から作るので、確定する値は丸めた 4.91747 ではなく全部の桁。
    expect(JSON.stringify(state)).toBe(snapshot);
    expect(state.fields[0].source).toBe(source);
    expect(result.results[0].value?.value).toBe(Number(source));
  });
});
