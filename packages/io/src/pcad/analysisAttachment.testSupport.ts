import { isRecord } from './guards.js';

/** Replace the saved analysis attachment while preserving the rest of the JSON envelope. */
export function replaceAttachment(serialized: string, value: unknown, message = 'Expected a document envelope'): string {
  const envelope: unknown = JSON.parse(serialized);
  if (!isRecord(envelope) || !isRecord(envelope.document)) throw new Error(message);
  return JSON.stringify({ ...envelope, document: { ...envelope.document, beamAnalysisInputs: value } });
}
