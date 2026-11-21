import type { FailureText } from '../../failureText.js';
import type { SteelCondition, SteelMaterialGrade, SteelSectionCatalog } from './steelCatalog.js';
import type { SteelStandardReference } from './steelStandards.js';

/** r1 の断面の種類。この一覧と r1 の規則の表(STEEL_GRADE_RULES)は凍結し、r2 の断面は下の一覧に置く。 */
export const STEEL_SECTION_CATALOGS = [
  'flatBar', 'roundBar', 'equalAngle', 'channel', 'hBeam', 'steelPipe',
] as const satisfies readonly SteelSectionCatalog[];
/** r2（2026-11-14）で足した断面の種類と、2026-11-15 に足した軽量形鋼 6 つ・CT 形鋼。 */
export const STEEL_R2_SECTION_CATALOGS = [
  'rectTube', 'unequalAngle', 'iBeam',
  'lightChannel', 'lightZ', 'lightAngle', 'lipChannel', 'lipZ', 'hatSection', 'ctSection',
] as const satisfies readonly SteelSectionCatalog[];
type R1SteelGrade = 'SS400' | 'S45C' | 'SGP';
type R2SteelGrade = 'STKR400' | 'STK400' | 'SSC400' | 'SUS304TP';
type R1SteelSectionCatalog = typeof STEEL_SECTION_CATALOGS[number];
type R2SteelSectionCatalog = typeof STEEL_R2_SECTION_CATALOGS[number];

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
  /** 断る理由の文の鍵と差し込む値(文は ui の assembly.steel.reason.*。D4)。 */
  readonly reason: FailureText;
};

const s45cRolledSection = {
  allowed: false,
  reasonCode: 'section-not-standardized-in-grade',
  reason: { key: 'assembly.steel.reason.s45cRolledSection', parameters: {} },
  basis: [{ standardId: 'jis-g-4051-2026', locator: '7.5 その他の形状・寸法（受渡当事者間の協定）' }],
} as const satisfies SteelGradeRule;

const sgpNonPipe = {
  allowed: false,
  reasonCode: 'section-outside-scope',
  reason: { key: 'assembly.steel.reason.sgpNonPipe', parameters: {} },
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
 * JIS draft evidence is provisional; read each referenced ledger verification before display.
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
      reason: { key: 'assembly.steel.reason.ss400Pipe', parameters: {} },
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
      reason: { key: 'assembly.steel.reason.s45cPipe', parameters: {} },
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
} as const satisfies Readonly<Record<R1SteelGrade, Readonly<Record<R1SteelSectionCatalog, SteelGradeRule>>>>;

const notRolledShapeGrade = (grade: 'SS400' | 'S45C', standardId: 'jis-g-3101-2024' | 'jis-g-4051-2026',
  standard: string): Extract<SteelGradeRule, { readonly allowed: false }> => ({
  allowed: false, reasonCode: 'pipe-outside-scope',
  reason: { key: 'assembly.steel.reason.rectTubeOutsideGrade', parameters: { grade, standard } },
  basis: [{ standardId, locator: '適用範囲（角形鋼管を含まない）' }],
});
const stkrOnlyRectTube = {
  allowed: false, reasonCode: 'section-outside-scope',
  reason: { key: 'assembly.steel.reason.stkrOnlyRectTube', parameters: {} },
  basis: [{ standardId: 'jis-g-3466-2025', locator: '適用範囲・表1 種類の記号' }],
} as const satisfies SteelGradeRule;
const stkOnlyRoundPipe = {
  allowed: false, reasonCode: 'section-outside-scope',
  reason: { key: 'assembly.steel.reason.stkOnlyRoundPipe', parameters: {} },
  basis: [{ standardId: 'jis-g-3444-2025', locator: '適用範囲・表1 種類の記号' }],
} as const satisfies SteelGradeRule;
/** JIS G 3350 の軽量形鋼の種類は SSC400 の 1 種類だけ（表1）。ほかの鋼種で軽量形鋼を選ばせない。 */
const notLightGaugeGrade = (grade: 'SS400' | 'S45C'): Extract<SteelGradeRule, { readonly allowed: false }> => ({
  allowed: false, reasonCode: 'section-outside-scope',
  reason: { key: 'assembly.steel.reason.lightGaugeOutsideGrade', parameters: { grade } },
  basis: [{ standardId: 'jis-g-3350-2021', locator: '表1 種類の記号（SSC400 の 1 種類）' }],
});
const sscOnlyLightGauge = {
  allowed: false, reasonCode: 'section-outside-scope',
  reason: { key: 'assembly.steel.reason.sscOnlyLightGauge', parameters: {} },
  basis: [{ standardId: 'jis-g-3350-2021', locator: '適用範囲・表1 種類の記号' }],
} as const satisfies SteelGradeRule;
const susOnlyPipe = {
  allowed: false, reasonCode: 'section-outside-scope',
  reason: { key: 'assembly.steel.reason.susOnlyPipe', parameters: {} },
  basis: [{ standardId: 'jis-g-3459-2021', locator: '適用範囲・表1 種類の記号' }],
} as const satisfies SteelGradeRule;
const sscAllowed = (table: string, name: string, rows: number) => ({
  allowed: true,
  basis: [{ standardId: 'jis-g-3350-2021', locator: `表1 SSC400・8.1 表${table} ${name}` }],
  note: `原案の表${table}の標準断面寸法 ${rows} 行。角部の曲率半径は厚さの中心線で 1.5t（8.1）。`,
}) as const satisfies SteelGradeRule;
/** 2026-11-15 に足した 7 つの断面（軽量形鋼 6 つ・CT 形鋼）に同じ断りの規則を置く。 */
const sameRuleForAddedSections = <Rule extends SteelGradeRule>(rule: Rule) => ({
  lightChannel: rule, lightZ: rule, lightAngle: rule, lipChannel: rule, lipZ: rule, hatSection: rule, ctSection: rule,
}) as const;

