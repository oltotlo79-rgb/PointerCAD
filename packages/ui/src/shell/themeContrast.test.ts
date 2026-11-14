/**
 * 画面の文字と線の対比、効かない物の見た目(WCAG 2.x の相対輝度。NFR-UX-5・NFR-UX-7、FR-908)。
 *
 * 利用者の指示(2026-11-14「UI、UXは見やすく使用しやすく直感的に操作できることを最優先で」)を受けた
 * 画面の点検(重大 0・中 24・小 26)の指摘 2・12・15 を、5 テーマの全てで機械的に固定する。
 * - 文として読ませる文字は、地(--pcad-bg・--pcad-surface・--pcad-surface-raised)に対して 4.5:1 以上。
 * - 欄の枠・選択中の枠・焦点の枠・失敗の印など、形と状態を見分けるための線と図柄は 3:1 以上。
 * - 効かない物(:disabled・aria-disabled="true")は 1 か所の決まりで薄くし、薄くしたボタンの文字も 3:1 以上。
 * - --pcad-text-faint は 4.5:1 に届かない弱い色なので、図柄(アイコン・▸・⋮・＋)にだけ使い、文字には使わない。
 *
 * テーマや色の変数を足したときに組が足りなくならないよう、テーマの名前と数、組の変数の名前も固定する。
 * 色の読み方は themeColors.test.ts と同じ(注釈を除いた appShell.css の塊をそのまま読む)。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const shellDirectory = dirname(fileURLToPath(import.meta.url));
const sourceDirectory = resolve(shellDirectory, '..');
const css = readFileSync(join(shellDirectory, 'appShell.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');

/** テーマ 5 種と、appShell.css でその値を決めている選び方(dark は `:root` と同じ塊)。 */
const THEMES = ['dark', 'light', 'darkModern', 'lightModern', 'modern'] as const;

/** 文字の地。区画・浮いた窓は surface、溝と欄は bg、ホバーと畳んだ一覧は surface-raised。 */
const GROUNDS = ['--pcad-bg', '--pcad-surface', '--pcad-surface-raised'] as const;

/** 文として読ませる文字の色(4.5:1 以上)。 */
const TEXT_TOKENS = [
  '--pcad-text',
  '--pcad-text-muted',
  '--pcad-accent-text',
  '--pcad-danger-text',
  '--pcad-success',
  '--pcad-warning',
] as const;

/** 形と状態を見分けるための線と図柄の色(3:1 以上)。 */
const LINE_TOKENS = [
  '--pcad-control-border',
  '--pcad-accent',
  '--pcad-accent-border',
  '--pcad-accent-hover',
  '--pcad-danger',
  '--pcad-text-faint',
] as const;

/** 選択中の面(--pcad-accent-soft を surface に重ねた地)の上に置く文字の色。 */
const SELECTED_TEXT_TOKENS = ['--pcad-text', '--pcad-text-muted', '--pcad-accent-text'] as const;

const TEXT_MINIMUM = 4.5;
const LINE_MINIMUM = 3;

/** --pcad-text-faint を文字の色(color)に使ってよい、図柄だけの選び方。 */
const FAINT_GLYPH_SELECTORS = [
  '.pcad-panel__empty .pcad-icon',
  '.pcad-tree__add',
  '.pcad-tree__row--suppressed .pcad-tree__icon',
  '.pcad-tree__row--ahead .pcad-tree__icon',
  '.pcad-tree__more',
  '.pcad-tree__branch-toggle',
  '.pcad-statusbar__message .pcad-icon',
];

interface Rgba {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
}

interface CssRule {
  readonly file: string;
  readonly selectors: readonly string[];
  readonly body: string;
}

function blockOf(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  return css.slice(open + 1, css.indexOf('}', open));
}

function tokenValue(block: string, token: string): string {
  const found = new RegExp(`${token}:\\s*([^;]+);`, 'u').exec(block);
  return found === null ? '' : found[1].trim();
}

/** `#rrggbb` と `rgb(r g b / a%)`(テーマの塊の書き方)を読む。読めなければ null。 */
function parseColor(value: string): Rgba | null {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(value);
  if (hex !== null) {
    return { red: parseInt(hex[1], 16), green: parseInt(hex[2], 16), blue: parseInt(hex[3], 16), alpha: 1 };
  }
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/u.exec(value);
  if (rgb === null) return null;
  const alpha = rgb[4] === undefined ? 1 : rgb[5] === '%' ? Number(rgb[4]) / 100 : Number(rgb[4]);
  return { red: Number(rgb[1]), green: Number(rgb[2]), blue: Number(rgb[3]), alpha };
}

/** 半透明の前景を地へ重ねた、目に見える色。 */
function composite(foreground: Rgba, ground: Rgba): Rgba {
  const mixChannel = (top: number, bottom: number): number => top * foreground.alpha + bottom * (1 - foreground.alpha);
  return {
    red: mixChannel(foreground.red, ground.red),
    green: mixChannel(foreground.green, ground.green),
    blue: mixChannel(foreground.blue, ground.blue),
    alpha: 1,
  };
}

