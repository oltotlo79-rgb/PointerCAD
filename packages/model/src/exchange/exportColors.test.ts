import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import {
  appearanceOf,
  assignBodyAppearance,
  assignFaceAppearance,
} from '../appearance/documentAppearance.js';
import { appearanceFromPreset, DEFAULT_APPEARANCE } from '../appearance/materialPresets.js';
import type { AppearanceSpec } from '../appearance/types.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import type { AppearanceMatchEntry } from '../kernelBridge.js';
import { appendSolid, createEmptyPartDocument } from '../part/createPartDocument.js';
import type { ExtrudeFeature, PartDocument } from '../part/types.js';

import {
  bodyColorsFor,
  DEFAULT_EXPORT_COLOR,
  faceColorsFor,
  parseHexColor,
  rgbTupleOf,
} from './exportColors.js';

/** 検査用の押し出し 1 本(`documentAppearance.test.ts` と同じ見本)。 */
function extrude(id: string): ExtrudeFeature {
  return {
    kind: 'extrude',
    id,
    name: id,
    suppressed: false,
    profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
    distance: expressionValueFromNumber(20),
    reversed: false,
    symmetric: false,
  };
}

/** 面 1 枚の指紋(`documentAppearance.test.ts` と同じ形)。 */
function faceRef(bodyFeatureId: string, index: number): SubShapeRef {
  return {
    bodyFeatureId,
    index,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'plane',
      area: 400,
      position: [10, 10, 20],
      axis: [0, 0, 1],
      radius: null,
    },
  };
}

/** 押し出し 2 本の文書(`extrude-1` と `extrude-2`)。 */
function twoBoxDocument(): PartDocument {
  return appendSolid(appendSolid(createEmptyPartDocument(), extrude('extrude-1')), extrude('extrude-2'));
}

/** 色だけを変えた外観(プリセットは「自分で決める」= 色を選べるもの)。 */
function coloredAppearance(color: string): AppearanceSpec {
  return appearanceFromPreset('custom', color);
}

/**
 * 文書の中の割り当ての id を、対象のボディと種類から引く。照合の見本
 * (`AppearanceMatchEntry`)は id で割り当てを指すので、検査でも同じ引き方をする。
 */
function faceEntryId(document: PartDocument, bodyFeatureId: string, index: number): string {
  const entry = appearanceOf(document).entries.find(
    (candidate) =>
      candidate.target.kind === 'face' &&
      candidate.target.ref.bodyFeatureId === bodyFeatureId &&
      candidate.target.ref.index === index,
  );
  if (entry === undefined) {
    throw new Error(`面の割り当てが見つからない: ${bodyFeatureId} #${String(index)}`);
  }
  return entry.id;
}

/** 照合の結果 1 件。 */
function match(id: string, bodyFeatureId: string, faceIndex: number | null): AppearanceMatchEntry {
  return { id, bodyFeatureId, faceIndex };
}

describe('#rrggbb を sRGB の 0〜1 へ解く(計画書 P6 §2.5、タスク15)', () => {
  it('既定の色 #b8bfcc は 184/255・191/255・204/255 になる', () => {
    expect(parseHexColor('#b8bfcc')).toEqual({
      r: 0.7215686274509804,
      g: 0.7490196078431373,
      b: 0.8,
    });
  });

  it('#000000 は 0、#ffffff は 1 になる', () => {
    expect(parseHexColor('#000000')).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseHexColor('#ffffff')).toEqual({ r: 1, g: 1, b: 1 });
  });

  it('大文字の #FF0000 も受ける(小文字と同じ値になる)', () => {
    expect(parseHexColor('#FF0000')).toEqual({ r: 1, g: 0, b: 0 });
    expect(parseHexColor('#FF0000')).toEqual(parseHexColor('#ff0000'));
  });

  it('3 桁の短縮形 #abc は受けない(P5 は #rrggbb で保存している)', () => {
    expect(parseHexColor('#abc')).toBeNull();
  });

  it('壊れた文字列は例外を投げず null になる', () => {
    expect(parseHexColor('')).toBeNull();
    expect(parseHexColor('b8bfcc')).toBeNull();
    expect(parseHexColor('#b8bfc')).toBeNull();
    expect(parseHexColor('#b8bfccc')).toBeNull();
    expect(parseHexColor('#gggggg')).toBeNull();
    expect(parseHexColor('rgb(184,191,204)')).toBeNull();
  });

  it('既定の書き出しの色は DEFAULT_APPEARANCE.color を解いたものと一致する', () => {
    expect(DEFAULT_APPEARANCE.color).toBe('#b8bfcc');
    expect(DEFAULT_EXPORT_COLOR).toEqual(parseHexColor(DEFAULT_APPEARANCE.color));
  });

  it('kernel / io へ渡す 3 要素の組は r・g・b の順になる', () => {
    expect(rgbTupleOf({ r: 0.1, g: 0.2, b: 0.3 })).toEqual([0.1, 0.2, 0.3]);
    expect(rgbTupleOf(DEFAULT_EXPORT_COLOR)).toEqual([184 / 255, 191 / 255, 204 / 255]);
  });
});

