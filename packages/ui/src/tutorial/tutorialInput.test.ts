import { describe, expect, it } from 'vitest';
import { createNumericInput, nextNumericInput, reduceNumericInput } from '../sketch/numericInput.js';
import { parameterNumericDraft, parameterTutorialInput, restoreParameterNumericDraft, tutorialInput } from './tutorialInput.js';

describe('案内の入力だけを一回で終え、通常の連続作図と打ちかけを保つ', () => {
  it('点は一回で閉じ、通常の点は連続作図の設定に従う', () => {
    const point = tutorialInput('point');
    if (point === null) throw new Error('point input missing');
    expect(nextNumericInput(point, true)).toBeNull();
    expect(nextNumericInput(createNumericInput('point', 'point'), true)?.step).toBe('point');
  });
  it('輪郭の二つ目の角まで進み、確定後に余分な輪郭を開始しない', () => {
    const first = tutorialInput('outline');
    if (first === null) throw new Error('rectangle input missing');
    const second = nextNumericInput(first, true);
    if (second === null) throw new Error('second corner missing');
    expect(second.step).toBe('rectangleCorner2');
    expect(second.fields.map(field => field.source)).toEqual(['60mm', '40mm', '0mm']);
    expect(nextNumericInput(second, true)).toBeNull();
  });
  it('案内の初期値は通常設定へ書かず、編集した値を保持する', () => {
    const input = tutorialInput('extrude');
    if (input === null) throw new Error('extrude input missing');
    const edited = reduceNumericInput(input, { type: 'edit', index: 0, source: '12mm' });
    expect(edited.fields[0].source).toBe('12mm');
    expect(tutorialInput('extrude')?.fields[0].source).toBe('8mm');
    expect(createNumericInput('extrude', 'extrudeDistance').fields[0].source).toBe('10');
  });
  it('穴は直径10mmの貫通で始める', () => {
    const input = tutorialInput('hole');
    expect(input?.fields.find(field => field.key === 'diameter')?.source).toBe('10mm');
    expect(input?.toggles.find(toggle => toggle.key === 'through')?.value).toBe(true);
  });
});

describe('パラメータ化する案内は通常の数値入力を使う', () => {
  it('同じ座標・輪郭の入力欄を使い、押出し原式だけを板厚名へ結び付ける', () => {
    const point = parameterTutorialInput('pointCoordinates');
    const outline = parameterTutorialInput('outline');
    const extrude = parameterTutorialInput('extrude');
    expect(point.fields.map(field => field.source)).toEqual(['0mm', '0mm', '0mm']);
    expect(outline.fields.map(field => field.source)).toEqual(['-30mm', '-20mm', '0mm']);
    expect(extrude.fields.map(field => field.source)).toEqual(['板厚']);
    expect(extrude.repeatAfterCommit).toBe(false);
    expect(tutorialInput('extrude')?.fields.map(field => field.source)).toEqual(['8mm']);
  });
  it('通常の矩形第1角から第2角へ進んでも両段の全原式と焦点を復元する', () => {
    let first = parameterTutorialInput('outline');
    for (const [index, source] of ['-31mm', '-21mm', '1mm'].entries()) {
      first = reduceNumericInput(first, { type: 'edit', index, source });
    }
    first = reduceNumericInput(first, { type: 'focus', index: 1 });
    let second = nextNumericInput(first, true);
    if (second === null) throw new Error('second corner missing');
    for (const [index, source] of ['61mm', '41mm', '0mm'].entries()) {
      second = reduceNumericInput(second, { type: 'edit', index, source });
    }
    const draft = parameterNumericDraft(second, first);
    if (draft?.kind !== 'numeric') throw new Error('numeric draft missing');
    expect(draft.previousStage?.fields.map(field => field.source)).toEqual(['-31mm', '-21mm', '1mm']);
    expect(draft.previousStage?.focusedKey).toBe(first.fields[1]?.key);
    expect(draft.fields.map(field => field.source)).toEqual(['61mm', '41mm', '0mm']);
    expect(restoreParameterNumericDraft(draft, true)?.fields.map(field => field.source))
      .toEqual(['-31mm', '-21mm', '1mm']);
    expect(restoreParameterNumericDraft(draft)?.fields.map(field => field.source))
      .toEqual(['61mm', '41mm', '0mm']);
  });
});
