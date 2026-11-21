import {
  STEEL_GRADE_RULES, STEEL_MATERIAL_GRADES, STEEL_R2_MATERIAL_GRADES, STEEL_SECTION_CATALOGS, STEEL_STANDARDS, steelGradeRule,
  type FailureText,
} from '@pointercad/model';
import {
  buildStandardPartFromSourceWithReason, s45cProductRule, S45C_REJECTED_SECTIONS, STEEL_R2_SECTION_CATALOGS,
  steelMessageRejectionSourcesForUi,
} from '@pointercad/model/testing/ui-fixtures';
import { describe, expect, it } from 'vitest';

import { failureMessage } from '../i18n/failureMessage.js';
import { MESSAGE_KEYS } from '../i18n/t.js';

/**
 * 鋼材の断りの文は ui の文言の表が持つ(D4。model は鍵と差し込む値だけを返す)。model・io の検査が値として見ている規格の番号・名前・
 * 箇条などを、ここでは作った文として見る(model の steelRejection・steelGradeRules・steelS45cOracle・steelR2Catalog、io の steelPersistence から移した照らし)。
 */
function expectKnownKeys(text: FailureText): void {
  expect(MESSAGE_KEYS, text.key).toContain(text.key);
  for (const value of Object.values(text.parameters)) if (typeof value !== 'string') expectKnownKeys(value);
}
const REASON_CODES = new Set(['pipe-outside-scope', 'section-not-standardized-in-grade', 'section-outside-scope', 'size-not-in-catalog']);

