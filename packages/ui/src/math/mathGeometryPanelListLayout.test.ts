/**
 * GR-19d (w15a's e2e finding, `scratchpad/claude/instructions/w19a-gr19d-list-headings.md`): two
 * product bugs found while writing the math-geometry panel's e2e script.
 *
 * 1. The list row's headings (測る量・参照先・値・比べる幅) never appeared: `.pcad-properties`'s
 *    shared grid (`minmax(0, 1fr) auto`, `packages/ui/src/shell/appShell.css`) sizes the value column
 *    to its content and lets the heading column shrink all the way to 0 once a value is long enough.
 *    `.pcad-properties` is shared with several other panels (PropertyPanel, sheet metal, strength,
 *    assembly, sketch canvases, …), so the fix must only change the math-geometry list's own rows,
 *    through a dedicated class layered on top (`.pcad-parameter__properties`).
 * 2. The "測る量" quantity-to-add label sat flush against the panel's left edge: `.pcad-field` (its
 *    own grid) carries no horizontal padding, and every ancestor up to `.pcad-section` also has none
 *    (`.pcad-parameters__fields { padding: 0 }`, shared with `ParameterPanel`) — unlike every sibling
 *    control in the panel, which supplies its own left/right padding (`.pcad-panel__note`,
 *    `.pcad-parameters__list`, `.pcad-parameters__footer`). Fixed with a dedicated class on just that
 *    field (`.pcad-parameters__quantity-field`).
 *
 * Vitest's `environment: 'node'` cannot lay out a real CSS grid, so this file checks what a unit test
 * can: the fixed rules' text no longer lets the heading column collapse and lets a long value wrap
 * instead of overflowing, scoped to classes that only this panel's markup carries (confirmed against
 * the rendered markup in `MathGeometryPanel.test.ts`), and the shared base rules the other panels still
 * use are untouched. The real pixel layout is left to a screen check (a later task, per the
 * instructions).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), '../shell/appShell.css');
/** コメントを除いてから探す(themeColors.test.ts と同じ手法)。 */
const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** 選び方1つぶんの `{ … }` の中身。入れ子の `{}` は無い前提。 */
function blockOf(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `selector not found: ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('GR-19d: appShell.css の一覧の行だけに効く見出し・折り返しの規則', () => {
  it('.pcad-properties 単体の規則(他のプロパティ区画と共有)は変えていない', () => {
    const shared = blockOf('.pcad-properties {');
    expect(shared).toContain('grid-template-columns: minmax(0, 1fr) auto;');
  });

  it('専用の class を重ねたときだけ、見出し列(1列目)が潰れない比率になる', () => {
    const scoped = blockOf('.pcad-properties.pcad-parameter__properties');
    expect(scoped).toMatch(/grid-template-columns:\s*minmax\([^,]+,\s*max-content\)\s+minmax\(0,\s*1fr\)\s*;/);
  });

  it('専用の class の値だけ、長い文字列を折り返して横にはみ出さない', () => {
    const wrap = blockOf('.pcad-parameter__properties .pcad-properties__value');
    expect(wrap).toContain('overflow-wrap: anywhere;');
  });

  it('「測る量」の追加欄専用の class だけ、区画の左右の余白を持つ', () => {
    const field = blockOf('.pcad-parameters__quantity-field');
    expect(field).toContain('padding: 0 var(--pcad-space-3);');
  });

  it('.pcad-parameters__fields 単体の規則(ParameterPanel と共有)は変えていない(左右 padding 0 のまま)', () => {
    const fields = blockOf('.pcad-parameters__fields {');
    expect(fields).toContain('padding: 0;');
  });
});
