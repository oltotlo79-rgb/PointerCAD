import { describe, expect, it } from 'vitest';
import type { StoredMathExpression } from '@pointercad/expression';

import { parseParameterCsv, serializeParameterCsv, PARAMETER_CSV_MAX_BYTES } from './parameterCsv.js';
import type { Parameter } from './types.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const row = (name: string, source: string, description: string): Parameter => ({
  name, value: { source, value: 123, display: '123' }, unit: 'mm', description,
});

describe('parameter CSV codec', () => {
  it('round trips 100 Japanese expressions and descriptions containing commas, quotes and line breaks', () => {
    const original = Array.from({ length: 100 }, (_, i) => row(`板厚${i}`,
      i === 0 ? '1in' : i === 1 ? 'root(8,3)' : '板厚0*2',
      `説明${i},「板」${i === 0 ? '\r\n' : '\n'}次の行 "引用"`));
    const encoded = serializeParameterCsv(original);
    const result = parseParameterCsv(encoded);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records.map(record => [record.name, record.expression, record.unit, record.description])).toEqual(
      original.map(parameter => [parameter.name, parameter.value.source, parameter.unit, parameter.description]));
    expect(new TextDecoder().decode(encoded)).not.toContain('123');
  });

  it('accepts BOM and CRLF while refusing 1001 data rows and 1MiB plus one byte', () => {
    const one = 'name,expression,unit,description\r\nA,1,mm,説明\r\n';
    expect(parseParameterCsv(bytes(`\uFEFF${one}`))).toMatchObject({ ok: true });
    const thousand = `name,expression,unit,description\r\n${'A,1,mm,\r\n'.repeat(1_000)}`;
    expect(parseParameterCsv(bytes(thousand))).toMatchObject({ ok: true });
    expect(parseParameterCsv(bytes(`${thousand}A,1,mm,\r\n`))).toMatchObject({ ok: false });
    const prefix = 'name,expression,unit,description\r\nA,1,mm,';
    const suffix = '\r\n';
    const exact = bytes(prefix + 'x'.repeat(PARAMETER_CSV_MAX_BYTES - bytes(prefix + suffix).byteLength) + suffix);
    expect(exact.byteLength).toBe(PARAMETER_CSV_MAX_BYTES);
    expect(parseParameterCsv(exact)).toMatchObject({ ok: true });
    expect(parseParameterCsv(new Uint8Array(PARAMETER_CSV_MAX_BYTES + 1))).toMatchObject({
      ok: false, diagnostics: [{ recordNumber: 0 }],
    });
    const exportOverhead = serializeParameterCsv([row('A', '1', '')]).byteLength;
    const descriptionLength = PARAMETER_CSV_MAX_BYTES - exportOverhead;
    expect(serializeParameterCsv([row('A', '1', 'x'.repeat(descriptionLength))]).byteLength)
      .toBe(PARAMETER_CSV_MAX_BYTES);
    expect(() => serializeParameterCsv([row('A', '1', 'x'.repeat(descriptionLength + 1))])).toThrow();
  });

  it('returns diagnostics for malformed quoting, units and math identity', () => {
    expect(parseParameterCsv(bytes('name,expression,unit,description\nA,"unterminated,mm,x'))).toMatchObject({ ok: false });
    expect(parseParameterCsv(bytes('name,expression,unit,description\nA,1,inch,x\n'))).toMatchObject({
      ok: false, diagnostics: [{ column: 'unit' }],
    });
    expect(parseParameterCsv(bytes('name,expression,unit,description,unknown\nA,1,mm,x,y\n'))).toMatchObject({ ok: false });
    const math = 'name,expression,unit,description,mathDefinition,mathId\n';
    expect(parseParameterCsv(bytes(`${math}A,1,mm,,{},coefficient:1\nB,2,none,,,coefficient:1\n`))).toMatchObject({ ok: false });
    expect(parseParameterCsv(bytes(`${math}A,1,mm,,"{""format"":""future""}",coefficient:1\n`))).toMatchObject({ ok: false });
  });

  it('accepts optional math identity columns independently and rejects duplicate headings', () => {
    const idOnly = 'name,expression,unit,description,mathId\nA,2,mm,説明,coefficient:1\n';
    expect(parseParameterCsv(bytes(idOnly))).toMatchObject({ ok: true,
      records: [{ name: 'A', mathId: 'coefficient:1' }] });
    const reversed = 'name,expression,unit,description,mathId,mathDefinition\nA,2,mm,,coefficient:1,\n';
    expect(parseParameterCsv(bytes(reversed))).toMatchObject({ ok: true });
    const duplicate = 'name,expression,unit,description,mathId,mathId\nA,2,mm,,coefficient:1,coefficient:1\n';
    expect(parseParameterCsv(bytes(duplicate))).toMatchObject({ ok: false });
  });

  it('keeps the six-column mathematical identity and original source', () => {
    const definition: StoredMathExpression = { format: 'pointercad-math/1', source: '2', inputNotation: 'text',
      angleUnit: 'degree', expression: { kind: 'number', decimal: '2' } };
    const original: Parameter[] = [{ ...row('半径', '2', '数学の係数'), mathId: 'coefficient:1',
      value: { source: '2', value: 2, display: '2', mathDefinition: definition } }];
    const encoded = serializeParameterCsv(original);
    const parsed = parseParameterCsv(encoded);
    expect(parsed).toMatchObject({ ok: true, records: [{ mathId: 'coefficient:1', mathDefinition: definition }] });
    const mismatched = new TextDecoder().decode(encoded).replace('半径,2,', '半径,3,');
    expect(parseParameterCsv(bytes(mismatched))).toMatchObject({ ok: false });
  });

  it('does not export an empty or mathematically unbound table', () => {
    expect(() => serializeParameterCsv([])).toThrow();
    expect(() => serializeParameterCsv([{ ...row('A', '2', ''), value: {
      source: '2', value: 2, display: '2', mathDefinition: {
        format: 'pointercad-math/1', source: '2', inputNotation: 'text', angleUnit: 'degree',
        expression: { kind: 'number', decimal: '2' },
      },
    } }])).toThrow();
    expect(() => serializeParameterCsv([{
      ...row('A', 'coef("B")', ''), mathId: 'coefficient:1',
      value: { source: 'coef("B")', value: 0, display: '0', mathDefinition: {
        format: 'pointercad-math/1', source: 'coef("B")', inputNotation: 'text', angleUnit: 'degree',
        expression: { kind: 'symbol', reference: { role: 'coefficient', id: 'coefficient:2', label: 'B' } },
      } },
    }])).toThrow();
  });

  it('escapes hostile prefixes with UTF-8 BOM without changing ordinary text or standalone negative numbers', () => {
    const controls = [String.fromCharCode(9), String.fromCharCode(13), String.fromCharCode(10), ' '];
    const hostile = ['=HYPERLINK("https://example.invalid","外部")', '+1+2', '-SUM(1,2)', '@SUM(1,2)',
      ...controls.map(prefix => prefix + '=1+1'), 'text:already-prefixed', '-1+2', '-1e2+3', '-1;2', '-Infinity', '-2\n', '-2 ',
      String.fromCharCode(0xff1d) + '1+1', String.fromCharCode(0x200b) + '=1+1', String.fromCharCode(0) + '=1+1', "'original"];
    const cases = [
      ...hostile.map(value => ({ value, wire: 'text:' + value })),
      { value: '-2', wire: '-2' }, { value: '-0.25', wire: '-0.25' }, { value: '-2e-3', wire: '-2e-3' },
      { value: '係数', wire: '係数' }, { value: '説明,"引用"', wire: '説明,"引用"' },
    ];
    for (const { value, wire } of cases) {
      const original = row(value, value, value);
      const encoded = serializeParameterCsv([original]);
      expect([...encoded.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const text = new TextDecoder().decode(encoded);
      expect(text.split('\r\n')[0]).toBe('name,expression,unit,description,textEncoding');
      // Read the CSV as an unrelated application: it must see literal text,
      // not our decoded original expression. This also exercises CSV quoting.
      const external = parseParameterCsv(bytes(text.replace(',textEncoding', '')
        .replace(',pointercad-text-v1\r\n', '\r\n')));
      expect(external).toMatchObject({ ok: true, records: [{ name: wire, expression: wire, description: wire }] });
      expect(parseParameterCsv(encoded)).toMatchObject({ ok: true, records: [{ name: original.name,
        expression: original.value.source, description: value }] });
    }
  });

  it('does not decode unrelated CSV and refuses unknown or partially stripped encodings', () => {
    const ordinary = "name,expression,unit,description\r\nA,-2,mm,text:original\r\nB,+2,none,'original\r\n";
    expect(parseParameterCsv(bytes(ordinary))).toMatchObject({ ok: true, records: [
      { expression: '-2', description: 'text:original' }, { expression: '+2', description: "'original" },
    ] });
    const encoded = new TextDecoder().decode(serializeParameterCsv([row('A', '-SUM(1,2)', '説明')]));
    expect(parseParameterCsv(bytes(encoded.replace('pointercad-text-v1', 'future-v2')))).toMatchObject({ ok: false });
    expect(parseParameterCsv(bytes(encoded.replace('text:-SUM', '-SUM')))).toMatchObject({ ok: false });
    expect(parseParameterCsv(bytes(encoded.replace('pointercad-text-v1', '')))).toMatchObject({ ok: false });
    const safe = new TextDecoder().decode(serializeParameterCsv([row('A', '-2', '')]));
    expect([...serializeParameterCsv([row('A', '-2', '')])]).toEqual([...bytes(String.fromCharCode(0xfeff)
      + 'name,expression,unit,description,textEncoding\r\nA,-2,mm,,pointercad-text-v1\r\n')]);
    expect(parseParameterCsv(bytes(safe))).toMatchObject({ ok: true, records: [{ expression: '-2', description: '' }] });
    expect(parseParameterCsv(bytes(safe + 'B,text:=1+1,mm,text:text:original,pointercad-text-v1\r\n')))
      .toMatchObject({ ok: true, records: [{ expression: '-2' }, { expression: '=1+1', description: 'text:original' }] });
    const mixed = safe + 'B,=1+1,mm,,pointercad-text-v1\r\n';
    expect(parseParameterCsv(bytes(mixed))).toMatchObject({ ok: false, diagnostics: [{ recordNumber: 3, column: 'textEncoding' }] });
    expect(parseParameterCsv(bytes(safe + 'B,2,mm,\r\n'))).toMatchObject({ ok: false });
  });
});
