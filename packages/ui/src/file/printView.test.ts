/**
 * 印刷(計画書 docs/plans/P6-入出力.md §2.11、タスク29 の検証表)。
 *
 * 対応要件: FR-810(印刷)、FR-908(印刷の見た目はテーマの影響を受けない)、
 * NFR-RE-1(取り消しで止めない)、NFR-UX-5(できないときは理由を出す)。
 *
 * ここで確かめるのは**純関数と、差し替えられる口だけ**。実際の印刷(ブラウザの印刷ダイアログ、
 * デスクトップ版の隠しの窓)は統括が §5 で確かめる(担当は Electron を起動しない、rules/02)。
 *
 * 検査の環境に canvas は無いので、「印刷用の PNG の左上の画素が白」は
 * **下地を塗る口(`fillCanvasBackground`)へ偽の 2D の下地を渡して、
 * 左上を最後に塗った色**で確かめる(絵は下地の上に重ねるので、余白は下地の色になる)。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { t } from '../i18n/t.js';

import type { FileGateway } from './fileGateway.js';
import {
  browserPrintOf,
  buildPrintSheet,
  desktopPrintOf,
  formatPrintedAt,
  mountPrintSheetIn,
  printImageSize,
  printViewport,
  PRINT_SHEET_CLASS,
  type PrintDeps,
  type PrintSheet,
} from './printView.js';
import {
  fillCanvasBackground,
  PRINT_BACKGROUND,
  THUMBNAIL_BACKGROUND,
  type BackgroundFillTarget,
} from './thumbnail.js';

// ---------------------------------------------------------------------------
// 偽の 2D の下地(canvas の無い環境で、塗られた色を記録する)
// ---------------------------------------------------------------------------

interface FillRecord {
  readonly style: string | CanvasGradient | CanvasPattern;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

class FakeContext implements BackgroundFillTarget {
  fillStyle: string | CanvasGradient | CanvasPattern = '#000000';
  readonly fills: FillRecord[] = [];
  /** グラデーションに置かれた色の並び(単色で塗ったときは空のまま)。 */
  readonly stops: string[] = [];

  createLinearGradient(): CanvasGradient {
    const stops = this.stops;
    return {
      addColorStop(_offset: number, color: string): void {
        stops.push(color);
      },
    };
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    this.fills.push({ style: this.fillStyle, x, y, width, height });
  }
}

/**
 * 記録された塗りから、左上(0, 0)の画素の色を求める。後から塗ったものが勝つ。
 * グラデーションで塗られていたら色を 1 つに決められないので null。
 */
function topLeftColor(fills: readonly FillRecord[]): string | null {
  let color: string | null = null;
  for (const fill of fills) {
    const covers = fill.x <= 0 && fill.y <= 0 && fill.width > 0 && fill.height > 0;
    color = covers ? (typeof fill.style === 'string' ? fill.style : null) : color;
  }
  return color;
}

// ---------------------------------------------------------------------------
// appShell.css の読み取り(themeColors.test.ts と同じ流儀)
// ---------------------------------------------------------------------------

const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), '../shell/appShell.css');
/** 注釈にも選び方が出てくるので、先に取り除いてから塊を探す。 */
const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** `@media print { … }` の中身。入れ子の `{}` を数えて閉じ括弧を見つける。 */
function mediaPrintBlock(): string {
  const start = css.indexOf('@media print');
  if (start < 0) {
    throw new Error('appShell.css に @media print がありません。');
  }
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let position = open; position < css.length; position += 1) {
    if (css[position] === '{') {
      depth += 1;
    } else if (css[position] === '}') {
      depth -= 1;
      if (depth === 0) {
        return css.slice(open + 1, position);
      }
    }
  }
  throw new Error('@media print の閉じ括弧が見つかりません。');
}

interface CssRule {
  readonly selectors: readonly string[];
  readonly body: string;
}

