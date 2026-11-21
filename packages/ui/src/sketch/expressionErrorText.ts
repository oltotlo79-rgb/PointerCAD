import type { ExpressionError } from '@pointercad/expression';
import { t, type MessageKey } from '../i18n/t.js';

const HINT_MESSAGES: Record<NonNullable<ExpressionError['hint']>['key'], MessageKey> = {
  explicitMultiplication: 'expression.hint.explicitMultiplication',
  supportedFunctions: 'expression.hint.supportedFunctions',
};

export function expressionErrorText(error: ExpressionError): string {
  const parts = [error.message];
  const hint = error.hint;
  if (hint !== undefined) {
    const message = t(HINT_MESSAGES[hint.key]);
    parts.push(hint.key === 'explicitMultiplication'
      ? message.replace('{数}', () => hint.numberText).replace('{名前}', () => hint.name)
      : message.replace('{一覧}', () => hint.names.join('・')));
  }
  if (error.suggestions !== undefined && error.suggestions.length > 0) {
    parts.push(t('expression.suggestions') + ' ' + error.suggestions.join('、'));
  }
  return parts.join(' ');
}
