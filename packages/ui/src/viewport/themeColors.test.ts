/**
 * 3D 表示の色のテーマ連動(計画書 docs/plans/P4-スケッチ拡張.md タスク2、§0.a-0.1)。
 *
 * 対応要件: FR-908(表示テーマの切替)。
 *
 * ここは 2 つのことを固定する。
 * ① 文字列 → 16 進の変換(`parseCssColor` / `themeColorsFrom`)が正しいこと。
 * ② **`appShell.css` と `DEFAULT_THEME_COLORS` が食い違わないこと**。ダークの値は
 *    P0〜P3 の見た目そのものなので、CSS 側を直しても既定値を直し忘れると
 *    「テーマを切り替えて戻すと色が変わる」ことになる。CSS を読んで突き合わせる。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  cssColor,
  DEFAULT_THEME_COLORS,
  parseCssColor,
  THEME_COLOR_TOKENS,
  themeColorsFrom,
  type ThemeColors,
} from './themeColors.js';

const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), '../shell/appShell.css');
/** 注釈にも `[data-theme="…"]` が出てくるので、先に取り除いてから塊を探す。 */
const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** テーマ 5 種と、`appShell.css` でその値を決めている選び方。 */
const THEME_SELECTORS: readonly (readonly [string, string])[] = [
  ['dark', '[data-theme="dark"]'],
  ['light', '[data-theme="light"]'],
  ['darkModern', '[data-theme="darkModern"]'],
  ['lightModern', '[data-theme="lightModern"]'],
  ['modern', '[data-theme="modern"]'],
];

const COLOR_FIELDS = Object.keys(THEME_COLOR_TOKENS) as readonly (keyof ThemeColors)[];

