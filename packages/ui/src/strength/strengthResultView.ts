import { strengthFormulas, type StrengthFieldName, type StrengthResultName } from '@pointercad/model';
import { t, type MessageKey } from '../i18n/t.js';
import type { StrengthSnapshot } from './strengthSession.js';
import { displayNumber } from '../sketch/numericInputPresentation.js';

const resultLabels: Readonly<Record<StrengthResultName, MessageKey>> = {
  secondMoment: 'strength.result.secondMoment', sectionModulus: 'strength.result.sectionModulus', innerDiameter: 'strength.result.innerDiameter',
  moment: 'strength.result.moment', stress: 'strength.result.stress', deflection: 'strength.result.deflection',
  equivalentStress: 'strength.result.equivalentStress', allowableStress: 'strength.result.allowableStress',
  actualSafetyFactor: 'strength.result.actualSafetyFactor', reserveFactor: 'strength.result.reserveFactor',
  polarMoment: 'strength.result.polarMoment', polarModulus: 'strength.result.polarModulus',
  shearStress: 'strength.result.shearStress', twist: 'strength.result.twist',
};
const symbols: Readonly<Record<StrengthResultName | StrengthFieldName, string>> = {
  width: 'b', height: 'h', diameter: 'd', thickness: 't', length: 'L', force: 'F', youngModulus: 'E',
  yieldStress: 'σy', safetyFactor: 'n', outerDiameter: 'D', innerDiameter: 'dᵢ', torque: 'T',
  shearModulus: 'G', tensileArea: 'As', secondMoment: 'I', sectionModulus: 'Z', moment: 'M', stress: 'σ',
  deflection: 'δ', equivalentStress: 'σeq', allowableStress: 'σallow', actualSafetyFactor: 'nₐ',
  reserveFactor: 'R', polarMoment: 'Ip', polarModulus: 'Zp', shearStress: 'τ', twist: 'θ',
};
const symbolMap = new Map(Object.entries(symbols));
/** 公式の名前の所へ値を入れる。値は括弧で囲む。 */
function substitute(source: string, values: ReadonlyMap<string, string>): string {
  return source.replace(/[A-Za-z]+/gu, token => values.has(token) ? `(${values.get(token) ?? ''})` : token === 'pi' ? 'π' : token === 'sqrt' ? '√' : token);
}

/**
 * 結果の 1 行。画面の文字(display・substitutedDisplay)は有効 6 桁(UI の点検の指摘 27、利用者の決定 2026-11-14)、
 * 全部の桁(exact・substituted)は説明の title へ出す。計算の中の値は変えない。
 */
export function strengthResultRows(snapshot: StrengthSnapshot) {
  const variables = new Map(Array.from(snapshot.value.inputs, ([key, input]) => [key, input.canonical.exact]));
  const shortValues = new Map(Array.from(snapshot.value.inputs, ([key, input]) => [key, displayNumber(input.canonical.value).text]));
  return strengthFormulas(snapshot.value.calculation).map(([name, source]) => {
    const result = snapshot.value.results.get(name);
    const substituted = substitute(source, variables);
    const substitutedDisplay = substitute(source, shortValues);
    const formula = source.replace(/[A-Za-z]+/gu, token => symbolMap.get(token) ?? (token === 'pi' ? 'π' : token === 'sqrt' ? '√' : token));
    if (result !== undefined) {
      variables.set(name, result.exact);
      shortValues.set(name, displayNumber(result.value).text);
    }
    return { name, label: t(resultLabels[name]), formula: `${symbols[name]} = ${formula}`, substituted, substitutedDisplay,
      exact: result?.exact ?? '', display: result === undefined ? '—' : displayNumber(result.value).text };
  });
}
