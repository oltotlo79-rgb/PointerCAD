import type { SteelCondition, SteelMaterialGrade, SteelSectionCatalog } from './steelCatalog.js';
import type { SteelStandardReference } from './steelStandards.js';

export const STEEL_SECTION_CATALOGS = [
  'flatBar', 'roundBar', 'equalAngle', 'channel', 'hBeam', 'steelPipe',
] as const satisfies readonly SteelSectionCatalog[];

export type SteelGradeRejectionCode = 'pipe-outside-scope'
  | 'section-not-standardized-in-grade' | 'section-outside-scope';

type SteelGradeRuleBasis = readonly [SteelStandardReference, ...SteelStandardReference[]];

/** A product/condition rule is not evidence for an individual catalog size or a strength value. */
export interface SteelGradeConditionRule {
  readonly condition: SteelCondition;
  readonly productStandard: string;
  readonly basis: SteelGradeRuleBasis;
  readonly note: string;
}

/** Permission describes the existing catalog family, not every size, condition or strength. */
export type SteelGradeRule = {
  readonly allowed: true;
  readonly basis: SteelGradeRuleBasis;
  readonly note: string;
  readonly conditions?: readonly SteelGradeConditionRule[];
} | {
  readonly allowed: false;
  readonly basis: SteelGradeRuleBasis;
  readonly reasonCode: SteelGradeRejectionCode;
  readonly reason: string;
};

const s45cRolledSection = {
  allowed: false,
  reasonCode: 'section-not-standardized-in-grade',
  reason: 'S45Cの圧延形鋼はJIS G 4051（機械構造用炭素鋼鋼材）の7.5により標準断面が規定されていない（協定品）。',
  basis: [{ standardId: 'jis-g-4051-2026', locator: '7.5 その他の形状・寸法（受渡当事者間の協定）' }],
} as const satisfies SteelGradeRule;

const sgpNonPipe = {
  allowed: false,
  reasonCode: 'section-outside-scope',
  reason: 'SGPはJIS G 3452（配管用炭素鋼鋼管）の適用範囲にある鋼管の記号で、鋼管以外の断面は対象外。',
  basis: [{ standardId: 'jis-g-3452-2026', locator: '適用範囲（配管用炭素鋼鋼管）' }],
} as const satisfies SteelGradeRule;

const s45cUnspecifiedTreatment = {
  standardId: 'jis-g-4051-2026', locator: '5 c)・注2 熱処理は注文者指定、機械的性質は別途協定',
} as const satisfies SteelStandardReference;

const s45cBrightCondition = {
  condition: 'brightBar-heatTreatmentUnspecified',
  productStandard: 'JIS G 3123',
  basis: [
    { standardId: 'jis-g-4051-2026', locator: '表1 S45C（鋼種の分類）' },
    { standardId: 'jis-g-3123-2004', locator: 'みがき棒鋼の適用形状（製造元資料、規格本文・寸法表は未確認）' },
  ],
  note: 'みがき丸鋼・平鋼は製造元資料で確認した寸法に限る。加工方法と熱処理条件は未指定。',
} as const satisfies SteelGradeConditionRule;

/**
 * Complete 3 grades x 6 families: 8 allowed, 10 denied. No grade substitution.
 * JISF draft evidence is provisional; read each referenced ledger verification before display.
 * Existing S45C bright bars remain allowed, with the missing G 3123 text explicitly recorded.
 */
