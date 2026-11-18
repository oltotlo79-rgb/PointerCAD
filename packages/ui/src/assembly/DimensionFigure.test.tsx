/**
 * 規格部品の選ぶ窓の「寸法の図と表」(K-07c): 閉じた塊と見出しで始まり、中に線図(role=img と幅・高さの名前)と寸法の表を持つ事。
 * 線図の無い部品は知らせと表だけ、表も線図も印も無い部品は何も出さない事。開いた・閉じたを覚える事(窓を開き直しても同じ)。
 * Node の検査なので、塊の中身は描いた文字と、返した要素の木で見る(PickerSearch.test.tsx と同じ考え)。
 */
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import { t } from '../i18n/t.js';
import { displayNumber } from '../sketch/numericInputPresentation.js';
import { DimensionFigure } from './DimensionFigure.js';
import { standardFigurePart, type DimensionFigurePart } from './dimensionTable.js';
import { cachedPartOutline } from './partOutline.js';
import { standardPartChoices } from './standardPartPicker.js';

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  const found: Element[] = [];
  Children.forEach(node, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    found.push(child);
    found.push(...elements(child.props.children as ReactNode));
  });
  return found;
}

function boltPart(): DimensionFigurePart {
  const choice = standardPartChoices('hexBolt', 'annexJA').find((candidate) => candidate.size === 'M8');
  if (choice === undefined) throw new Error('六角ボルト M8 が無い');
  return standardFigurePart('hexBolt', choice, 'annexJA', 'coarse');
}
function bearingPart(): DimensionFigurePart {
  return standardFigurePart('deepGrooveBallBearing', standardPartChoices('deepGrooveBallBearing')[0], 'annexJA', 'coarse');
}
/** 返した塊(details)の開閉の受け口を呼ぶ。 */
function toggle(part: DimensionFigurePart, open: boolean): void {
  const details = elements(DimensionFigure({ part })).find((element) => element.type === 'details');
  (details?.props.onToggle as (event: { currentTarget: { open: boolean } }) => void)({ currentTarget: { open } });
}

afterEach(() => { toggle(boltPart(), false); });

describe('寸法の図と表', () => {
  it('閉じた塊と見出し(説明つき)で始まり、中に線図(幅と高さの名前)と寸法の表を持つ', () => {
    const part = boltPart();
    const html = renderToStaticMarkup(<DimensionFigure part={part} />);
    expect(html).toMatch(/^<details class="pcad-popover__hint pcad-dimension-figure">/u);
    expect(html).toContain(`<summary title="${t('catalog.dimensionFigure.guide')}">${t('catalog.dimensionFigure.title')}</summary>`);
    const outline = cachedPartOutline(part.key, part.build);
    expect(outline).not.toBeNull();
    if (outline === null) return;
    const label = t('catalog.dimensionFigure.label').replace('{width}', displayNumber(outline.widthLine.valueMm).text)
      .replace('{height}', displayNumber(outline.heightLine.valueMm).text);
    expect(html).toContain(`role="img"`);
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain(`<caption>${t('catalog.dimensionFigure.tableCaption')}</caption>`);
    expect(html).toContain(`<th scope="row">${t('catalog.dimension.acrossFlats')}</th>`);
    expect(html).not.toContain(t('catalog.dimensionFigure.noFigure'));
  });

  it('線図の無い部品(深溝玉軸受)は知らせと表だけ', () => {
    const html = renderToStaticMarkup(<DimensionFigure part={bearingPart()} />);
    expect(html).not.toContain('role="img"');
    expect(html).toContain(t('catalog.dimensionFigure.noFigure'));
    expect(html).toContain(`<th scope="row">${t('catalog.dimension.innerDiameter')}</th>`);
  });

  it('表も線図も印も無い部品と、部品が無い時は何も出さない。印だけの部品は印を出す', () => {
    const empty: DimensionFigurePart = { key: 'test:empty', build: () => null, rows: [], marks: [] };
    expect(renderToStaticMarkup(<DimensionFigure part={empty} />)).toBe('');
    expect(renderToStaticMarkup(<DimensionFigure part={null} />)).toBe('');
    const marked: DimensionFigurePart = { ...empty, key: 'test:marked', marks: [{ kind: 'unverified', parts: ['理由'] }] };
    expect(renderToStaticMarkup(<DimensionFigure part={marked} />))
      .toContain(t('catalog.dimensionFigure.unverified').replace('{parts}', '理由'));
  });

  it('開いた・閉じたを覚える(窓を開き直しても、ほかの部品の塊も同じ)', () => {
    toggle(boltPart(), true);
    expect(renderToStaticMarkup(<DimensionFigure part={bearingPart()} />)).toMatch(/^<details class="[^"]*" open="">/u);
    toggle(boltPart(), false);
    expect(renderToStaticMarkup(<DimensionFigure part={boltPart()} />)).not.toContain('open=""');
  });
});
