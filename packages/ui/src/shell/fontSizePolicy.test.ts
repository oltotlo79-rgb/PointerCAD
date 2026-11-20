/**
 * 画面の字の大きさの決まり(C-03 の続き。統括の決定 2026-11-19 19:3x)。
 *
 * 字の大きさの元は appShell.css の 3 つの変数(本文 13px・見出し 12px・小 11px。どれも字の倍率 --pcad-scale を掛ける)。
 * 画面の字の大きさ(font-size と font の一括の書き方)は、次のどれかだけにする。決まった px や 1em 未満を書くと、字の倍率が効かない、
 * または親の字に合わせて 11px より小さくなるため。
 * - 3 つの変数のどれか、または inherit。
 * - 1em 以上(すでに変数の大きさの親より小さくしない)。
 * - 変数から作る大きさ calc(var(<変数>) * N / M)。倍率 1 の時に 11px 以上になる物だけ(見出しの 14〜24px など)。
 * - 1em 未満は max(var(--pcad-font-size-small), Nem) の形だけ(親に合わせて縮むのは今のまま、11px より小さくだけはしない)。
 * 印刷の @media print の中は紙の大きさで決めるので外す。CSS の読み方は themeContrast.test.ts と同じ(注を除いた本文を読む)。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const shellDirectory = dirname(fileURLToPath(import.meta.url));
const sourceDirectory = resolve(shellDirectory, '..');
/** 3 つの変数の倍率 1 の時の大きさ(px)。下の検査が appShell.css の定めと一致する事を確かめる。 */
const TOKEN_PX: Readonly<Record<string, number>> = { '--pcad-font-size': 13, '--pcad-font-size-heading': 12, '--pcad-font-size-small': 11 };
const MINIMUM_PX = 11;

function cssFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

/** 注と @media print の塊を空白に替える(行の番号を保つため、改行は残す)。 */
function screenCss(text: string): string {
  const blank = (part: string): string => part.replace(/[^\n]/gu, ' ');
  const uncommented = text.replace(/\/\*[\s\S]*?\*\//gu, blank);
  let result = '', index = 0;
  for (const match of uncommented.matchAll(/@media\s+print\s*\{/gu)) {
    const start = match.index ?? 0;
    if (start < index) continue;
    let depth = 0, end = uncommented.length;
    for (let cursor = start; cursor < uncommented.length; cursor += 1) {
      if (uncommented[cursor] === '{') depth += 1;
      else if (uncommented[cursor] === '}') {
        depth -= 1;
        if (depth === 0) { end = cursor + 1; break; }
      }
    }
    result += uncommented.slice(index, start) + blank(uncommented.slice(start, end));
    index = end;
  }
  return result + uncommented.slice(index);
}

/** 字の大きさの 1 つの値が決まりの中か。 */
function allowedFontSize(raw: string): boolean {
  const value = raw.trim().replace(/\s+/gu, ' ');
  if (value === 'inherit' || /^var\(--pcad-font-size(?:-heading|-small)?\)$/u.test(value)) return true;
  const em = /^(\d*\.?\d+)em$/u.exec(value);
  if (em !== null) return Number(em[1]) >= 1;
  const scaled = /^calc\(var\((--pcad-font-size(?:-heading|-small)?)\) \* (\d+) \/ (\d+)\)$/u.exec(value);
  if (scaled !== null) return (TOKEN_PX[scaled[1]] ?? 0) * Number(scaled[2]) / Number(scaled[3]) >= MINIMUM_PX;
  return /^max\(var\(--pcad-font-size-small\), (?:0?\.\d+|\d+(?:\.\d+)?)em\)$/u.test(value);
}

/** CSS の本文の、決まりの外の字の大きさ(「ファイル:行 値」)。font の一括の書き方は inherit だけ。 */
function fontSizeOffenders(file: string, text: string): string[] {
  const screen = screenCss(text);
  const line = (index: number): number => screen.slice(0, index).split('\n').length;
  const offenders: string[] = [];
  for (const match of screen.matchAll(/(?<![-\w])(font-size|font)\s*:\s*([^;}]+)/gu)) {
    const [, property = '', value = ''] = match;
    const ok = property === 'font' ? value.trim() === 'inherit' : allowedFontSize(value);
    if (!ok) offenders.push(`${file}:${String(line(match.index ?? 0))} ${property}: ${value.trim()}`);
  }
  return offenders;
}

describe('画面の字の大きさの決まり', () => {
  it('3 つの大きさの変数は、本文 13px・見出し 12px・小 11px に字の倍率を掛けた物', () => {
    const css = readFileSync(join(shellDirectory, 'appShell.css'), 'utf8');
    for (const [name, px] of Object.entries(TOKEN_PX)) {
      expect(css, name).toContain(`${name}: calc(${String(px)}px * var(--pcad-scale, 1));`);
    }
    expect(Math.min(...Object.values(TOKEN_PX))).toBe(MINIMUM_PX);
  });

  it('画面の CSS の字の大きさは全部、3 つの変数から作る形(決まりの外は、ファイルと行で示す)', () => {
    const files = cssFiles(sourceDirectory);
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.flatMap((file) => fontSizeOffenders(relative(sourceDirectory, file).split('\\').join('/'),
      readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('決まりの読み方: 決まった px・1em 未満・倍率 1 で 11px 未満は断り、印刷の中と注は見ない', () => {
    for (const value of ['inherit', 'var(--pcad-font-size)', 'var(--pcad-font-size-small)', '1em', '1.25em',
      'calc(var(--pcad-font-size) * 24 / 13)', 'calc(var(--pcad-font-size-small) * 11 / 11)', 'max(var(--pcad-font-size-small), 0.85em)']) {
      expect(allowedFontSize(value), value).toBe(true);
    }
    for (const value of ['12px', '0.9em', '.9em', 'calc(12px * var(--pcad-scale, 1))', 'calc(var(--pcad-font-size-small) * 9 / 11)',
      'max(11px, 0.85em)', 'small', '9pt']) {
      expect(allowedFontSize(value), value).toBe(false);
    }
    const sample = ['.a { font-size: 12px; }', '/* .b { font-size: 9px; } */', '@media print {', '  .c { font-size: 9pt; }', '}',
      '.d { font: 600 10px sans-serif; }', '.e { font: inherit; --pcad-font-size: calc(13px * var(--pcad-scale, 1)); }'].join('\n');
    expect(fontSizeOffenders('sample.css', sample)).toEqual(['sample.css:1 font-size: 12px', 'sample.css:6 font: 600 10px sans-serif']);
  });
});
