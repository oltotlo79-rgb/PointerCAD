import type { FailureText } from '../failureText.js';

/** A refused input. Existing callers may still read the original Error.message. */
export class ParameterInputError extends Error {
  readonly text: FailureText;

  constructor(message: string, key: string) {
    super(message);
    this.text = { key, parameters: {} };
  }
}
