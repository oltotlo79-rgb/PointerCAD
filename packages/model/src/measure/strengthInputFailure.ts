import type { FailureText } from '../failureText.js';

/** The legacy message stays available to callers using the original calculation API. */
export interface StrengthInputFailure {
  readonly ok: false;
  readonly field: string;
  readonly message: string;
  readonly text?: FailureText;
}

export function strengthInputFailure(field: string, message: string, key: string,
  parameters: FailureText['parameters'] = {}): StrengthInputFailure {
  return { ok: false, field, message, text: { key, parameters } };
}