/**
 * r2 の組合せ: r1 の鋼種 × r2 の断面と、r2 の鋼種 × 全ての断面。許すのは SS400 の不等辺山形鋼・I 形鋼・CT 形鋼、
 * STKR400 の角形鋼管、STK400 の鋼管、SSC400 の軽量形鋼 6 つ、SUS304TP の鋼管の 12 組だけ。鋼種の読み替えはしない。
 */
export const STEEL_R2_GRADE_RULES = {
  SS400: {
    rectTube: notRolledShapeGrade('SS400', 'jis-g-3101-2024', 'JIS G 3101（一般構造用圧延鋼材）'),
    unequalAngle: {
      allowed: true,
      basis: [
        { standardId: 'jis-g-3101-2024', locator: '表1 SS400・形鋼' },
        { standardId: 'jis-g-3192-2024', locator: '表9 不等辺山形鋼' },
      ],
      note: '原案の表9の標準断面寸法 13 行。',
    },
    iBeam: {
      allowed: true,
      basis: [
        { standardId: 'jis-g-3101-2024', locator: '表1 SS400・形鋼' },
        { standardId: 'jis-g-3192-2024', locator: '表11 I形鋼' },
      ],
      note: '原案の表11の標準断面寸法 20 行。',
    },
    lightChannel: notLightGaugeGrade('SS400'), lightZ: notLightGaugeGrade('SS400'),
    lightAngle: notLightGaugeGrade('SS400'), lipChannel: notLightGaugeGrade('SS400'),
    lipZ: notLightGaugeGrade('SS400'), hatSection: notLightGaugeGrade('SS400'),
    ctSection: {
      allowed: true,
      basis: [
        { standardId: 'jis-g-3101-2024', locator: '表1 SS400・形鋼' },
        { standardId: 'jis-g-3192-2024', locator: '表17 CT形鋼' },
      ],
      note: '原案の表17の標準断面寸法 53 行。',
    },
  },
  S45C: {
    rectTube: notRolledShapeGrade('S45C', 'jis-g-4051-2026', 'JIS G 4051（機械構造用炭素鋼鋼材）'),
    unequalAngle: s45cRolledSection,
    iBeam: s45cRolledSection,
    lightChannel: notLightGaugeGrade('S45C'), lightZ: notLightGaugeGrade('S45C'),
    lightAngle: notLightGaugeGrade('S45C'), lipChannel: notLightGaugeGrade('S45C'),
    lipZ: notLightGaugeGrade('S45C'), hatSection: notLightGaugeGrade('S45C'),
    ctSection: s45cRolledSection,
  },
  SGP: { rectTube: sgpNonPipe, unequalAngle: sgpNonPipe, iBeam: sgpNonPipe, ...sameRuleForAddedSections(sgpNonPipe) },
  STKR400: {
    flatBar: stkrOnlyRectTube, roundBar: stkrOnlyRectTube, equalAngle: stkrOnlyRectTube, channel: stkrOnlyRectTube,
    hBeam: stkrOnlyRectTube, steelPipe: stkrOnlyRectTube, unequalAngle: stkrOnlyRectTube, iBeam: stkrOnlyRectTube,
    rectTube: {
      allowed: true,
      basis: [{ standardId: 'jis-g-3466-2025', locator: '表1 STKR400・8.1 表5（正方形）・表6（長方形）' }],
      note: '原案の表5・表6の 112 行。角部の外側の半径 2t・内側の半径 t は表の注aによる。',
    },
    ...sameRuleForAddedSections(stkrOnlyRectTube),
  },
  STK400: {
    flatBar: stkOnlyRoundPipe, roundBar: stkOnlyRoundPipe, equalAngle: stkOnlyRoundPipe, channel: stkOnlyRoundPipe,
    hBeam: stkOnlyRoundPipe, rectTube: stkOnlyRoundPipe, unequalAngle: stkOnlyRoundPipe, iBeam: stkOnlyRoundPipe,
    steelPipe: {
      allowed: true,
      basis: [{ standardId: 'jis-g-3444-2025', locator: '表1 STK400・8.1 表6 管の寸法' }],
      note: '原案の表6の 128 行。管端は指定が無ければプレンエンド（5 c）。',
    },
    ...sameRuleForAddedSections(stkOnlyRoundPipe),
  },
  SSC400: {
    flatBar: sscOnlyLightGauge, roundBar: sscOnlyLightGauge, equalAngle: sscOnlyLightGauge, channel: sscOnlyLightGauge,
    hBeam: sscOnlyLightGauge, steelPipe: sscOnlyLightGauge, rectTube: sscOnlyLightGauge, unequalAngle: sscOnlyLightGauge,
    iBeam: sscOnlyLightGauge, ctSection: sscOnlyLightGauge,
    lightChannel: sscAllowed('5', '軽溝形鋼', 31), lightZ: sscAllowed('6', '軽Z形鋼', 7),
    lightAngle: sscAllowed('7', '軽山形鋼', 6), lipChannel: sscAllowed('8', 'リップ溝形鋼', 37),
    lipZ: sscAllowed('9', 'リップZ形鋼', 2), hatSection: sscAllowed('10', 'ハット形鋼', 8),
  },
  SUS304TP: {
    flatBar: susOnlyPipe, roundBar: susOnlyPipe, equalAngle: susOnlyPipe, channel: susOnlyPipe, hBeam: susOnlyPipe,
    rectTube: susOnlyPipe, unequalAngle: susOnlyPipe, iBeam: susOnlyPipe, ...sameRuleForAddedSections(susOnlyPipe),
    steelPipe: {
      allowed: true,
      basis: [{ standardId: 'jis-g-3459-2021', locator: '表1 SUS304TP・10.1 表7（管の寸法）・表8（溶接鋼管）・表9 単位質量の算出式' }],
      note: '原案の表7の 139 組と、表8 の溶接鋼管の表7 と違う寸法 51 組。管端は指定が無ければプレンエンド（5 c）。',
    },
  },
} as const satisfies Readonly<Record<R1SteelGrade, Readonly<Record<R2SteelSectionCatalog, SteelGradeRule>>>>
  & Readonly<Record<R2SteelGrade, Readonly<Record<SteelSectionCatalog, SteelGradeRule>>>>;

