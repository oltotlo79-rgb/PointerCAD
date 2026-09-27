import { describe, expect, it } from 'vitest';
import { isIdentifierPart } from '../tokenize.js';
import { mathLatexLabel } from './mathLatexLabel.js';
import { legacyDefinitionToLatex } from './legacyMathLatex.js';
import { parseMathLatex } from './parseMathLatex.js';
import { serializeMathLatex } from './serializeMathLatex.js';

describe('名前欄で使える日本語の記号を数式の係数表示にも保持する', () => {
  it.each(['Gamma・Beta分布の値', '幅_1', '板゠厚', 'かな゛幅', 'カタカナヽ幅'])('%sを挿入・構造表示から同じ係数名へ戻す', label => {
    const expected = ['PcadCoefficient', { str: label }];
    const legacy = legacyDefinitionToLatex({ kind: 'symbol', reference: { role: 'coefficient', id: 'value', label } });
    expect(parseMathLatex(legacy)).toEqual(expected);
    const displayed = serializeMathLatex(['PcadCoefficient', { str: label }]);
    expect(parseMathLatex(displayed)).toEqual(expected);
  });
  it('既存の識別子が許す全文字を、表示用の別規則で拒否しない', () => {
    const rejected: string[] = [];
    for (let code = 0; code <= 0xffff; code += 1) {
      const character = String.fromCharCode(code);
      if (!isIdentifierPart(character)) continue;
      try { mathLatexLabel('幅' + character); } catch { rejected.push(character); }
    }
    expect(rejected).toEqual([]);
  });
  it.each(['', '幅'.repeat(129), '幅{a}', String.raw`幅\input`, '幅%', '幅#', '幅&', '幅$', '幅\n値', '幅\u202e値'])('%sの命令・制御文字・長さ制限は緩めない', label => {
    expect(() => mathLatexLabel(label)).toThrow();
    expect(() => legacyDefinitionToLatex({ kind: 'symbol', reference: { role: 'coefficient', id: 'value', label } })).toThrow();
    expect(() => serializeMathLatex(['PcadCoefficient', { str: label }])).toThrow();
  });
});
