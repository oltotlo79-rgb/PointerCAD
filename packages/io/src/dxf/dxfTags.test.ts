import { describe, expect, it } from 'vitest';

import { DXF_UNSUPPORTED_FORMAT_MESSAGE, formatDxfTags, parseDxfTags } from './dxfTags.js';

/*
 * DXF の字句(タグの列)の検査(計画書 docs/plans/P6-入出力.md タスク22 の検証表)。
 *
 * 期待値の導出は各検査の注釈に書く。行数の期待は「行数 ÷ 2 = タグ数」の 1 つだけで、
 * 実体(LINE / CIRCLE …)の意味づけはこの段では一切見ない(タスク24 の担当)。
 */

/** 検証表の 1 行目。`SECTION` / `ENTITIES` / `ENDSEC` / `EOF` の 8 行 = タグ 4 個。 */
const MINIMAL_DXF = '0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n';

describe('parseDxfTags', () => {
  it('奇数行をコード、偶数行を値として畳む(8 行 → タグ 4 個)', () => {
    const tags = parseDxfTags(MINIMAL_DXF);

    expect(tags).toEqual([
      { code: 0, value: 'SECTION' },
      { code: 2, value: 'ENTITIES' },
      { code: 0, value: 'ENDSEC' },
      { code: 0, value: 'EOF' },
    ]);
  });

  it('改行が `\\r\\n` でも `\\n` と同じに読める', () => {
    const withCrLf = MINIMAL_DXF.replaceAll('\n', '\r\n');

    // `\r` が値の側へ残らないこと(残ると `'SECTION\r'` になってレイヤー名等が壊れる)。
    expect(parseDxfTags(withCrLf)).toEqual(parseDxfTags(MINIMAL_DXF));
  });

  it('`\\r\\n` と `\\n` が混ざっていても読める', () => {
    // テキスト処理を経た DXF は行ごとに改行が食い違うことがある。
    expect(parseDxfTags('0\r\nSECTION\n2\r\nENTITIES\n')).toEqual([
      { code: 0, value: 'SECTION' },
      { code: 2, value: 'ENTITIES' },
    ]);
  });

  it('コードの前後の空白は落とす', () => {
    // 桁を揃えるために空白で埋めて書く実装があるため(計画書 §0.a-0.31)。
    expect(parseDxfTags('  0 \nSECTION\n\t2\t\nENTITIES\n')).toEqual([
      { code: 0, value: 'SECTION' },
      { code: 2, value: 'ENTITIES' },
    ]);
  });

  it('値の前後の空白は落とさない(レイヤー名に意味がある)', () => {
    // `' 外形 '` と `'外形'` は別のレイヤー名なので、勝手に詰めない(計画書 §0.a-0.31)。
    expect(parseDxfTags('8\n 外形 \n')).toEqual([{ code: 8, value: ' 外形 ' }]);
  });

  it('値の中の空白と非 ASCII をそのまま保つ', () => {
    expect(parseDxfTags('8\n中心線 レイヤー\n')).toEqual([{ code: 8, value: '中心線 レイヤー' }]);
  });

  it('空の文字列はタグ 0 個(断らない)', () => {
    // まだ何も書いていない入れ物として正しいため。
    expect(parseDxfTags('')).toEqual([]);
  });

  it('末尾の改行が無くても読める', () => {
    // 末尾の改行 1 つだけを「最後の行の終わり」として落とす決めなので、無い場合も対で読める。
    expect(parseDxfTags('0\nEOF')).toEqual([{ code: 0, value: 'EOF' }]);
  });

  it('値の位置の空行は「空の値」として読む', () => {
    // DXF の値は空文字にもなり得る(既定のレイヤー名など)。
    expect(parseDxfTags('1\n\n0\nEOF\n')).toEqual([
      { code: 1, value: '' },
      { code: 0, value: 'EOF' },
    ]);
  });

  it('符号の付いた整数のコードも読み、`-0` は `0` へ寄せる', () => {
    // 拡張データで負のコードを使う方言があるため受ける。範囲の是非は実体の段(タスク24)で見る。
    const tags = parseDxfTags('-1\n<entity>\n+5\nA1\n-0\nB\n');

    expect(tags).toEqual([
      { code: -1, value: '<entity>' },
      { code: 5, value: 'A1' },
      { code: 0, value: 'B' },
    ]);
    // `Object.is(-0, 0)` は false なので、`toEqual` とは別に符号の無い 0 であることを確かめる。
    expect(Object.is(tags[2].code, 0)).toBe(true);
  });

  it('行が奇数個なら断る', () => {
    // コードと値が対で来ないと、どこからずれたのか分からないため読まない。
    expect(() => parseDxfTags('0\nSECTION\n2\n')).toThrow(DXF_UNSUPPORTED_FORMAT_MESSAGE);
  });

  it('末尾に余分な空行があると行数が奇数になり断る', () => {
    // 空行を黙って読み飛ばすと、対応がずれた壊れたファイルを「読めた」ことにしてしまう。
    expect(() => parseDxfTags('0\nEOF\n\n')).toThrow(DXF_UNSUPPORTED_FORMAT_MESSAGE);
  });

  it('コードが整数でなければ断る(小数・文字・空・指数・16 進)', () => {
    for (const text of ['1.5\nA\n', 'ABC\nA\n', '\nA\n', '1e3\nA\n', '0x10\nA\n']) {
      expect(() => parseDxfTags(text)).toThrow(DXF_UNSUPPORTED_FORMAT_MESSAGE);
    }
  });

  it('断りの文言は定数のとおり(NFR-UX-5)', () => {
    expect(DXF_UNSUPPORTED_FORMAT_MESSAGE).toBe('この DXF の形式には対応していません。');
  });
});

describe('formatDxfTags', () => {
  it('1 タグにつき 2 行を `\\r\\n` 区切りで書き、最後の行にも改行を付ける', () => {
    expect(formatDxfTags([{ code: 0, value: 'EOF' }])).toBe('0\r\nEOF\r\n');
  });

  it('タグ 0 個なら空の文字列(改行だけの行を作らない)', () => {
    expect(formatDxfTags([])).toBe('');
  });

  it('値の空白をそのまま書く', () => {
    expect(formatDxfTags([{ code: 8, value: ' 外形 ' }])).toBe('8\r\n 外形 \r\n');
  });
});

describe('parseDxfTags と formatDxfTags の往復', () => {
  it('改行を `\\r\\n` に揃えた元の文字列と一致する', () => {
    const expected = MINIMAL_DXF.replaceAll('\n', '\r\n');

    expect(formatDxfTags(parseDxfTags(MINIMAL_DXF))).toBe(expected);
    expect(formatDxfTags(parseDxfTags(expected))).toBe(expected);
  });

  it('空の文字列は空の文字列のまま', () => {
    expect(formatDxfTags(parseDxfTags(''))).toBe('');
  });

  it('正規形でない書き方(末尾の改行なし・コードの空白)は往復で正規形へ整う', () => {
    // 往復が元と一致するのは「正規形」のときだけ、という決めをここで固定する。
    expect(formatDxfTags(parseDxfTags('  0 \nEOF'))).toBe('0\r\nEOF\r\n');
  });

  it('タグの列 → 文字列 → タグの列でも内容が変わらない', () => {
    const tags = [
      { code: 0, value: 'LINE' },
      { code: 8, value: ' 外形 ' },
      { code: 10, value: '0.000000000' },
      { code: 20, value: '-12.500000000' },
    ];

    expect(parseDxfTags(formatDxfTags(tags))).toEqual(tags);
  });
});
