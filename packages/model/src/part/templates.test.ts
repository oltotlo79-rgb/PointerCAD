/**
 * ひな形(テンプレート)の検査(FR-814、計画書 docs/plans/P6-入出力.md §2.10・タスク27 の検証表)。
 *
 * 輸入は相対で書く(`packages/model/src/index.ts` は別の作業のコミット待ちのため、
 * このタスクでは触らない。輸出はタスク33 でまとめる)。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import {
  absoluteCoordinate,
  createEmptySketchDocument,
  createPointFeature,
} from '../sketch/createSketchDocument.js';
import type { Parameter } from '../parameters/types.js';

import {
  appendSolid,
  createEmptyPartDocument,
  createPrimitiveFeature,
  DEFAULT_CHAMFER_DISTANCE_MM,
  DEFAULT_FILLET_RADIUS_MM,
  DEFAULT_HOLE_DIAMETER_MM,
  PART_SCHEMA_VERSION,
} from './createPartDocument.js';
import {
  createEmptyPartTemplate,
  DEFAULT_CIRCLE_RADIUS_MM,
  DEFAULT_EXTRUDE_DISTANCE_MM,
  DEFAULT_TEMPLATE_LENGTH_UNIT,
  DEFAULT_TOOL_DEFAULTS,
  documentFromTemplate,
  openTemplate,
  templateFromDocument,
  TOOL_DEFAULT_KEYS,
  type PartTemplate,
  type ToolDefaults,
} from './templates.js';
import type { PartDocument } from './types.js';

/** 検査で使うパラメータ表(FR-207)。ひな形が持ち運ぶものの代表。 */
function sampleParameters(): readonly Parameter[] {
  return [
    { name: '板厚', value: expressionValueFromNumber(3), unit: 'mm', description: '外板の厚み' },
    { name: '穴数', value: expressionValueFromNumber(4), unit: 'none', description: '' },
  ];
}

/** 道具の既定値を既定から少しずらしたもの(「持ち運ばれた」ことを見分けるため)。 */
function sampleToolDefaults(): ToolDefaults {
  return {
    extrudeDistance: '25',
    holeDiameter: '8.5',
    filletRadius: '板厚',
    chamferDistance: '0.5',
    circleRadius: '12',
  };
}

/** 形の入っていない、設定だけを持つひな形。 */
function sampleTemplate(): PartTemplate {
  const base = createEmptyPartDocument();
  return {
    document: { ...base, name: '角パイプのひな形', parameters: sampleParameters() },
    lengthUnit: 'inch',
    toolDefaults: sampleToolDefaults(),
  };
}

/** 形(ソリッド 1 つ)の入ってしまったひな形。 */
function templateWithHistory(): PartTemplate {
  const template = sampleTemplate();
  const document = appendSolid(
    template.document,
    createPrimitiveFeature(template.document, 'box'),
  );
  return { ...template, document };
}

describe('道具の既定値(§2.10)', () => {
  it('欄はちょうど 5 つ(押し出しの距離・穴の径・R 面取りの半径・C 面取りの距離・円の半径)', () => {
    expect(TOOL_DEFAULT_KEYS).toEqual([
      'extrudeDistance',
      'holeDiameter',
      'filletRadius',
      'chamferDistance',
      'circleRadius',
    ]);
    expect(TOOL_DEFAULT_KEYS).toHaveLength(5);
    expect(Object.keys(DEFAULT_TOOL_DEFAULTS)).toHaveLength(5);
  });

  it('既定値は各道具の既定の定数から作る(同じ数を 2 か所に書かない)', () => {
    expect(DEFAULT_TOOL_DEFAULTS).toEqual({
      extrudeDistance: String(DEFAULT_EXTRUDE_DISTANCE_MM),
      holeDiameter: String(DEFAULT_HOLE_DIAMETER_MM),
      filletRadius: String(DEFAULT_FILLET_RADIUS_MM),
      chamferDistance: String(DEFAULT_CHAMFER_DISTANCE_MM),
      circleRadius: String(DEFAULT_CIRCLE_RADIUS_MM),
    });
    // 式の文字列として持つ(FR-202)。数値ではない。
    for (const key of TOOL_DEFAULT_KEYS) {
      expect(typeof DEFAULT_TOOL_DEFAULTS[key]).toBe('string');
    }
  });

  it('表示の単位の既定は mm(内部は mm 固定、NFR-RE-3)', () => {
    expect(DEFAULT_TEMPLATE_LENGTH_UNIT).toBe('mm');
  });
});

