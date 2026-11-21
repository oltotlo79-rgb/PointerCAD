import type { ParameterUnit } from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';

/**
 * 係数の単位の見出し(係数の窓と図面の係数の表が同じ表を使う)。長さと角度は既存の欄と同じ文言を使い回す(同じ語を 2 か所に書かない)。
 * 「なし」だけはこの表にしか出てこないので新しく足す。
 */
export const PARAMETER_UNIT_KEYS: Readonly<Record<ParameterUnit, MessageKey>> = {
  mm: 'numericInput.unit.mm',
  degree: 'numericInput.unit.degree',
  none: 'parameterPanel.unit.none',
};
