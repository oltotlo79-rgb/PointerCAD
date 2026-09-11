import type { SplitLineFailure } from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';

const messages: Readonly<Record<SplitLineFailure, MessageKey>> = {
  missingLine: 'splitLines.error.missingLine',
  constrainedLine: 'splitLines.error.constrainedLine',
  invalidReferences: 'splitLines.error.invalidReferences',
};
export function splitLineFailureMessage(reason: SplitLineFailure): MessageKey { return messages[reason]; }