/** 選び方 1 つぶんの `{ … }` の中身。入れ子の `{}` は無い前提(注釈は取り除いてある)。 */
function blockOf(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

/** 塊の中の 1 トークンの値。無ければ空文字。 */
function tokenValue(block: string, token: string): string {
  const found = new RegExp(`${token}:\\s*([^;]+);`).exec(block);
  return found === null ? '' : found[1].trim();
}

/** 塊をそのまま `themeColorsFrom` の読み手にする。 */
function readerFor(selector: string): (token: string) => string {
  const block = blockOf(selector);
  return (token) => tokenValue(block, token);
}

describe('CSS の色の読み取り(FR-908)', () => {
  it('#rrggbb を読む', () => {
    expect(parseCssColor('#16181d')).toBe(0x16181d);
    expect(parseCssColor('#E8EAF0')).toBe(0xe8eaf0);
    expect(parseCssColor('  #4f8cff  ')).toBe(0x4f8cff);
  });

  it('略記の #rgb を読む', () => {
    expect(parseCssColor('#abc')).toBe(0xaabbcc);
    expect(parseCssColor('#000')).toBe(0x000000);
  });

  it('rgb() / rgba() を読む(透過は捨てる)', () => {
    expect(parseCssColor('rgb(255, 0, 0)')).toBe(0xff0000);
    expect(parseCssColor('rgb(18 58 138)')).toBe(0x123a8a);
    expect(parseCssColor('rgba(79, 140, 255, 0.45)')).toBe(0x4f8cff);
  });

  it('読めない書き方は null(呼び出し側が既定へ後退できる)', () => {
    expect(parseCssColor('')).toBeNull();
    expect(parseCssColor('   ')).toBeNull();
    expect(parseCssColor('oklch(0.5 0.1 200)')).toBeNull();
    expect(parseCssColor('#12345')).toBeNull();
    expect(parseCssColor('rgb(300, 0, 0)')).toBeNull();
    expect(parseCssColor('var(--pcad-accent)')).toBeNull();
  });

  it('1 つも読めなければ全欄が既定(ダーク)になる', () => {
    expect(themeColorsFrom(() => '')).toEqual(DEFAULT_THEME_COLORS);
  });

  it('cssColor は parseCssColor の逆変換(ビューキューブの面のテクスチャ用)', () => {
    expect(cssColor(0x16181d)).toBe('#16181d');
    expect(cssColor(0x000000)).toBe('#000000');
    expect(cssColor(0xffffff)).toBe('#ffffff');
    // 桁落ちしない(0x00abcd のように上位が 0 の値でも 6 桁を保つ)。
    expect(cssColor(0x00abcd)).toBe('#00abcd');
    expect(parseCssColor(cssColor(0x4f8cff))).toBe(0x4f8cff);
  });

  it('読めた欄だけが差し替わり、読めない欄は既定のまま残る', () => {
    const colors = themeColorsFrom((token) =>
      token === THEME_COLOR_TOKENS.gridMinor ? '#112233' : 'oklch(0.5 0.1 200)',
    );
    expect(colors.gridMinor).toBe(0x112233);
    expect(colors.gridMajor).toBe(DEFAULT_THEME_COLORS.gridMajor);
  });
});

describe('appShell.css のテーマと 3D の色(FR-908)', () => {
  it('ダークの値は P0〜P3 の見た目(DEFAULT_THEME_COLORS)と同じ', () => {
    expect(themeColorsFrom(readerFor('[data-theme="dark"]'))).toEqual(DEFAULT_THEME_COLORS);
  });

  it('5 テーマとも 24 個のトークンを 1 つも欠かさず持ち、すべて読める色である', () => {
    for (const [theme, selector] of THEME_SELECTORS) {
      const block = blockOf(selector);
      for (const field of COLOR_FIELDS) {
        const token = THEME_COLOR_TOKENS[field];
        const value = tokenValue(block, token);
        expect(value, `${theme} の ${token}`).not.toBe('');
        expect(parseCssColor(value), `${theme} の ${token}`).not.toBeNull();
      }
    }
  });

  it('明るいテーマでは、方眼と下書きの線がダークと入れ替わって濃くなる', () => {
    const dark = themeColorsFrom(readerFor('[data-theme="dark"]'));
    const light = themeColorsFrom(readerFor('[data-theme="light"]'));
    // 方眼はダークより明るく(明るい地の上で見えるように)、下書きの線はダークより暗い。
    expect(light.gridMinor).toBeGreaterThan(dark.gridMinor);
    expect(light.sketchPoint).toBeLessThan(dark.sketchPoint);
    expect(light.sketchCurve).toBeLessThan(dark.sketchCurve);
    // ホバー(淡い)と選択(濃い)は、どのテーマでも別の色で見分けられる。
    expect(light.hovered).not.toBe(light.selected);
    expect(dark.hovered).not.toBe(dark.selected);
  });

  it('ビューキューブ: ダークモダンはダークと同じ値(見た目を変えない、P4 タスク2 仕上げ)', () => {
    const dark = themeColorsFrom(readerFor('[data-theme="dark"]'));
    const darkModern = themeColorsFrom(readerFor('[data-theme="darkModern"]'));
    expect(darkModern.viewCubeFaceTop).toBe(dark.viewCubeFaceTop);
    expect(darkModern.viewCubeFaceBottom).toBe(dark.viewCubeFaceBottom);
    expect(darkModern.viewCubeEdge).toBe(dark.viewCubeEdge);
    expect(darkModern.viewCubeText).toBe(dark.viewCubeText);
  });

  it('ビューキューブ: ライトはダークより暗い面色を持つ(白い立方体が地に埋もれる不具合の対処)', () => {
    const dark = themeColorsFrom(readerFor('[data-theme="dark"]'));
    const light = themeColorsFrom(readerFor('[data-theme="light"]'));
    const lightModern = themeColorsFrom(readerFor('[data-theme="lightModern"]'));
    for (const face of [
      'viewCubeFaceTop',
      'viewCubeFaceFront',
      'viewCubeFaceRight',
      'viewCubeFaceLeft',
      'viewCubeFaceBack',
      'viewCubeFaceBottom',
    ] as const) {
      expect(light[face], face).toBeLessThan(dark[face]);
      expect(lightModern[face], face).toBe(light[face]);
    }
  });

  it('拡大率の倍率はルート要素だけが持つ(見本カードの中で等倍へ戻らない)', () => {
    // `:root { --pcad-scale: 1; }` は単独の塊で、テーマの塊には入っていない。
    for (const [theme, selector] of THEME_SELECTORS) {
      expect(tokenValue(blockOf(selector), '--pcad-scale'), theme).toBe('');
    }
  });
});