function relativeLuminance(color: Rgba): number {
  const linear = (channel: number): number => {
    const ratio = channel / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : Math.pow((ratio + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue);
}

/** 前景(半透明なら地へ重ねた色)と地の対比(1〜21)。 */
function contrastRatio(foreground: Rgba, ground: Rgba): number {
  const first = relativeLuminance(composite(foreground, ground));
  const second = relativeLuminance(ground);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** テーマの塊から色を読む。読めないときは検査を落とす。 */
function colorOf(block: string, theme: string, token: string): Rgba {
  const value = tokenValue(block, token);
  const color = parseColor(value);
  expect(color, `${theme} の ${token}(${value})`).not.toBeNull();
  return color ?? { red: 0, green: 0, blue: 0, alpha: 1 };
}

function cssFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.isFile() && entry.name.endsWith('.css') ? [path] : [];
  }).sort();
}

/** 選び方の並びを、括弧の外のカンマでだけ分ける(`:is(a, b)` の中のカンマでは分けない)。 */
function splitSelectors(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of text) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  return [...parts, current].map((selector) => selector.trim().replace(/\s+/gu, ' '));
}

/** CSS の規則を「選び方の並び」と「中身」に分ける(@media・@layer の中の規則も 1 つずつ取る)。 */
function rulesOf(path: string): CssRule[] {
  const text = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
  const file = relative(sourceDirectory, path).replaceAll('\\', '/');
  // 先頭の `@import …;` のような文は、次の規則の選び方に含めない(最後の `;` より後だけを選び方にする)。
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map((match) => ({
    file,
    selectors: splitSelectors(match[1].split(';').at(-1) ?? ''),
    body: match[2],
  }));
}

const allRules = cssFiles(sourceDirectory).flatMap(rulesOf);

