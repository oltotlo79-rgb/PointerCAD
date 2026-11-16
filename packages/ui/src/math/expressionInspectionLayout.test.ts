/**
 * 名前を欄の上の行に置く窓で、焦点を入れた時の式の点検の行が暗黙の 3 列目を作らない規則(C-02j。UI の点検の指摘 30)。
 *
 * 点検の行の共通の規則 `.pcad-field > .pcad-expression-inspection { grid-column: 2 / 4; }` は、名前・欄・単位の 3 列の欄のためのもの。
 * 名前の列と単位の 2 列だけの格子(板金・段をまたぐ連動・強度・節の欄)では、2 / 4 が暗黙の 3 列目を作り、欄が縮んで単位が次の行へ落ちた。
 * そのため名前を上に置く入れ物では、点検の行を全幅(1 / -1)にする。名前が左にある普通の欄(`.pcad-popover__fields--wide` を含む)は 2 / 4 のまま。
 *
 * NodeのVitestは実CSS gridを配置できないため、規則の本文を検査する(themeColors.test.ts・mathGeometryPanelListLayout.test.ts と同じ手法)。
 * 画素の確かめ(焦点を入れても欄の幅と単位の位置が変わらない)は画面検査。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(resolve(directory, relative), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const inspectionCss = read('./expressionInspection.css');
const shellCss = read('../shell/appShell.css');

/** 規則 1 つぶんの { セレクター, 本文 } を全部返す(入れ子の `{}` は無い前提)。 */
function rulesOf(css: string): { readonly selector: string; readonly body: string }[] {
  const rules: { selector: string; body: string }[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (let match = pattern.exec(css); match !== null; match = pattern.exec(css)) {
    rules.push({ selector: match[1]?.trim() ?? '', body: match[2]?.trim() ?? '' });
  }
  return rules;
}

const stackedContainers = [
  '.pcad-sheet-metal',
  '.pcad-coupling-form',
  '.pcad-strength',
] as const;
const sectionFields = '.pcad-section__fields > .pcad-field > .pcad-expression-inspection';

/** 点検の行(`> .pcad-expression-inspection`)の grid-column を決める規則のうち、セレクターが部分 `selector` を含む物の本文。 */
function inspectionColumn(css: string, selector: string): string | undefined {
  const rule = rulesOf(css).find(item => item.selector.split(',').some(part => part.trim() === selector));
  return rule?.body.match(/grid-column:\s*([^;]+);?/u)?.[1]?.trim();
}

describe('C-02j: 名前を上に置く欄の式の点検の行は全幅(1 / -1)', () => {
  it('名前が左にある普通の欄の規則は 2 / 4 のまま', () => {
    expect(inspectionColumn(inspectionCss, '.pcad-field > .pcad-expression-inspection')).toBe('2 / 4');
  });

  it.each(stackedContainers)('%s の欄では点検の行が 1 / -1 になる', container => {
    expect(inspectionColumn(inspectionCss, `${container} .pcad-field > .pcad-expression-inspection`)).toBe('1 / -1');
  });

  it('節の欄(.pcad-section__fields の直下の欄)でも 1 / -1 になる', () => {
    expect(inspectionColumn(inspectionCss, sectionFields)).toBe('1 / -1');
  });

  it('名前を上に置く入れ物の規則は、共通の規則より強い(クラスの数が多い)ので、読み込みの順に関わらず効く', () => {
    const classes = (selector: string): number => (selector.match(/\./gu) ?? []).length;
    const base = '.pcad-field > .pcad-expression-inspection';
    for (const container of stackedContainers) {
      expect(classes(`${container} .pcad-field > .pcad-expression-inspection`)).toBeGreaterThan(classes(base));
    }
    expect(classes(sectionFields)).toBeGreaterThan(classes(base));
  });

  it('名前を左に置く .pcad-popover__fields--wide の欄は、全幅にしない(名前の列を含む 3 列の格子のため)', () => {
    expect(inspectionCss).not.toContain('.pcad-popover__fields--wide');
    const wide = rulesOf(shellCss).find(rule => rule.selector === '.pcad-popover__fields--wide .pcad-field');
    expect(wide?.body).toContain('grid-template-columns: minmax(0, auto) minmax(0, 1fr) auto;');
  });

  it('名前を上に置く入れ物の欄は、名前の列と単位の 2 列だけの格子になっている(1 / -1 が全幅になる前提)', () => {
    const twoColumns = 'grid-template-columns: minmax(0, 1fr) auto;';
    const coupling = rulesOf(shellCss).find(rule => rule.selector === '.pcad-coupling-form .pcad-field');
    const section = rulesOf(shellCss).find(rule => rule.selector === '.pcad-section__fields > .pcad-field');
    const stacked = rulesOf(shellCss).find(rule => rule.selector === '.pcad-field.pcad-field--stacked');
    const sheet = rulesOf(read('../sheetMetal/sheetMetal.css')).find(rule => rule.selector === '.pcad-sheet-metal .pcad-field');
    for (const rule of [coupling, section, stacked, sheet]) expect(rule?.body, rule?.selector).toContain(twoColumns);
  });

  it('.pcad-field--stacked の点検の行は、appShell.css の同じ規則で既に 1 / -1', () => {
    expect(inspectionColumn(shellCss, '.pcad-field.pcad-field--stacked > .pcad-expression-inspection')).toBe('1 / -1');
  });
});
