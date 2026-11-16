import { describe, expect, it } from 'vitest';
import { defaultRadialCommandIds, radialCommandIds } from './radialCommandItems.js';
import { checkedRadialCommands, RADIAL_DOCUMENT_KINDS, radialCommandFits, readRadialCommands } from './radialCommandSettings.js';

/* 設計 2-4・B-08f: 放射メニューの中身を文書の種類ごとに選ぶ設定。保存の値は種類ごとに読み、壊れた種類だけ既定に戻す。 */
const PART_CUSTOM = ['toolbar.sketch.select', 'toolbar.shape.circle', 'toolbar.sketch.line', 'toolbar.shape.rectangle',
  'toolbar.solidCreate.extrude', 'toolbar.look.measure', 'toolbar.view.home', 'history.redo'] as const;

describe('放射メニューの並びの検査', () => {
  it('既定の並びは、どの種類でも検査を通る(既定が自分の検査で断られない)', () => {
    for (const kind of RADIAL_DOCUMENT_KINDS) {
      expect(checkedRadialCommands(defaultRadialCommandIds(kind), kind)).toEqual(defaultRadialCommandIds(kind));
    }
  });

  it('8 つちょうど・その種類で使える命令・重なり無しの時だけ通す', () => {
    expect(checkedRadialCommands(PART_CUSTOM, 'part')).toEqual(PART_CUSTOM);
    expect(checkedRadialCommands(PART_CUSTOM.slice(0, 7), 'part')).toBeNull();
    expect(checkedRadialCommands([...PART_CUSTOM.slice(0, 7), 'toolbar.sketch.select'], 'part')).toBeNull();
    expect(checkedRadialCommands([...PART_CUSTOM.slice(0, 7), 'no.such.command'], 'part')).toBeNull();
    // 図面の命令は部品に置けない。
    expect(checkedRadialCommands([...PART_CUSTOM.slice(0, 7), 'toolbar.drawing.note'], 'part')).toBeNull();
    expect(checkedRadialCommands('toolbar.sketch.select', 'part')).toBeNull();
  });

  it('選択の文脈で差し込む 3 つの命令は、利用者の並びに置けない', () => {
    for (const id of ['sketch.connectPoints', 'sketch.faceFromPoints', 'sketch.pointAtReference']) {
      expect(radialCommandFits(id, 'part')).toBe(false);
    }
    expect(radialCommandFits('toolbar.sketch.line', 'part')).toBe(true);
  });
});

describe('保存の値の読み取り', () => {
  it('無い時は空で、知らせない', () => {
    expect(readRadialCommands(undefined)).toEqual({ commands: {}, dropped: 0 });
  });

  it('知らない種類・壊れた種類だけを捨てて数え、正しい種類は残す', () => {
    const read = readRadialCommands({ part: PART_CUSTOM, assembly: ['history.undo'], sheet: PART_CUSTOM });
    expect(read.commands).toEqual({ part: PART_CUSTOM });
    expect(read.dropped).toBe(2);
  });

  it('形の違う値は全体を既定に戻して 1 件と数える', () => {
    expect(readRadialCommands([PART_CUSTOM])).toEqual({ commands: {}, dropped: 1 });
    expect(readRadialCommands('part')).toEqual({ commands: {}, dropped: 1 });
  });
});

describe('今の 8 つ', () => {
  it('利用者の並びがあればそれ、無い種類は既定', () => {
    expect(radialCommandIds('part', false, false, false, { part: PART_CUSTOM })).toEqual(PART_CUSTOM);
    expect(radialCommandIds('assembly', false, false, false, { part: PART_CUSTOM })).toEqual(defaultRadialCommandIds('assembly'));
  });

  it('部品で点を選んでいる時は、利用者の並びでも右上(2 番目)に文脈の命令を出す', () => {
    const shown = radialCommandIds('part', true, false, false, { part: PART_CUSTOM });
    expect(shown[1]).toBe('sketch.connectPoints');
    const exceptSecond = (items: readonly string[]): string[] => [...items.slice(0, 1), ...items.slice(2)];
    expect(exceptSecond(shown)).toEqual(exceptSecond(PART_CUSTOM));
  });
});