describe('テーマの文字と線の対比(指摘 12・15)', () => {
  it('テーマは 5 種で、どのテーマも組の変数を 1 つも欠かさない', () => {
    const declared = [...css.matchAll(/\[data-theme="([A-Za-z]+)"\]\s*\{([^{}]*)\}/gu)]
      .filter((match) => match[2].includes('--pcad-bg:'))
      .map((match) => match[1]);
    // 新しいテーマを足したら、ここと THEMES に足し、下の全ての組で確かめる。
    expect(declared).toEqual([...THEMES]);
    const tokens = [...GROUNDS, ...TEXT_TOKENS, ...LINE_TOKENS, '--pcad-accent-soft', '--pcad-danger-surface'];
    for (const theme of THEMES) {
      const block = blockOf(`[data-theme="${theme}"]`);
      for (const token of tokens) colorOf(block, theme, token);
      expect(tokenValue(block, '--pcad-disabled-opacity'), `${theme} の --pcad-disabled-opacity`).not.toBe('');
    }
  });

  it('文として読ませる文字は、5 テーマとも 3 つの地に対して 4.5:1 以上', () => {
    for (const theme of THEMES) {
      const block = blockOf(`[data-theme="${theme}"]`);
      for (const ground of GROUNDS) {
        const groundColor = colorOf(block, theme, ground);
        for (const token of TEXT_TOKENS) {
          expect(contrastRatio(colorOf(block, theme, token), groundColor), `${theme}: ${token} / ${ground}`)
            .toBeGreaterThanOrEqual(TEXT_MINIMUM);
        }
      }
      const dangerSurface = colorOf(block, theme, '--pcad-danger-surface');
      expect(contrastRatio(colorOf(block, theme, '--pcad-danger-text'), dangerSurface), `${theme}: 失敗の帯の文字`)
        .toBeGreaterThanOrEqual(TEXT_MINIMUM);
    }
  });

  it('選択中の面(accent-soft を surface に重ねた地)の上の文字も 4.5:1 以上', () => {
    for (const theme of THEMES) {
      const block = blockOf(`[data-theme="${theme}"]`);
      const selected = composite(colorOf(block, theme, '--pcad-accent-soft'), colorOf(block, theme, '--pcad-surface'));
      for (const token of SELECTED_TEXT_TOKENS) {
        expect(contrastRatio(colorOf(block, theme, token), selected), `${theme}: ${token} / 選択中の面`)
          .toBeGreaterThanOrEqual(TEXT_MINIMUM);
      }
    }
  });

  it('形と状態を見分けるための線と図柄は、5 テーマとも 3 つの地と失敗の帯に対して 3:1 以上', () => {
    for (const theme of THEMES) {
      const block = blockOf(`[data-theme="${theme}"]`);
      for (const ground of GROUNDS) {
        const groundColor = colorOf(block, theme, ground);
        for (const token of LINE_TOKENS) {
          expect(contrastRatio(colorOf(block, theme, token), groundColor), `${theme}: ${token} / ${ground}`)
            .toBeGreaterThanOrEqual(LINE_MINIMUM);
        }
      }
      const dangerSurface = colorOf(block, theme, '--pcad-danger-surface');
      expect(contrastRatio(colorOf(block, theme, '--pcad-danger'), dangerSurface), `${theme}: 失敗の帯の印`)
        .toBeGreaterThanOrEqual(LINE_MINIMUM);
    }
  });

  it('--pcad-text-faint を文字の色に使うのは、図柄だけの選び方に限る', () => {
    const faintText = allRules
      .filter((rule) => /(?:^|[;\s])color:\s*var\(--pcad-text-faint\)/u.test(rule.body))
      .flatMap((rule) => rule.selectors.map((selector) => `${rule.file}: ${selector}`));
    expect(faintText.sort()).toEqual(FAINT_GLYPH_SELECTORS.map((selector) => `shell/appShell.css: ${selector}`).sort());
  });

  it('欄の枠は --pcad-control-border で描く(数値入力の欄・コマンドの欄・OS の既定の欄と選択)', () => {
    expect(blockOf('.pcad-field__input {')).toContain('border: 1px solid var(--pcad-control-border);');
    expect(blockOf('.pcad-commandline__input {')).toContain('border: 1px solid var(--pcad-control-border);');
    const base = allRules.filter((rule) => rule.file === 'shell/appShell.css'
      && rule.selectors.some((selector) => selector.startsWith(':where(select, textarea, input:not(')));
    expect(base, 'OS の既定の欄と選択をそろえる決まり').toHaveLength(1);
    expect(base[0]?.body).toContain('border: 1px solid var(--pcad-control-border);');
    expect(css).toMatch(/@layer pcad-base\s*\{\s*:where\(select, textarea, input/u);
  });
});

describe('効かない物の見た目(指摘 2)', () => {
  it('薄さはテーマごとの値で、ボタンの文字(text-muted)を薄めても 3 つの地と 3:1 以上を保つ', () => {
    for (const theme of THEMES) {
      const block = blockOf(`[data-theme="${theme}"]`);
      const opacity = Number(tokenValue(block, '--pcad-disabled-opacity'));
      // 効く物と見分けが付くよう、薄さは 0.5〜0.7(基本 0.5、3:1 を保てない時だけ濃くする)。
      expect(opacity, `${theme} の --pcad-disabled-opacity`).toBeGreaterThanOrEqual(0.5);
      expect(opacity, `${theme} の --pcad-disabled-opacity`).toBeLessThanOrEqual(0.7);
      const muted = { ...colorOf(block, theme, '--pcad-text-muted'), alpha: opacity };
      for (const ground of GROUNDS) {
        expect(contrastRatio(muted, colorOf(block, theme, ground)), `${theme}: 効かないボタンの文字 / ${ground}`)
          .toBeGreaterThanOrEqual(LINE_MINIMUM);
      }
    }
  });

  it(':disabled と aria-disabled="true" の見た目は appShell.css の 1 か所だけで決める', () => {
    const disabledRules = allRules.filter((rule) => rule.selectors.some((selector) =>
      /:disabled|\[aria-disabled=/u.test(selector)) && /(?:^|[;\s])(?:opacity|cursor):/u.test(rule.body));
    expect(disabledRules.map((rule) => `${rule.file}: ${rule.selectors.join(', ')}`)).toEqual([
      'shell/appShell.css: :is(button, input, select, textarea, [role="button"]):is(:disabled, [aria-disabled="true"])',
    ]);
    expect(disabledRules[0]?.body).toContain('opacity: var(--pcad-disabled-opacity);');
    expect(disabledRules[0]?.body).toContain('cursor: not-allowed;');
  });

  it('効かないボタンは、指で触れても押せる見た目(ホバー・押下の色)に変わらない', () => {
    const guard = ':where(:not(:disabled, [aria-disabled="true"]))';
    const selectors = allRules.filter((rule) => rule.file === 'shell/appShell.css').flatMap((rule) => rule.selectors);
    for (const selector of ['.pcad-button:hover', '.pcad-tab:hover', '.pcad-button:active', '.pcad-tab:active',
      '.pcad-button[aria-pressed="true"]:hover', '.pcad-button--action:active', '.pcad-button--primary:hover',
      '.pcad-popover__actions .pcad-button--action:hover', '.pcad-switch:hover', '.pcad-switch:active']) {
      // 効かない物を除いた形だけがあり、除いていない形(子孫の選び方を含む)は無い。
      expect(selectors, selector).toContain(`${selector}${guard}`);
      expect(selectors.filter((candidate) => candidate === selector || candidate.startsWith(`${selector} `)), selector)
        .toEqual([]);
    }
  });
});

describe('文字の大きさ(決定 4)', () => {
  it('画面の CSS に 11px より小さい文字の大きさを書かない(印刷の pt を除く)', () => {
    const small = allRules.flatMap((rule) => [...rule.body.matchAll(/font-size:\s*([^;]+);/gu)]
      .flatMap((match) => [...match[1].matchAll(/(\d+(?:\.\d+)?)px/gu)]
        .filter((size) => Number(size[1]) < 11)
        .map(() => `${rule.file}: ${rule.selectors.join(', ')} → ${match[1].trim()}`)));
    expect(small).toEqual([]);
  });
});