describe('立体ごとの色(FR-1106、§2.5)', () => {
  it('割り当てが 1 つも無ければ、渡した立体すべてが既定の色になる', () => {
    const colors = bodyColorsFor(twoBoxDocument(), ['extrude-1', 'extrude-2']);
    expect(colors.size).toBe(2);
    expect(colors.get('extrude-1')).toEqual(DEFAULT_EXPORT_COLOR);
    expect(colors.get('extrude-2')).toEqual(DEFAULT_EXPORT_COLOR);
  });

  it('立体へ割り当てた色が入り、割り当ての無い立体は既定のままになる', () => {
    const document = assignBodyAppearance(twoBoxDocument(), 'extrude-1', coloredAppearance('#ff0000'));
    const colors = bodyColorsFor(document, ['extrude-1', 'extrude-2']);
    expect(colors.get('extrude-1')).toEqual({ r: 1, g: 0, b: 0 });
    expect(colors.get('extrude-2')).toEqual(DEFAULT_EXPORT_COLOR);
  });

  it('面だけに割り当てた立体は、立体の色としては既定になる(§0.a-0.22)', () => {
    const document = assignFaceAppearance(
      twoBoxDocument(),
      faceRef('extrude-1', 3),
      coloredAppearance('#00ff00'),
    );
    expect(bodyColorsFor(document, ['extrude-1']).get('extrude-1')).toEqual(DEFAULT_EXPORT_COLOR);
  });

  it('書き出さない立体は表に入らない(渡した id だけの表になる)', () => {
    const document = assignBodyAppearance(twoBoxDocument(), 'extrude-2', coloredAppearance('#0000ff'));
    const colors = bodyColorsFor(document, ['extrude-1']);
    expect([...colors.keys()]).toEqual(['extrude-1']);
  });

  it('壊れた色の割り当ては例外を投げず既定の色へ落ちる', () => {
    const broken: AppearanceSpec = { ...DEFAULT_APPEARANCE, color: '#abc' };
    const document = assignBodyAppearance(twoBoxDocument(), 'extrude-1', broken);
    expect(bodyColorsFor(document, ['extrude-1']).get('extrude-1')).toEqual(DEFAULT_EXPORT_COLOR);
  });

  it('柄を割り当てた立体は柄の地の色だけが入る(柄・透過率・光沢・粗さは入らない)', () => {
    const wood = appearanceFromPreset('wood');
    const document = assignBodyAppearance(twoBoxDocument(), 'extrude-1', wood);
    const color = bodyColorsFor(document, ['extrude-1']).get('extrude-1');
    expect(wood.pattern.kind).toBe('woodGrain');
    expect(color).toEqual(parseHexColor(wood.color));
    expect(Object.keys(color ?? {})).toEqual(['r', 'g', 'b']);
  });
});

