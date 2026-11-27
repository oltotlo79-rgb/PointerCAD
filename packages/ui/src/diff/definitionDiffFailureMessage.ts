import { openErrorMessage } from '../file/documentReadError.js';
import { messageText } from '../i18n/failureMessage.js';
import { t, type MessageKey } from '../i18n/t.js';
import type { DefinitionDiffFailure } from './definitionDiffProtocol.js';

const failureKeys = {
  invalidRequest: 'documentDiff.failed',
  fileLimit: 'documentDiff.fileLimit',
  partRequired: 'documentDiff.partRequired',
  duplicateIdentifier: 'documentDiff.duplicateIdentifier',
  comparisonLimit: 'documentDiff.comparisonLimit',
  internal: 'assembly.error.internal',
} satisfies Record<Exclude<DefinitionDiffFailure['code'], 'documentRead'>, MessageKey>;

export function definitionDiffFailureMessage(failure: DefinitionDiffFailure): string {
  if (failure.code !== 'documentRead') return t(failureKeys[failure.code]);
  // The archive code selects the open-file translation without carrying the legacy reader text.
  return messageText(openErrorMessage(failure.diagnostic === undefined ? failure.reason
    : { code: failure.reason, diagnostic: failure.diagnostic, message: '' }));
}
