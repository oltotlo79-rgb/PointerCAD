import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ExpressionField } from './ExpressionField.js';
import { createNumericInput, evaluateNumericInput, reduceNumericInput, type NumericInputState } from './numericInput.js';

function render(state: NumericInputState): string {
  const result = evaluateNumericInput(state, new Map(), { lengthUnit: 'inch' });
  return renderToStaticMarkup(createElement(ExpressionField, {
    field: state.fields[0], result: result.results[0], lengthUnit: 'inch', focused: false,
    onChange: () => {}, onFocus: () => {},
  }));
}

describe('数値欄の原式と単位表示', () => {
  it('設定由来の25.4mmと、手入力した1inchを正しい札と同じ評価値で表示する', () => {
    const configured = createNumericInput('circle', 'circleRadius', 'absolute', {
      defaultSources: { 'circleRadius/absolute/radius': '25.4' },
    });
    const configuredMarkup = render(configured);
    expect(configuredMarkup).toContain('value="25.4"');
    expect(configuredMarkup).toContain('class="pcad-field__unit">mm</span>');
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
  });
});