describe('面ごとの色(FR-1106、§2.5.1)', () => {
  it('面へ割り当てた色が「ボディ → 面の通し番号 → 色」で入る', () => {
    const document = assignFaceAppearance(
      twoBoxDocument(),
      faceRef('extrude-1', 3),
      coloredAppearance('#00ff00'),
    );
    const id = faceEntryId(document, 'extrude-1', 3);
    const faces = faceColorsFor(document, ['extrude-1'], [match(id, 'extrude-1', 5)]);
    expect(faces.get('extrude-1')?.get(5)).toEqual({ r: 0, g: 1, b: 0 });
    expect(faces.get('extrude-1')?.size).toBe(1);
  });

  it('faceIndex が null(選び直せなかった面)は表に入らない', () => {
    const document = assignFaceAppearance(
      twoBoxDocument(),
      faceRef('extrude-1', 3),
      coloredAppearance('#00ff00'),
    );
    const id = faceEntryId(document, 'extrude-1', 3);
    const faces = faceColorsFor(document, ['extrude-1'], [match(id, 'extrude-1', null)]);
    expect(faces.size).toBe(0);
  });

  it('立体と面の両方に割り当てがあると、面の色は面の表・立体の色は立体の表に分かれる', () => {
    const withBody = assignBodyAppearance(twoBoxDocument(), 'extrude-1', coloredAppearance('#ff0000'));
    const document = assignFaceAppearance(
      withBody,
      faceRef('extrude-1', 3),
      coloredAppearance('#00ff00'),
    );
    const id = faceEntryId(document, 'extrude-1', 3);
    const faces = faceColorsFor(document, ['extrude-1'], [match(id, 'extrude-1', 5)]);
    // 配線は「面の表を先に見て、無ければ立体の表」と読む。面 5 は緑、他の面は赤になる。
    expect(faces.get('extrude-1')?.get(5)).toEqual({ r: 0, g: 1, b: 0 });
    expect(faces.get('extrude-1')?.get(0)).toBeUndefined();
    expect(bodyColorsFor(document, ['extrude-1']).get('extrude-1')).toEqual({ r: 1, g: 0, b: 0 });
  });

  it('色を付けた面が 1 枚も無いボディは表に現れない', () => {
    const document = assignFaceAppearance(
      twoBoxDocument(),
      faceRef('extrude-1', 3),
      coloredAppearance('#00ff00'),
    );
    const id = faceEntryId(document, 'extrude-1', 3);
    const faces = faceColorsFor(document, ['extrude-1', 'extrude-2'], [match(id, 'extrude-1', 5)]);
    expect([...faces.keys()]).toEqual(['extrude-1']);
  });

  it('書き出さない立体の面の照合は落ちる', () => {
    const document = assignFaceAppearance(
      twoBoxDocument(),
      faceRef('extrude-2', 1),
      coloredAppearance('#00ff00'),
    );
    const id = faceEntryId(document, 'extrude-2', 1);
    const faces = faceColorsFor(document, ['extrude-1'], [match(id, 'extrude-2', 2)]);
    expect(faces.size).toBe(0);
  });

  it('文書に無い id の照合は落ちる(例外を投げない)', () => {
    const document = twoBoxDocument();
    expect(faceColorsFor(document, ['extrude-1'], [match('appearance-99', 'extrude-1', 5)]).size).toBe(0);
  });

  it('壊れた色の面の割り当ては表に入らない(既定の色へ落ちる)', () => {
    const broken: AppearanceSpec = { ...DEFAULT_APPEARANCE, color: 'green' };
    const document = assignFaceAppearance(twoBoxDocument(), faceRef('extrude-1', 3), broken);
    const id = faceEntryId(document, 'extrude-1', 3);
    expect(faceColorsFor(document, ['extrude-1'], [match(id, 'extrude-1', 5)]).size).toBe(0);
  });

  it('柄を割り当てた面は柄の地の色だけが入る(§0.a-0.22)', () => {
    const wood = appearanceFromPreset('wood');
    const document = assignFaceAppearance(twoBoxDocument(), faceRef('extrude-1', 3), wood);
    const id = faceEntryId(document, 'extrude-1', 3);
    const faces = faceColorsFor(document, ['extrude-1'], [match(id, 'extrude-1', 5)]);
    expect(faces.get('extrude-1')?.get(5)).toEqual(parseHexColor(wood.color));
  });

  it('面が複数あっても 1 つのボディの表にまとまる', () => {
    const first = assignFaceAppearance(
      twoBoxDocument(),
      faceRef('extrude-1', 3),
      coloredAppearance('#00ff00'),
    );
    const document = assignFaceAppearance(first, faceRef('extrude-1', 4), coloredAppearance('#0000ff'));
    const faces = faceColorsFor(document, ['extrude-1'], [
      match(faceEntryId(document, 'extrude-1', 3), 'extrude-1', 5),
      match(faceEntryId(document, 'extrude-1', 4), 'extrude-1', 6),
    ]);
    expect(faces.size).toBe(1);
    expect(faces.get('extrude-1')?.get(5)).toEqual({ r: 0, g: 1, b: 0 });
    expect(faces.get('extrude-1')?.get(6)).toEqual({ r: 0, g: 0, b: 1 });
  });

  it('照合が 1 件も無ければ空の表になる', () => {
    const document = assignFaceAppearance(
      twoBoxDocument(),
      faceRef('extrude-1', 3),
      coloredAppearance('#00ff00'),
    );
    expect(faceColorsFor(document, ['extrude-1'], []).size).toBe(0);
  });
});