function r1Catalog(catalog: SteelSectionCatalog): catalog is R1SteelSectionCatalog {
  return STEEL_SECTION_CATALOGS.some((candidate) => candidate === catalog);
}
function r2Grade(material: SteelMaterialGrade): material is R2SteelGrade {
  return material === 'STKR400' || material === 'STK400' || material === 'SSC400' || material === 'SUS304TP';
}

export function steelGradeRule(material: SteelMaterialGrade, catalog: SteelSectionCatalog): SteelGradeRule {
  if (r2Grade(material)) return STEEL_R2_GRADE_RULES[material][catalog];
  return r1Catalog(catalog) ? STEEL_GRADE_RULES[material][catalog] : STEEL_R2_GRADE_RULES[material][catalog];
}

export type S45cProductRule = ({ readonly allowed: true } & SteelGradeConditionRule) | {
  readonly allowed: false;
  readonly reasonCode: SteelGradeRejectionCode | 'condition-not-supported' | 'product-standard-mismatch';
  readonly reason: FailureText;
  readonly basis: SteelGradeRuleBasis;
};

/** S45C has no r2 family: I sections and the other r2 sections return their denial reason. */
export function s45cProductRule(catalog: SteelSectionCatalog, condition: string,
  productStandard: string): S45cProductRule {
  if (catalog === 'iBeam') return s45cRolledSection;
  if (!r1Catalog(catalog)) return STEEL_R2_GRADE_RULES.S45C[catalog];
  const family = STEEL_GRADE_RULES.S45C[catalog];
  if (!family.allowed) return family;
  const rule = family.conditions.find((candidate) => candidate.condition === condition);
  if (rule === undefined) {
    return {
      allowed: false, reasonCode: 'condition-not-supported', basis: [s45cUnspecifiedTreatment],
      reason: { key: 'assembly.steel.reason.s45cConditionNotSupported', parameters: {} },
    };
  }
  if (rule.productStandard !== productStandard) {
    return {
      allowed: false, reasonCode: 'product-standard-mismatch', basis: rule.basis,
      reason: { key: 'assembly.steel.reason.s45cProductStandardMismatch', parameters: { productStandard: rule.productStandard } },
    };
  }
  return { allowed: true, ...rule };
}
