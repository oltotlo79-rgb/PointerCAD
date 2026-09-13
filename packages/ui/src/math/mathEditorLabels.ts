import { t } from '../i18n/t.js';
import type { MathEditorLabels } from './MathEditorSurface.js';
export function mathEditorLabels(): MathEditorLabels {
  return {
    title: t('math.title'), text: t('math.text'), structured: t('math.structured'), input: t('math.input'),
    angleUnit: t('math.angleUnit'), degree: t('math.degree'), radian: t('math.radian'), palette: t('math.palette'),
    search: t('math.search'), noSymbols: t('math.noSymbols'), apply: t('math.apply'), cancel: t('math.cancel'),
    help: t('math.help'), keyboardHint: t('math.keyboardHint'), sourceTooLong: t('math.sourceTooLong'),
    category: t('math.category'), allCategories: t('math.allCategories'), categories: {
      basic: t('math.category.basic'), functions: t('math.category.functions'), calculus: t('math.category.calculus'),
      'linear-algebra': t('math.category.linear-algebra'), complex: t('math.category.complex'),
      series: t('math.category.series'), statistics: t('math.category.statistics'),
      'sets-logic': t('math.category.sets-logic'), equations: t('math.category.equations'), symbols: t('math.category.symbols'),
    },
  };
}
