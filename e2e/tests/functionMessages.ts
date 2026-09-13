import { uiMessage } from './uiMessages.js';

// Type-only imports keep Node's JSON loading behavior unchanged.
type SketchMessages = typeof import('../../packages/ui/src/i18n/ja/sketch.json');
type MathMessages = typeof import('../../packages/ui/src/i18n/ja/math.json');
type Suffix<Key, Prefix extends string> = Key extends `${Prefix}.${infer Name}` ? Name : never;

export function functionPlotMessage(key: Suffix<keyof SketchMessages, 'functionPlot'>): string {
  return uiMessage('sketch', `functionPlot.${key}`);
}

export function functionPointMessage(key: Suffix<keyof SketchMessages, 'functionPoint'>): string {
  return uiMessage('sketch', `functionPoint.${key}`);
}

export function functionSectionMessage(key: Suffix<keyof SketchMessages, 'functionSection'>): string {
  return uiMessage('sketch', `functionSection.${key}`);
}

export function functionCoefficientMessage(key: Suffix<keyof MathMessages, 'functionCoefficient'>): string {
  return uiMessage('math', `functionCoefficient.${key}`);
}
