import type { ParseDocumentResult, ParseErrorCode } from './documentJson.js';
import type { ReadPcadFileErrorCode, ReadPcadFileResult } from './pcadFile.js';

function codedFailure<Code extends ReadPcadFileErrorCode>(code: Code, message: string): {
  readonly ok: false;
  readonly error: { readonly code: Code; readonly message: string };
} {
  return { ok: false, error: { code, message } };
}

/** JSON readers accept only their existing parse codes. */
export const parseFailure: (
  code: ParseErrorCode, message: string,
) => Extract<ParseDocumentResult, { readonly ok: false }> = codedFailure;

/** Archive readers also accept notZip and missingDocument. */
export const fileFailure: (
  code: ReadPcadFileErrorCode, message: string,
) => Extract<ReadPcadFileResult, { readonly ok: false }> = codedFailure;
