import { analyzeParameters, type Parameter } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { parameterFields } from './parameterFields.js';

function parameter(name: string, source: string): Parameter {
  return { name, value: { source, value: 99, display: '99' }, unit: 'none', description: '' };
}

const analysis = analyzeParameters([
  parameter('a', '0'), parameter('板厚', 'a + 2.5'), parameter('自己', '自己'),
  parameter('微差', '0.10000000000000001'),
], []);

describe('図面の係数の差し込み', () => {
  it('元の部品の式を解いた値からゼロ・日本語名・隣接した欄を表示する', () => {
    expect(parameterFields('厚さ {=板厚} mm\n{=a}{=板厚}', analysis))
      .toEqual({ text: '厚さ 2.5 mm\n02.5', unresolved: [] });
  });

  it('値は画面の数の表示と同じ有効 6 桁(全部の桁は出さない)', () => {
    expect(parameterFields('{=微差}', analysis)).toEqual({ text: '0.1', unresolved: [] });
    const third = analyzeParameters([parameter('三分の一', '1 / 3'), parameter('大', '123456789')], []);
    expect(parameterFields('{=三分の一} {=大}', third)).toEqual({ text: '0.333333 123457000', unresolved: [] });
  });

  it('解けない欄を原文に残し、空名・未知・循環を最初の出現順に一度ずつ返す', () => {
    expect(parameterFields('{=無}{=}{=無}/{=自己}/{=a}', analysis))
      .toEqual({ text: '{=無}{=}{=無}/{=自己}/0', unresolved: ['無', '', '自己'] });
  });

  it('印を渡すと解けない欄だけを印にし、逃がした括弧と入れ子の欄は原文のまま', () => {
    expect(parameterFields('{=無}{{=無}{=外{=a}}{=a}', analysis, '？'))
      .toEqual({ text: '？{=無}{=外{=a}}0', unresolved: ['無'] });
  });

  it.each([
    ['{{', '{'], ['{{=a}', '{=a}'], ['{{{=a}', '{0'], ['{{{{', '{{'],
    ['', ''], ['{a} }', '{a} }'], ['前{=a}後{=未完', '前0後{=未完'],
    ['{=外{=a}{=無}}{=板厚}', '{=外{=a}{=無}}2.5'],
  ])('原文「%s」の括弧を一度だけ読む', (source, text) => {
    expect(parameterFields(source, analysis)).toEqual({ text, unresolved: [] });
  });
});