export const STEEL_GRADE_RULES = {
  SS400: {
    flatBar: {
      allowed: true,
      basis: [
        { standardId: 'jis-g-3101-2024', locator: '表1 SS400・平鋼（厚さ100 mm以下）' },
        { standardId: 'jis-g-3194-2024', locator: '箇条5・表1 標準厚さ / 表2 標準幅' },
      ],
      note: '既存の平鋼5行は原案の標準厚さ・幅に含まれる。保存上の製品規格と供給長さは製造元資料のまま。',
    },
    roundBar: {
      allowed: true,
      basis: [
        { standardId: 'jis-g-3101-2024', locator: '表1 SS400・棒鋼' },
        { standardId: 'jis-g-3191-2022', locator: '3.1 丸鋼 / 表1 標準径' },
      ],
      note: '既存の丸鋼5行は原案の推奨径に含まれる。保存上の製品規格は製造元資料のまま。',
    },
    equalAngle: {
      allowed: true,
      basis: [
        { standardId: 'jis-g-3101-2024', locator: '表1 SS400・形鋼' },
        { standardId: 'jis-g-3192-2024', locator: '表8 等辺山形鋼' },
      ],
      note: '既存の等辺山形鋼3行は原案の標準断面寸法に含まれる。',
    },
    channel: {
      allowed: true,
      basis: [
        { standardId: 'jis-g-3101-2024', locator: '表1 SS400・形鋼' },
        { standardId: 'jis-g-3192-2024', locator: '表12 溝形鋼' },
      ],
      note: '既存の溝形鋼3行は原案の標準断面寸法に含まれる。',
    },
    hBeam: {
      allowed: true,
      basis: [
        { standardId: 'jis-g-3101-2024', locator: '表1 SS400・形鋼' },
        { standardId: 'jis-g-3192-2024', locator: '表15 H形鋼' },
      ],
      note: '既存のH形鋼3行は原案の標準断面寸法に含まれる。',
    },
    steelPipe: {
      allowed: false,
      reasonCode: 'pipe-outside-scope',
      reason: 'SS400の鋼管はJIS G 3101（一般構造用圧延鋼材）の適用範囲・表1に含まれない。',
      basis: [{ standardId: 'jis-g-3101-2024', locator: '適用範囲・表1（鋼板・鋼帯・形鋼・棒鋼・平鋼）' }],
    },
  },
  S45C: {
    flatBar: {
      allowed: true,
      basis: [
        { standardId: 'jis-g-4051-2026', locator: '表1 S45C / 7.3 平鋼（熱間圧延材の寸法はG 3194）' },
        { standardId: 'jis-g-3123-2004', locator: 'みがき棒鋼の適用形状・寸法表（規格本文は未確認）' },
      ],
      note: '既存のみがき平鋼3行を製造元資料で確認。JIS G 3123の原案・寸法表は未確認。熱間圧延材や熱処理条件の追加を許可する表ではない。',
      conditions: [s45cBrightCondition, {
        condition: 'hotRolled-heatTreatmentUnspecified',
        productStandard: 'JIS G 3194',
        basis: [
          s45cUnspecifiedTreatment,
          { standardId: 'jis-g-4051-2026', locator: '7.3 熱間圧延平鋼（形状・寸法はG 3194）' },
          { standardId: 'jis-g-3194-2024', locator: '箇条5・表1 標準厚さ / 表2 標準幅' },
        ],
        note: '熱間圧延平鋼の寸法はJIS G 4051 7.3によるJIS G 3194の格子と製造元表を個別に照合する。熱処理・強度値は指定しない。',
      }],
    },
    roundBar: {
      allowed: true,
      basis: [
        { standardId: 'jis-g-4051-2026', locator: '表1 S45C / 7.1・表3 棒鋼（熱間圧延材）' },
        { standardId: 'jis-g-3123-2004', locator: 'みがき棒鋼の適用形状・寸法表（規格本文は未確認）' },
      ],
      note: '既存のみがき丸鋼3行を製造元資料で確認。JIS G 3123の原案・寸法表は未確認。G 4051の熱間圧延の表3をみがき材の寸法表として扱わない。',
      conditions: [s45cBrightCondition, {
        condition: 'hotRolled-heatTreatmentUnspecified',
        productStandard: 'JIS G 4051',
        basis: [
          s45cUnspecifiedTreatment,
          { standardId: 'jis-g-4051-2026', locator: '7.1.1・表3 熱間圧延丸鋼の推奨径（括弧なし）' },
          { standardId: 'jis-g-3191-2022', locator: 'G 4051 7.1.2が引用する表4・表5の寸法許容差' },
        ],
        note: '熱間圧延丸鋼の径はJIS G 4051 表3の推奨径と出典を個別に照合する。みがき材の寸法表を流用せず、供給長さ・熱処理・強度値を推定しない。',
      }],
    },
    equalAngle: s45cRolledSection,
    channel: s45cRolledSection,
    hBeam: s45cRolledSection,
    steelPipe: {
      allowed: false,
      reasonCode: 'pipe-outside-scope',
      reason: 'S45Cの鋼管はJIS G 4051（機械構造用炭素鋼鋼材）の箇条1（適用範囲）外。鋼管にはこの規格を適用しない。',
      basis: [{ standardId: 'jis-g-4051-2026', locator: '適用範囲（鋼管を除外）' }],
    },
  },
  SGP: {
    flatBar: sgpNonPipe,
    roundBar: sgpNonPipe,
    equalAngle: sgpNonPipe,
    channel: sgpNonPipe,
    hBeam: sgpNonPipe,
    steelPipe: {
      allowed: true,
      basis: [{ standardId: 'jis-g-3452-2026', locator: '適用範囲・表4 寸法及び単位質量' }],
      note: '既存の鋼管6行は黒管・プレーンエンド。5,500 mmは製造元の標準長さで、JISの指定長さの規定とは区別する。',
    },
  },
} as const satisfies Readonly<Record<SteelMaterialGrade, Readonly<Record<SteelSectionCatalog, SteelGradeRule>>>>;

export function steelGradeRule(material: SteelMaterialGrade, catalog: SteelSectionCatalog): SteelGradeRule {
  return STEEL_GRADE_RULES[material][catalog];
}

export type S45cProductRule = ({ readonly allowed: true } & SteelGradeConditionRule) | {
  readonly allowed: false;
  readonly reasonCode: SteelGradeRejectionCode | 'condition-not-supported' | 'product-standard-mismatch';
  readonly reason: string;
  readonly basis: SteelGradeRuleBasis;
};

/** I sections can be queried for a reason without adding a selectable or persisted catalog family. */
export function s45cProductRule(catalog: SteelSectionCatalog | 'iBeam', condition: string,
  productStandard: string): S45cProductRule {
  if (catalog === 'iBeam') return s45cRolledSection;
  const family = STEEL_GRADE_RULES.S45C[catalog];
  if (!family.allowed) return family;
  const rule = family.conditions.find((candidate) => candidate.condition === condition);
  if (rule === undefined) {
    return {
      allowed: false, reasonCode: 'condition-not-supported', basis: [s45cUnspecifiedTreatment],
      reason: 'S45CはJIS G 4051 5 c)により熱処理を注文者が指定する。カタログは熱処理未指定だけを扱い、焼ならし・焼なまし・焼入焼戻し等の条件や強度を推定しない。',
    };
  }
  if (rule.productStandard !== productStandard) {
    return {
      allowed: false, reasonCode: 'product-standard-mismatch', basis: rule.basis,
      reason: `S45Cのこの製品条件で参照する寸法・製品規格は${rule.productStandard}。JIS G 4051 7.1・7.3の熱間圧延材とJIS G 3123のみがき材を読み替えない。`,
    };
  }
  return { allowed: true, ...rule };
}
