import type { DrawingSource } from '@pointercad/drawing';

import type { AssemblyDocument } from '../assembly/types.js';
import type { PartDocument } from '../part/types.js';
import { nextSerialId } from '../sketch/createSketchDocument.js';

export type DrawingSourceDocument = PartDocument | AssemblyDocument;

export type DrawingSourceInput =
  | { readonly sourceKind: 'part'; readonly document: PartDocument }
  | { readonly sourceKind: 'assembly'; readonly document: AssemblyDocument };

export interface EmbeddedDrawingSource {
  readonly metadata: DrawingSource;
  readonly document: DrawingSourceDocument;
}

export interface DrawingSourceLibrary {
  readonly sources: readonly EmbeddedDrawingSource[];
}

export interface EmbedDrawingSourceOptions {
  readonly importedAt?: string;
}

export interface EmbedDrawingSourceResult {
  readonly library: DrawingSourceLibrary;
  readonly source: DrawingSource;
  readonly reused: boolean;
}

export function emptyDrawingSourceLibrary(): DrawingSourceLibrary {
  return { sources: [] };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** P7 の部品ライブラリと同じ、鍵を辞書順へそろえた決定的な文字列化。 */
export function canonicalDrawingSourceText(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (isUnknownArray(value)) {
    return `[${value.map((item) => canonicalDrawingSourceText(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    const fields: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child !== undefined) {
        fields.push(`${JSON.stringify(key)}:${canonicalDrawingSourceText(child)}`);
      }
    }
    return `{${fields.join(',')}}`;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  return 'null';
}

function hexText(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 抱き込む文書の内容だけからSHA-256を作る。形やメッシュは入力に含めない(§0.3)。 */
export async function drawingSourceContentHash(document: DrawingSourceDocument): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalDrawingSourceText(document));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return hexText(new Uint8Array(digest));
}

export function drawingSourceDocumentOf(
  library: DrawingSourceLibrary,
  sourceRef: string,
): DrawingSourceDocument | undefined {
  return library.sources.find((source) => source.metadata.sourceRef === sourceRef)?.document;
}

/** 同じ種類・同じ内容の文書は1回だけ抱き込む。 */
export async function embedDrawingSource(
  library: DrawingSourceLibrary,
  input: DrawingSourceInput,
  fileName: string,
  path: string,
  options: EmbedDrawingSourceOptions = {},
): Promise<EmbedDrawingSourceResult> {
  const contentHash = await drawingSourceContentHash(input.document);
  const existing = library.sources.find(
    (source) =>
      source.metadata.sourceKind === input.sourceKind &&
      source.metadata.contentHash === contentHash,
  );
  if (existing !== undefined) {
    return { library, source: existing.metadata, reused: true };
  }
  const sourceRef = nextSerialId(
    library.sources.map((source) => source.metadata.sourceRef),
    'source-',
  );
  const metadata: DrawingSource = {
    sourceRef,
    sourceKind: input.sourceKind,
    fileName,
    path,
    contentHash,
    importedAt: options.importedAt ?? new Date().toISOString(),
  };
  return {
    library: { sources: [...library.sources, { metadata, document: input.document }] },
    source: metadata,
    reused: false,
  };
}

/** 知らない参照なら元を返し、既存参照なら文書とハッシュだけを不変に差し替える。 */
export async function replaceDrawingSource(
  library: DrawingSourceLibrary,
  sourceRef: string,
  input: DrawingSourceInput,
  options: EmbedDrawingSourceOptions = {},
): Promise<DrawingSourceLibrary> {
  const current = library.sources.find((source) => source.metadata.sourceRef === sourceRef);
  if (current === undefined) {
    return library;
  }
  const contentHash = await drawingSourceContentHash(input.document);
  return {
    sources: library.sources.map((source) => source.metadata.sourceRef === sourceRef
      ? {
          metadata: {
            ...source.metadata,
            sourceKind: input.sourceKind,
            contentHash,
            importedAt: options.importedAt ?? new Date().toISOString(),
          },
          document: input.document,
        }
      : source),
  };
}