/** 塊の中の規則を「選び方の並び」と「中身」に分ける(この塊に入れ子の規則は無い)。 */
function rulesOf(block: string): readonly CssRule[] {
  const rules: CssRule[] = [];
  let index = 0;
  for (;;) {
    const open = block.indexOf('{', index);
    const close = block.indexOf('}', open);
    if (open < 0 || close < 0) {
      return rules;
    }
    rules.push({
      selectors: block
        .slice(index, open)
        .split(',')
        .map((one) => one.trim())
        .filter((one) => one.length > 0),
      body: block.slice(open + 1, close),
    });
    index = close + 1;
  }
}

/** その選び方が `display: none` になっているか。 */
function isHidden(rules: readonly CssRule[], selector: string): boolean {
  return rules.some(
    (rule) => rule.selectors.includes(selector) && /display:\s*none/.test(rule.body),
  );
}

/** テーマ 5 種の塊の中身(`themeColors.test.ts` と同じ探し方)。 */
function themeBlock(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

// ---------------------------------------------------------------------------
// 印刷の口の偽物
// ---------------------------------------------------------------------------

/** 3 バイト(1, 2, 3)の「PNG」。`dataUrlToBytes` が受け取れる形になっていればよい。 */
const FAKE_PNG_DATA_URL = 'data:image/png;base64,AQID';

/** 何もしない口(`FileGateway` の必須の 3 本だけを持つ)。 */
const BARE_GATEWAY: FileGateway = {
  openPcad: () => Promise.resolve(null),
  savePcad: () => Promise.resolve(null),
  hasSaveTarget: () => false,
};

/** Web の道筋(紙面を足して `window.print()`)の記録つきの口。 */
function browserDeps(): {
  readonly deps: PrintDeps;
  readonly mounted: PrintSheet[];
  readonly unmounted: number[];
  readonly printed: number[];
} {
  const mounted: PrintSheet[] = [];
  const unmounted: number[] = [];
  const printed: number[] = [];
  return {
    mounted,
    unmounted,
    printed,
    deps: {
      capture: () => FAKE_PNG_DATA_URL,
      printOnDesktop: null,
      mount: (sheet) => {
        mounted.push(sheet);
        return () => {
          unmounted.push(mounted.length);
        };
      },
      print: () => {
        printed.push(mounted.length);
      },
    },
  };
}

const REQUEST = { title: 'ブラケット', printedAt: '2026-09-06 10:27' };

// ---------------------------------------------------------------------------

describe('印刷の絵の大きさ(P6 §2.11)', () => {
  it('長辺が上限を超えなければ、そのままの大きさで印刷する(拡大しない)', () => {
    expect(printImageSize(1200, 800, 2000)).toEqual({ width: 1200, height: 800 });
  });

  it('長辺が上限を超えたら、縦横比を保ったまま上限まで縮める', () => {
    expect(printImageSize(4000, 2000, 2000)).toEqual({ width: 2000, height: 1000 });
  });

  it('大きさが決められないときは null(まだ描いていない・幅が 0)', () => {
    expect(printImageSize(0, 800)).toBeNull();
    expect(printImageSize(1200, Number.NaN)).toBeNull();
  });
});

describe('印刷の下地は白(FR-908)', () => {
  it('印刷用の 1 コマの左上の画素が #ffffff', () => {
    const context = new FakeContext();
    fillCanvasBackground(context, 1200, 800, PRINT_BACKGROUND);
    expect(topLeftColor(context.fills)).toBe('#ffffff');
  });

  it('白は上下とも同じ色なので、グラデーションを作らず単色で塗る(端の画素も白)', () => {
    const context = new FakeContext();
    fillCanvasBackground(context, 1200, 800, PRINT_BACKGROUND);
    expect(context.stops).toEqual([]);
    expect(context.fills).toHaveLength(1);
    expect(context.fills[0]).toMatchObject({ x: 0, y: 0, width: 1200, height: 800 });
  });

  it('画面のテーマがダークでも(どのテーマでも)印刷の下地は白のまま', () => {
    // 印刷の下地は 1 か所の定数で決まり、テーマの色トークンを読まない。
    // 念のため、5 種のテーマのビューポートの地が白でないことも確かめる
    // (白があれば「テーマの色をそのまま使っても白になる」偶然の一致が起きうるため)。
    for (const selector of [
      '[data-theme="dark"]',
      '[data-theme="light"]',
      '[data-theme="darkModern"]',
      '[data-theme="lightModern"]',
      '[data-theme="modern"]',
    ]) {
      const block = themeBlock(selector);
      for (const token of ['--pcad-viewport-top', '--pcad-viewport-bottom']) {
        const found = new RegExp(`${token}:\\s*([^;]+);`).exec(block);
        expect(found, `${selector} ${token}`).not.toBeNull();
        expect(found?.[1].trim().toLowerCase(), `${selector} ${token}`).not.toBe('#ffffff');
      }
    }
    expect(PRINT_BACKGROUND).toEqual({ top: '#ffffff', bottom: '#ffffff' });
  });

  it('サムネイルの下地は今までどおり縦のグラデーションのまま(振る舞いを変えない)', () => {
    const context = new FakeContext();
    fillCanvasBackground(context, 256, 256, THUMBNAIL_BACKGROUND);
    expect(context.stops).toEqual([THUMBNAIL_BACKGROUND.top, THUMBNAIL_BACKGROUND.bottom]);
  });
});

describe('@media print で 4 区画を隠す(要件§7.1 の 5 区画のうち 4 つ)', () => {
  const rules = rulesOf(mediaPrintBlock());

  it('ツールバー・モデルブラウザ・プロパティ・ステータスバーが display: none', () => {
    for (const selector of [
      '.pcad-toolbar',
      '.pcad-panel--left',
      '.pcad-panel--right',
      '.pcad-statusbar',
    ]) {
      expect(isHidden(rules, selector), selector).toBe(true);
    }
  });

  it('ビューポートも隠し、代わりに印刷用の紙面を出す', () => {
    expect(isHidden(rules, '.pcad-viewport')).toBe(true);
    expect(isHidden(rules, `.${PRINT_SHEET_CLASS}`)).toBe(false);
    const sheet = rules.find((rule) => rule.selectors.includes(`.${PRINT_SHEET_CLASS}`));
    expect(sheet?.body).toContain('display: block');
  });

  it('紙面は白い地に黒い文字で、テーマの色トークンを 1 つも使わない(FR-908)', () => {
    const printed = mediaPrintBlock();
    expect(printed).toContain('background: #fff');
    expect(printed).toContain('color: #000');
    expect(printed).not.toContain('--pcad-');
  });

  it('印刷用の紙面は画面には出ない(@media print の外では display: none)', () => {
    const onScreen = rulesOf(css.replace(mediaPrintBlock(), ''));
    expect(isHidden(onScreen, `.${PRINT_SHEET_CLASS}`)).toBe(true);
  });
});

describe('印刷用の紙面の組み立て(§2.11)', () => {
  it('絵 1 枚と、部品名・日時の見出しを組む', () => {
    const node = buildPrintSheet({
      imageDataUrl: FAKE_PNG_DATA_URL,
      title: 'ブラケット',
      printedAt: '2026-09-06 10:27',
    });
    expect(node.className).toBe(PRINT_SHEET_CLASS);
    expect(node.children?.map((child) => child.tag)).toEqual(['h1', 'p', 'img']);
    expect(node.children?.[0].text).toBe('ブラケット');
    expect(node.children?.[1].text).toBe('2026-09-06 10:27');
    expect(node.children?.[2].src).toBe(FAKE_PNG_DATA_URL);
    expect(node.children?.[2].alt).toBe('ブラケット');
  });

  it('日時は年-月-日 時:分に揃える(秒は出さない)', () => {
    expect(formatPrintedAt(new Date(2026, 8, 6, 10, 27, 45))).toBe('2026-09-06 10:27');
    expect(formatPrintedAt(new Date(2026, 0, 2, 3, 4, 0))).toBe('2026-01-02 03:04');
  });
});

describe('印刷の手続き(FR-810、NFR-RE-1、NFR-UX-5)', () => {
  it('Web は紙面を足してから印刷し、終わったら必ず取り除く', async () => {
    const { deps, mounted, unmounted, printed } = browserDeps();
    const outcome = await printViewport(REQUEST, deps);
    expect(outcome).toEqual({ status: 'printed' });
    expect(mounted).toHaveLength(1);
    expect(mounted[0]).toEqual({
      imageDataUrl: FAKE_PNG_DATA_URL,
      title: 'ブラケット',
      printedAt: '2026-09-06 10:27',
    });
    // 紙面を足してから印刷し、印刷のあとで取り除いている。
    expect(printed).toEqual([1]);
    expect(unmounted).toEqual([1]);
  });

  it('印刷の呼び出しが失敗しても紙面は取り除く(finally)', async () => {
    const { deps, unmounted } = browserDeps();
    const failing: PrintDeps = {
      ...deps,
      print: () => {
        throw new Error('印刷の窓を開けませんでした。');
      },
    };
    await expect(printViewport(REQUEST, failing)).rejects.toThrow();
    expect(unmounted).toEqual([1]);
  });

  it('window.print が無い環境は「印刷できません。」で断る(例外を投げない)', async () => {
    const { deps } = browserDeps();
    const outcome = await printViewport(REQUEST, { ...deps, print: null });
    expect(outcome).toEqual({ status: 'refused', message: t('print.unavailable') });
    expect(t('print.unavailable')).toContain('印刷できません。');
  });

  it('絵を作れないときは断る(まだ一度も描いていない)', async () => {
    const { deps } = browserDeps();
    const outcome = await printViewport(REQUEST, { ...deps, capture: () => null });
    expect(outcome).toEqual({ status: 'refused', message: t('print.noImage') });
  });

  it('デスクトップ版へは PNG のバイト列を渡す(紙面は組まない)', async () => {
    const { deps, mounted } = browserDeps();
    const sent: Uint8Array[] = [];
    const outcome = await printViewport(REQUEST, {
      ...deps,
      printOnDesktop: (png) => {
        sent.push(png);
        return Promise.resolve(true);
      },
    });
    expect(outcome).toEqual({ status: 'printed' });
    expect(sent).toHaveLength(1);
    expect([...sent[0]]).toEqual([1, 2, 3]);
    expect(mounted).toEqual([]);
  });

  it('印刷を取り消したら例外を投げず、断りの文言も出さない(NFR-RE-1)', async () => {
    const { deps } = browserDeps();
    const outcome = await printViewport(REQUEST, {
      ...deps,
      printOnDesktop: () => Promise.resolve(false),
    });
    expect(outcome).toEqual({ status: 'canceled' });
  });
});

describe('印刷の口の見分け', () => {
  it('window.print が無い相手には印刷の手を渡さない', () => {
    expect(browserPrintOf({})).toBeNull();
    expect(browserPrintOf({ print: 'いいえ' })).toBeNull();
  });

  it('window.print がある相手はそのまま呼べる', () => {
    let called = 0;
    const print = browserPrintOf({
      print: () => {
        called += 1;
      },
    });
    print?.();
    expect(called).toBe(1);
  });

  it('印刷の口を持たない口(Web 版・古い preload)には null を返す', () => {
    expect(desktopPrintOf(BARE_GATEWAY)).toBeNull();
  });

  it('印刷の口を持つ口(デスクトップ版)はそのまま呼べる', async () => {
    const sent: Uint8Array[] = [];
    const print = desktopPrintOf({
      ...BARE_GATEWAY,
      print: (png) => {
        sent.push(png);
        return Promise.resolve(true);
      },
    });
    expect(print).not.toBeNull();
    await expect(print?.(new Uint8Array([9]))).resolves.toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('document が無い相手には紙面を足す手を渡さない(印刷は断りになる)', () => {
    expect(mountPrintSheetIn({})).toBeNull();
    expect(mountPrintSheetIn({ document: {} })).toBeNull();
  });
});
