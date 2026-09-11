import type { DrawingSource, DrawingSheetFlatReference } from '@pointercad/drawing';
import { sheetFlatReferenceIssue } from '../sheetMetal/flatSheetReference.js';

import type { AssemblyDocument } from '../assembly/types.js';
import { attachmentsDigestOf, type EmbeddedPartAttachments, type PartLibrary } from '../assembly/partLibrary.js';
import type { PartDocument } from '../part/types.js';
import { nextSerialId } from '../sketch/createSketchDocument.js';

export type DrawingSourceDocument = PartDocument | AssemblyDocument;

export type DrawingSourceInput =
  | { readonly sourceKind: 'part'; readonly document: PartDocument; readonly attachments?: EmbeddedPartAttachments; readonly flatSheet?: DrawingSheetFlatReference }
  | { readonly sourceKind: 'assembly'; readonly document: AssemblyDocument; readonly library?: PartLibrary };

export interface EmbeddedDrawingSource {
  readonly metadata: DrawingSource;
  readonly document: DrawingSourceDocument;
  readonly attachments?: EmbeddedPartAttachments;
  readonly library?: PartLibrary;
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

/** 参照文書の変更に加え、同じ参照名で差し替わった部品・原本の変更も検出する。 */
export async function drawingSourceInputHash(input: DrawingSourceInput): Promise<string> {
  const flat = input.sourceKind === 'part' ? input.flatSheet : undefined;
  if (input.sourceKind === 'part' && flat !== undefined) {
    const issue = sheetFlatReferenceIssue(input.document, flat); if (issue !== null) throw new Error(issue);
  }
  if (input.sourceKind === 'part' && input.attachments === undefined && flat === undefined
    || input.sourceKind === 'assembly' && input.library === undefined) return drawingSourceContentHash(input.document);
  const dependencies = input.sourceKind === 'part'
    ? { attachments: input.attachments === undefined ? null : await attachmentsDigestOf(input.attachments) }
    : { parts: await Promise.all([...(input.library?.parts ?? [])].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(async ([ref, document]) => {
          const attachments = input.library?.attachments.get(ref);
          return { ref, document, attachments: attachments === undefined ? null : await attachmentsDigestOf(attachments) };
        })),
      assemblies: [...(input.library?.assemblies ?? [])].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) };
  const text = canonicalDrawingSourceText({ document: input.document, dependencies, ...(flat === undefined ? {} : { flatSheet: flat }) });
  return hexText(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

/** 文書の型と参照種別を照合し、保存にも再解決にも同じ原本一式を渡す。 */
export function drawingSourceInputOf(source: EmbeddedDrawingSource): DrawingSourceInput | null {
  if (source.metadata.sourceKind === 'part' && 'sketches' in source.document) {
    if (source.metadata.flatSheet !== undefined && sheetFlatReferenceIssue(source.document, source.metadata.flatSheet) !== null) return null;
    return { sourceKind: 'part', document: source.document, ...(source.attachments === undefined ? {} : { attachments: source.attachments }),
      ...(source.metadata.flatSheet === undefined ? {} : { flatSheet: source.metadata.flatSheet }) };
  }
  if (source.metadata.sourceKind === 'assembly' && source.metadata.flatSheet === undefined && 'components' in source.document) {
    return { sourceKind: 'assembly', document: source.document, ...(source.library === undefined ? {} : { library: source.library }) };
  }
  return null;
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
  const contentHash = await drawingSourceInputHash(input);
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
    ...(input.sourceKind === 'part' && input.flatSheet !== undefined ? { flatSheet: input.flatSheet } : {}),
    fileName,
    path,
    contentHash,
    importedAt: options.importedAt ?? new Date().toISOString(),
  };
  return {
    library: { sources: [...library.sources, { metadata, ...input }] },
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
  const contentHash = await drawingSourceInputHash(input);
  return {
    sources: library.sources.map((source) => source.metadata.sourceRef === sourceRef
      ? {
          metadata: {
            sourceRef: source.metadata.sourceRef, fileName: source.metadata.fileName, path: source.metadata.path,
            ...(input.sourceKind === 'part' && input.flatSheet !== undefined ? { flatSheet: input.flatSheet } : {}),
            sourceKind: input.sourceKind,
            contentHash,
            importedAt: options.importedAt ?? new Date().toISOString(),
          },
          ...input,
        }
      : source),
  };
}
