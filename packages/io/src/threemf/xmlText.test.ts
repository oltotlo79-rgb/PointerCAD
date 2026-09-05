import { describe, expect, it } from 'vitest';

import {
  escapeXmlAttribute,
  escapeXmlText,
  formatXmlNumber,
  XML_INVALID_NUMBER_MESSAGE,
} from './xmlText.js';

/*
 * XML の文字列と数の書き方(計画書 docs/plans/P6-入出力.md §2.6、タスク14 の検証表)。
 *
 * ここで固定するのは「壊れた XML を書かない」ことと「同じ値からは必ず同じ文字列ができる」
 * ことの 2 つで、3MF の中身(要素の並び)は `writeThreeMf.test.ts` が見る。
 */

describe('XML の逃がし(§2.6)', () => {
  it('本文は & < > を逃がす', () => {
    expect(escapeXmlText('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
  });

  it('本文の引用符はそのまま(囲みの中ではないため)', () => {
    expect(escapeXmlText('"c" \'d\'')).toBe('"c" \'d\'');
  });

  it('属性は & < > " を逃がす(タスク14 の検証表)', () => {
    expect(escapeXmlAttribute('a<b>"c"&d')).toBe('a&lt;b&gt;&quot;c&quot;&amp;d');
  });

  it("属性の ' も逃がす(囲みの記号を変えても壊れないように)", () => {
    expect(escapeXmlAttribute("it's")).toBe('it&apos;s');
  });

  it('& を先に逃がすので二重にならない', () => {
    // 後回しにすると `&lt;` の `&` まで置き換えて `&amp;lt;` になってしまう。
    expect(escapeXmlText('&amp;')).toBe('&amp;amp;');
    expect(escapeXmlAttribute('&')).toBe('&amp;');
  });

  it('属性のタブ・改行・復帰は数値参照にする(読み手が空白へ潰さないように)', () => {
    expect(escapeXmlAttribute('a\tb\nc\rd')).toBe('a&#x9;b&#xA;c&#xD;d');
  });

  it('XML が許さない制御文字は落とす(壊れたファイルを無音で作らない)', () => {
    expect(escapeXmlAttribute('a\u0000b\u001Fc')).toBe('abc');
    expect(escapeXmlText('a\u0001b')).toBe('ab');
  });

  it('日本語と記号はそのまま通る(UTF-8 で書くため)', () => {
    expect(escapeXmlAttribute('取っ手 #1')).toBe('取っ手 #1');
  });
});

describe('数の書き方(§2.6)', () => {
  it('末尾の 0 を落とす(1.5000000 → 1.5)', () => {
    expect(formatXmlNumber(1.5)).toBe('1.5');
    expect(formatXmlNumber(1.5000001)).toBe('1.5');
  });

  it('整数は小数点を書かない', () => {
    expect(formatXmlNumber(20)).toBe('20');
    expect(formatXmlNumber(-20)).toBe('-20');
  });

  it('6 桁で丸める(0.0000001 → 0)', () => {
    expect(formatXmlNumber(0.0000001)).toBe('0');
    expect(formatXmlNumber(1.23456749)).toBe('1.234567');
    expect(formatXmlNumber(0.000001)).toBe('0.000001');
  });

  it('マイナス 0 を書かない(決定性)', () => {
    expect(formatXmlNumber(-0)).toBe('0');
    expect(formatXmlNumber(-0.0000001)).toBe('0');
  });

  it('指数表記にしない', () => {
    expect(formatXmlNumber(1e-6)).toBe('0.000001');
    expect(formatXmlNumber(1e15)).toBe('1000000000000000');
  });

  it('有限でない数は断る', () => {
    expect(() => formatXmlNumber(Number.NaN)).toThrow(XML_INVALID_NUMBER_MESSAGE);
    expect(() => formatXmlNumber(Number.POSITIVE_INFINITY)).toThrow(XML_INVALID_NUMBER_MESSAGE);
    expect(() => formatXmlNumber(Number.NEGATIVE_INFINITY)).toThrow(XML_INVALID_NUMBER_MESSAGE);
  });

  it('指数表記になるほど大きい数は断る(10 の 21 乗以上)', () => {
    expect(() => formatXmlNumber(1e21)).toThrow(XML_INVALID_NUMBER_MESSAGE);
  });
});
