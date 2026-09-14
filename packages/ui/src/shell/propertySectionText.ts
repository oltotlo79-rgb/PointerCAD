import { t, type MessageKey } from '../i18n/t.js';

/** 「{count}」を数で埋める(`t()` は置換をしない。`sketch/constraintActions.ts` と同じ書き方)。 */
export function withCount(key: MessageKey, count: number): string {
  return t(key).replace('{count}', String(count));
}
