import { canonicalDrawingSourceText, sha256HexChunksSync, sha256HexSync } from '@pointercad/model';
import { decodeUtf8 } from '../decodeUtf8.js';
import { isRecord } from './guards.js';

type BindingInput = readonly [name: string, bytes: Uint8Array | readonly (Uint8Array | undefined)[], documentEnvelope: boolean];

function documentContent(bytes: Uint8Array): Uint8Array {
  const text = decodeUtf8(bytes);
  const envelope: unknown = text === null ? null : JSON.parse(text);
  if (!isRecord(envelope)) throw new Error('Invalid document envelope');
  // Only the envelope owns the save timestamp. Nested fields with this name are input.
  delete envelope.savedAt;
  return new TextEncoder().encode(canonicalDrawingSourceText(envelope));
}

/** SHA-256 of UTF-8 JSON pairs [entry name, SHA-256], sorted by name (UTF-16 code units).
 * Document envelopes, including embedded ones, are canonical JSON without their own savedAt.
 * The final digest and each entry digest use the model's synchronous SHA-256 (sha256HexSync), because .pcad reading is synchronous.
 */
export function analysisResultBinding(inputs: Iterable<BindingInput>): string {
  const digests: [string, string][] = [];
  for (const [name, bytes, documentEnvelope] of inputs) {
    // A fresh view reads the actual ZIP bytes even when a caller has reused a mutable array.
    if (bytes instanceof Uint8Array) {
      const content = documentEnvelope ? documentContent(bytes) : bytes.subarray();
      digests.push([name, sha256HexSync(content)]);
    } else {
      if (documentEnvelope) throw new Error('Segmented document envelope');
      digests.push([name, sha256HexChunksSync(bytes)]);
    }
  }
  digests.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return sha256HexSync(new TextEncoder().encode(JSON.stringify(digests)));
}