describe('ひな形から新規(documentFromTemplate、§2.10)', () => {
  it('新しい id を採る(ひな形の id とは重ならない)', () => {
    const template = sampleTemplate();
    const document = documentFromTemplate(template);
    expect(template.document.id).toBe('part-1');
    expect(document.id).toBe('part-2');
    expect(document.id).not.toBe(template.document.id);
  });

  it('履歴(ソリッド・基準ジオメトリ)が空で、スケッチは空の 1 本だけ', () => {
    const document = documentFromTemplate(templateWithHistory());
    expect(document.solids).toEqual([]);
    expect(document.references).toEqual([]);
    expect(document.sketches).toHaveLength(1);
    expect(document.sketches[0].features).toEqual([]);
    // `activeSketchId` は必ず `sketches` のいずれかを指す(§0.a-0.4)。
    expect(document.activeSketchId).toBe(document.sketches[0].id);
  });

  it('パラメータ表がコピーされる(FR-207)', () => {
    const template = sampleTemplate();
    const document = documentFromTemplate(template);
    expect(document.parameters).toEqual(sampleParameters());
    expect(document.parameters).toHaveLength(2);
  });

  it('名前はひな形の名前が初期値になり、指定すればそちらを使う', () => {
    const template = sampleTemplate();
    expect(documentFromTemplate(template).name).toBe('角パイプのひな形');
    expect(documentFromTemplate(template, { name: '部品7' }).name).toBe('部品7');
  });

  it('版はいまの版になり、外観の割り当ても持ち越す', () => {
    const template = sampleTemplate();
    const document = documentFromTemplate(template);
    expect(document.schemaVersion).toBe(PART_SCHEMA_VERSION);
    expect(document.appearance).toEqual(template.document.appearance);
  });

  it('ひな形そのものは変わらない(不変)', () => {
    const template = templateWithHistory();
    const before = JSON.stringify(template.document);
    documentFromTemplate(template);
    expect(JSON.stringify(template.document)).toBe(before);
  });
});

describe('ひな形として保存(templateFromDocument、§0.a-0.35)', () => {
  /** 形とスケッチの入った、ふつうの作りかけの部品。 */
  function workingDocument(): PartDocument {
    const base = createEmptyPartDocument();
    const sketch = base.sketches[0];
    const withPoint = {
      ...base,
      name: '部品3',
      parameters: sampleParameters(),
      sketches: [
        { ...sketch, features: [createPointFeature(sketch, absoluteCoordinate(1, 2, 0))] },
      ],
    };
    return appendSolid(withPoint, createPrimitiveFeature(withPoint, 'box'));
  }

  it('履歴が空になる(ソリッド・基準ジオメトリ・スケッチの中身)', () => {
    const template = templateFromDocument(workingDocument(), {
      lengthUnit: 'mm',
      toolDefaults: DEFAULT_TOOL_DEFAULTS,
    });
    expect(template.document.solids).toEqual([]);
    expect(template.document.references).toEqual([]);
    expect(template.document.sketches).toHaveLength(1);
    expect(template.document.sketches[0].features).toEqual([]);
  });

  it('名前・パラメータ表・単位・道具の既定値を持ち運ぶ', () => {
    const template = templateFromDocument(workingDocument(), {
      lengthUnit: 'inch',
      toolDefaults: sampleToolDefaults(),
    });
    expect(template.document.name).toBe('部品3');
    expect(template.document.parameters).toEqual(sampleParameters());
    expect(template.lengthUnit).toBe('inch');
    expect(template.toolDefaults).toEqual(sampleToolDefaults());
  });

  it('名前を指定すればひな形の名前になる', () => {
    const template = templateFromDocument(workingDocument(), {
      lengthUnit: 'mm',
      toolDefaults: DEFAULT_TOOL_DEFAULTS,
      name: '社内標準',
    });
    expect(template.document.name).toBe('社内標準');
  });

  it('元の部品は変わらない(不変)', () => {
    const document = workingDocument();
    const before = JSON.stringify(document);
    templateFromDocument(document, {
      lengthUnit: 'mm',
      toolDefaults: DEFAULT_TOOL_DEFAULTS,
    });
    expect(JSON.stringify(document)).toBe(before);
  });

  it('ひな形として保存 → ひな形から新規で、パラメータ表と名前が行き来する', () => {
    const template = templateFromDocument(workingDocument(), {
      lengthUnit: 'inch',
      toolDefaults: sampleToolDefaults(),
    });
    const document = documentFromTemplate(template);
    expect(document.parameters).toEqual(sampleParameters());
    expect(document.name).toBe('部品3');
    expect(document.solids).toEqual([]);
  });
});

