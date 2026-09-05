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

  it('5 テーマとも 26 個のトークンを 1 つも欠かさず持ち、すべて読める色である', () => {
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

  /**
   * 相対輝度(WCAG の定義)。案内線と地の明度差を測るのに使う。
   */
  function relativeLuminance(color: number): number {
    const channels = [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff].map((value) => {
      const ratio = value / 255;
      return ratio <= 0.03928 ? ratio / 12.92 : Math.pow((ratio + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  /** 2 色の明度差(1〜21)。 */
  function contrastRatio(a: number, b: number): number {
    const first = relativeLuminance(a);
    const second = relativeLuminance(b);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  }

  it('案内線(FR-110)は 5 テーマとも吸着の印と同じアクセント色で、地と 3:1 以上(§0.14)', () => {
    for (const [theme, selector] of THEME_SELECTORS) {
      const block = blockOf(selector);
      const track = parseCssColor(tokenValue(block, '--pcad-track'));
      const accent = parseCssColor(tokenValue(block, '--pcad-accent'));
      expect(track, `${theme} の --pcad-track`).not.toBeNull();
      // 吸着の印(.pcad-snap-marker の縁)と同じ色にする(§0.14 の利用者の決定)。
      expect(track, `${theme}: 案内線と吸着の印が同じ色`).toBe(accent);

      // ビューポートの地は上下のグラデーションなので、両端に対して 3:1 以上を求める。
      for (const groundToken of ['--pcad-viewport-top', '--pcad-viewport-bottom']) {
        const ground = parseCssColor(tokenValue(block, groundToken));
        expect(ground, `${theme} の ${groundToken}`).not.toBeNull();
        if (track === null || ground === null) {
          continue;
        }
        expect(contrastRatio(track, ground), `${theme} の ${groundToken}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('拘束の印(FR-313)は 5 テーマとも地と 3:1 以上で、4 つが互いに違う色(P4b タスク13)', () => {
    const tokens = [
      '--pcad-constraint-ok',
      '--pcad-constraint-redundant',
      '--pcad-constraint-conflict',
      '--pcad-constraint-fixed',
    ];
    for (const [theme, selector] of THEME_SELECTORS) {
      const block = blockOf(selector);
      const values = tokens.map((token) => parseCssColor(tokenValue(block, token)));
      for (const [index, token] of tokens.entries()) {
        const color = values[index];
        expect(color, `${theme} の ${token}`).not.toBeNull();
        if (color === null) {
          continue;
        }
        // ビューポートの地は上下のグラデーションなので、両端に対して 3:1 以上を求める。
        for (const groundToken of ['--pcad-viewport-top', '--pcad-viewport-bottom']) {
          const ground = parseCssColor(tokenValue(block, groundToken));
          expect(ground, `${theme} の ${groundToken}`).not.toBeNull();
          if (ground === null) {
            continue;
          }
          expect(
            contrastRatio(color, ground),
            `${theme} の ${token} / ${groundToken}`,
          ).toBeGreaterThanOrEqual(3);
        }
      }
      // 状態を色で見分けるので、4 つが同じ色になっていないことを固定する。
      expect(new Set(values).size, `${theme} の拘束の印`).toBe(tokens.length);
    }
  });

  it('完全に決まった要素の色(FR-313)は 5 テーマとも地と 3:1 以上で、既定色と別の色(タスク22b)', () => {
    for (const [theme, selector] of THEME_SELECTORS) {
      const block = blockOf(selector);
      const constrained = parseCssColor(tokenValue(block, '--pcad-sketch-constrained'));
      expect(constrained, `${theme} の --pcad-sketch-constrained`).not.toBeNull();
      if (constrained === null) {
        continue;
      }
      // ビューポートの地は上下のグラデーションなので、両端に対して 3:1 以上を求める。
      for (const groundToken of ['--pcad-viewport-top', '--pcad-viewport-bottom']) {
        const ground = parseCssColor(tokenValue(block, groundToken));
        expect(ground, `${theme} の ${groundToken}`).not.toBeNull();
        if (ground === null) {
          continue;
        }
        expect(
          contrastRatio(constrained, ground),
          `${theme} の --pcad-sketch-constrained / ${groundToken}`,
        ).toBeGreaterThanOrEqual(3);
      }
      // 未決定の要素(既定色)と、選択・ホバーの青とは必ず見分けが付く色にする。
      for (const otherToken of [
        '--pcad-sketch-curve',
        '--pcad-sketch-point',
        '--pcad-emphasis-hovered',
        '--pcad-emphasis-selected',
      ]) {
        expect(
          parseCssColor(tokenValue(block, otherToken)),
          `${theme} の ${otherToken} と同じ色になっていない`,
        ).not.toBe(constrained);
      }
    }
  });

  it('拡大率の倍率はルート要素だけが持つ(見本カードの中で等倍へ戻らない)', () => {
    // `:root { --pcad-scale: 1; }` は単独の塊で、テーマの塊には入っていない。
    for (const [theme, selector] of THEME_SELECTORS) {
      expect(tokenValue(blockOf(selector), '--pcad-scale'), theme).toBe('');
    }
  });
});
