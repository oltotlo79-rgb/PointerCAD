import type { FailureText } from '@pointercad/model';
import { failureMessage } from '../i18n/failureMessage.js';
import { t } from '../i18n/t.js';

export function strengthFailureMessage(failure: { readonly message: string; readonly text?: FailureText }): string {
  return failure.text === undefined ? failure.message : failureMessage(failure.text);
}

export function strengthInternalFailure(field: string, cause: unknown) {
  console.error('PointerCAD strength calculation', cause);
  return { ok: false, field, message: t('assembly.error.internal') } as const;
}
