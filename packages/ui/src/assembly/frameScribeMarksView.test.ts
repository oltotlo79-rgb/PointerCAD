/**
 * ケガキの位置(E-14)の窓の文字と CSV: 部材ごとの 1 行は面ごとにまとめた距離(0.1 mm の桁)、CSV は 1 行 = 1 つの位置で、
 * 部品名(置いた時の一般の語と寸法)と取り付く物の種類・その部品名を持つ事。
 */
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT, type AssemblyComponent, type FrameScribeMember } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { t } from '../i18n/t.js';
import { scribeMemberText, serializeScribeMarksCsv } from './frameScribeMarksView.js';

const BOM = String.fromCharCode(0xfeff);
const part = (id: string, name: string): AssemblyComponent => ({ id, name, source: { kind: 'part', partRef: 'p' },
  placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed: false });
const ASSEMBLY = { ...createAssemblyDocument('ケガキ'), components: [part('base', '溝幅 6 20×20:1'), part('post', '溝幅 6 20×20:2'),
  part('nut', '溝用のナット M5:1')] };
const ENTRY: FrameScribeMember = { componentId: 'base', lengthMm: 1000, marks: [
  { face: 'top', positionMm: 250, kind: 'nut', otherComponentId: 'nut' },
  { face: 'right', positionMm: 490, kind: 'member', otherComponentId: 'post' },
  { face: 'right', positionMm: 510, kind: 'member', otherComponentId: 'post' }] };

describe('ケガキの位置の文字と CSV', () => {
  it('部材の 1 行は、部品名・長さと、面ごとにまとめた距離', () => {
    const marks = `${t('catalog.scribe.face.top')} 250.0 / ${t('catalog.scribe.face.right')} 490.0, 510.0`;
    expect(scribeMemberText(ASSEMBLY, ENTRY)).toBe(t('catalog.scribe.row').replace('{name}', '溝幅 6 20×20:1')
      .replace('{length}', '1000.0').replace('{marks}', marks));
  });

  it('CSV は BOM つきで、見出しの後に 1 行 = 1 つの位置(面・距離・種類・相手の部品名)', () => {
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(serializeScribeMarksCsv(ASSEMBLY, [ENTRY]));
    expect(text.startsWith(BOM)).toBe(true);
    const lines = text.slice(BOM.length).trim().split(/\r?\n/u);
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe(['溝幅 6 20×20:1', 'base', '1000.0', t('catalog.scribe.face.top'), '250.0', t('catalog.scribe.kind.nut'),
      '溝用のナット M5:1'].join(','));
    expect(lines[3]?.split(',').slice(3, 7)).toEqual([t('catalog.scribe.face.right'), '510.0', t('catalog.scribe.kind.member'), '溝幅 6 20×20:2']);
  });
});