describe('ひな形として開く(openTemplate、§2.10・§2.8)', () => {
  it('ひな形でないファイル(.pcad)は notTemplate で断る', () => {
    const result = openTemplate({ isTemplate: false, document: createEmptyPartDocument() });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('ひな形でないものは断るはず');
    }
    expect(result.reason).toBe('notTemplate');
  });

  it('形の入っていないひな形は知らせ無しで開ける', () => {
    const template = sampleTemplate();
    const result = openTemplate({
      isTemplate: true,
      document: template.document,
      lengthUnit: template.lengthUnit,
      toolDefaults: template.toolDefaults,
    });
    if (!result.ok) {
      throw new Error(`ひな形は開けるはず: ${result.reason}`);
    }
    expect(result.notice).toBeNull();
    expect(result.template.lengthUnit).toBe('inch');
    expect(result.template.toolDefaults).toEqual(sampleToolDefaults());
  });

  it('形の入っているひな形は断らず、templateHasHistory を知らせて開く', () => {
    const result = openTemplate({ isTemplate: true, document: templateWithHistory().document });
    if (!result.ok) {
      throw new Error('形が入っていても断らないはず');
    }
    expect(result.notice).toBe('templateHasHistory');
  });

  it('スケッチに線が引いてあるだけでも「形が入っている」として知らせる', () => {
    const base = createEmptyPartDocument();
    const sketch = createEmptySketchDocument();
    const document: PartDocument = {
      ...base,
      sketches: [{ ...sketch, features: [createPointFeature(sketch, absoluteCoordinate(0, 0, 0))] }],
      activeSketchId: sketch.id,
    };
    const result = openTemplate({ isTemplate: true, document });
    if (!result.ok) {
      throw new Error('断らないはず');
    }
    expect(result.notice).toBe('templateHasHistory');
  });

  it('lengthUnit が無いひな形は mm とみなす(任意の欄)', () => {
    const result = openTemplate({ isTemplate: true, document: createEmptyPartDocument() });
    if (!result.ok) {
      throw new Error('断らないはず');
    }
    expect(result.template.lengthUnit).toBe('mm');
  });

  it('toolDefaults が無いひな形は既定の 5 欄で埋める(任意の欄)', () => {
    const result = openTemplate({ isTemplate: true, document: createEmptyPartDocument() });
    if (!result.ok) {
      throw new Error('断らないはず');
    }
    expect(result.template.toolDefaults).toEqual(DEFAULT_TOOL_DEFAULTS);
    expect(Object.keys(result.template.toolDefaults)).toHaveLength(5);
  });
});

describe('空のひな形(createEmptyPartTemplate)', () => {
  it('起動直後の部品と同じ中身に、既定の設定が付く', () => {
    const template = createEmptyPartTemplate();
    expect(template.document).toEqual(createEmptyPartDocument());
    expect(template.lengthUnit).toBe(DEFAULT_TEMPLATE_LENGTH_UNIT);
    expect(template.toolDefaults).toEqual(DEFAULT_TOOL_DEFAULTS);
  });

  it('そこから新規作成すると、空の部品ができる', () => {
    const document = documentFromTemplate(createEmptyPartTemplate());
    expect(document.solids).toEqual([]);
    expect(document.parameters).toEqual([]);
    expect(document.name).toBe('部品1');
  });
});