describe('鋼材の断りの文(ui の文言の表で作る)', () => {
  it('全部の理由の符号の文が差し込み残りなく作れ、規格の番号・名前・箇条と食い違った欄を含む', () => {
    const codes = new Set<string>();
    for (const source of steelMessageRejectionSourcesForUi()) {
      const rejection = buildStandardPartFromSourceWithReason(source).rejection;
      if (rejection === null) continue;
      codes.add(rejection.code);
      expectKnownKeys(rejection.text);
      const message = failureMessage(rejection.text);
      expect(message).not.toMatch(/\{[^}]+\}/);
      if (rejection.basis.length > 0) {
        expect(message).toMatch(/[ぁ-んァ-ン一-龠]/u);
        for (const basis of rejection.basis) {
          expect(message).toContain(STEEL_STANDARDS[basis.standardId].number);
          expect(message).toContain(STEEL_STANDARDS[basis.standardId].name);
          expect(message).toContain(basis.locator);
        }
      }
      if (REASON_CODES.has(rejection.code) && rejection.basis.length > 0) {
        expect(message).toMatch(/JIS G [0-9]{4}/u);
        expect(message).toMatch(/適用範囲|箇条|表[0-9０-９]|[0-9]+[.][0-9]+/u);
      }
      for (const field of rejection.fields) expect(message).toContain(field);
      if (rejection.code === 'unsupported-catalog-revision' || rejection.code === 'unsupported-generator-revision') {
        expect(message).toContain('版');
      }
      if (rejection.code === 'invalid-steel-length') expect(message).toContain('長さ');
    }
    expect(codes.size).toBe(11);
  });

  it('r1 の断る組の理由の文は日本語で、鋼種・適用範囲か 7.5・引用した規格の番号と名前を含む', () => {
    let denied = 0;
    for (const grade of STEEL_MATERIAL_GRADES) {
      for (const catalog of STEEL_SECTION_CATALOGS) {
        const rule = STEEL_GRADE_RULES[grade][catalog];
        if (rule.allowed) continue;
        denied += 1;
        expectKnownKeys(rule.reason);
        const message = failureMessage(rule.reason);
        expect(message).toMatch(/[ぁ-んァ-ヶ一-龯]/u);
        expect(message).toContain(grade);
        expect(message).toMatch(/適用範囲|7[.]5/u);
        for (const citation of rule.basis) {
          expect(message).toContain(STEEL_STANDARDS[citation.standardId].number);
          expect(message).toContain(STEEL_STANDARDS[citation.standardId].name);
        }
      }
    }
    expect(denied).toBeGreaterThan(0);
  });

  it('S45C の圧延形鋼と鋼管の理由の文は JIS G 4051・機械構造用炭素鋼鋼材・箇条を含み、形鋼は 7.5 と協定品を書く', () => {
    for (const [catalog, , clause] of S45C_REJECTED_SECTIONS) {
      for (const condition of ['brightBar-heatTreatmentUnspecified', 'hotRolled-heatTreatmentUnspecified', 'QT']) {
        const rule = s45cProductRule(catalog, condition, 'JIS G 4051');
        if (rule.allowed) throw new Error(`Unexpected S45C permission: ${catalog}`);
        expectKnownKeys(rule.reason);
        const message = failureMessage(rule.reason);
        expect(message).toContain('JIS G 4051');
        expect(message).toContain('機械構造用炭素鋼鋼材');
        expect(message).toContain(clause);
        if (catalog !== 'steelPipe') {
          expect(message).toContain('7.5');
          expect(message).toContain('協定品');
        }
      }
    }
  });

  it('S45C の製品規格の読み替えと熱処理の条件を断る文は、正しい製品規格と箇条を含む', () => {
    const conditions = [
      ['roundBar', 'brightBar-heatTreatmentUnspecified', 'JIS G 3123'],
      ['flatBar', 'brightBar-heatTreatmentUnspecified', 'JIS G 3123'],
      ['roundBar', 'hotRolled-heatTreatmentUnspecified', 'JIS G 4051'],
      ['flatBar', 'hotRolled-heatTreatmentUnspecified', 'JIS G 3194'],
    ] as const;
    for (const [catalog, condition, expectedStandard] of conditions) {
      for (const standard of ['JIS G 3123', 'JIS G 4051', 'JIS G 3194', 'JIS G 3191', 'JIS G 3452', '']) {
        if (standard === expectedStandard) continue;
        const result = s45cProductRule(catalog, condition, standard);
        if (result.allowed) throw new Error(`Accepted wrong standard: ${standard}`);
        expectKnownKeys(result.reason);
        const message = failureMessage(result.reason);
        expect(message).toContain(expectedStandard);
        expect(message).toContain('JIS G 4051 7.1・7.3');
      }
    }
    for (const condition of ['N', 'A', 'QT', 'Q', 'T', 'normalized', 'annealed', 'quenched-tempered', '焼ならし',
      '焼なまし', '焼入焼戻し', 'hotRolled-QT', 'brightBar-N', 'blackPipe-plainEnds', '']) {
      for (const catalog of ['roundBar', 'flatBar'] as const) {
        const rule = s45cProductRule(catalog, condition, 'JIS G 4051');
        if (rule.allowed) throw new Error(`Accepted unsupported condition: ${condition}`);
        expectKnownKeys(rule.reason);
        const message = failureMessage(rule.reason);
        expect(message).toContain('JIS G 4051 5 c)');
        expect(message).toContain('熱処理未指定');
      }
    }
  });

  it('r2 の断る組の理由の文は、鋼種と引用した規格の番号を含む', () => {
    const pairs = [
      ...(['SS400', 'S45C', 'SGP'] as const).flatMap((grade) => STEEL_R2_SECTION_CATALOGS.map((catalog) => ({ grade, catalog }))),
      ...STEEL_R2_MATERIAL_GRADES.flatMap((grade) => [...STEEL_SECTION_CATALOGS, ...STEEL_R2_SECTION_CATALOGS]
        .map((catalog) => ({ grade, catalog }))),
    ];
    let denied = 0;
    for (const { grade, catalog } of pairs) {
      const rule = steelGradeRule(grade, catalog);
      if (rule.allowed) continue;
      denied += 1;
      expectKnownKeys(rule.reason);
      const message = failureMessage(rule.reason);
      expect(message).toContain(grade);
      for (const citation of rule.basis) expect(message).toContain(STEEL_STANDARDS[citation.standardId].number);
    }
    expect(denied).toBeGreaterThan(0);
  });
});
