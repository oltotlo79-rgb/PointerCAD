import { strengthFormulas, type StrengthFieldName, type StrengthResultName } from '@pointercad/model';
import { t, type MessageKey } from '../i18n/t.js';
import type { StrengthSnapshot } from './strengthSession.js';
import { FIELD_VALUE_DISPLAY_DIGITS, roundToSignificantDigits } from '../sketch/numericInput.js';

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
export function strengthResultRows(snapshot: StrengthSnapshot) {
  const variables = new Map(Array.from(snapshot.value.inputs, ([key, input]) => [key, input.canonical.exact]));
  return strengthFormulas(snapshot.value.calculation).map(([name, source]) => {
    const result = snapshot.value.results.get(name);
    const substituted = source.replace(/[A-Za-z]+/gu, token => variables.has(token) ? `(${variables.get(token) ?? ''})` : token === 'pi' ? 'π' : token === 'sqrt' ? '√' : token);
    const formula = source.replace(/[A-Za-z]+/gu, token => symbolMap.get(token) ?? (token === 'pi' ? 'π' : token === 'sqrt' ? '√' : token));
    if (result !== undefined) variables.set(name, result.exact);
    return { name, label: t(resultLabels[name]), formula: `${symbols[name]} = ${formula}`, substituted,
      exact: result?.exact ?? '', display: result === undefined ? '—' : String(roundToSignificantDigits(result.value, FIELD_VALUE_DISPLAY_DIGITS)) };
  });
}
