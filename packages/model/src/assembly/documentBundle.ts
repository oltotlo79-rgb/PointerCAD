/** 保存・復元・Undoで文書と原本の添付を一緒に持ち回る入れ物。ZIPの構造はioが持つ。 */
import type { PartDocument } from '../part/types.js';
import {
  EMPTY_PART_LIBRARY,
  emptyEmbeddedPartAttachments,
  type EmbeddedPartAttachments,
  type EmbeddedPartFile,
  type PartLibrary,
} from './partLibrary.js';
import type { AssemblyDocument } from './types.js';

export interface PartDocumentBundle {
  readonly kind: 'part';
  readonly document: PartDocument;
  readonly attachments: EmbeddedPartAttachments;
}

/** ルートのライブラリへ平らに抱き込むサブアセンブリ文書。 */
export interface EmbeddedAssemblyDocumentBundle {
  readonly kind: 'assembly';
  readonly document: AssemblyDocument;
}

export type EmbeddedDocumentBundle = PartDocumentBundle | EmbeddedAssemblyDocumentBundle;

export interface AssemblyDocumentBundle {
  readonly kind: 'assembly';
  readonly document: AssemblyDocument;
  /** アセンブリ自身は原本を持たない。原本はembeddedDocuments内の部品に属する。 */
  readonly attachments: EmbeddedPartAttachments;
  readonly embeddedDocuments: ReadonlyMap<string, PartDocumentBundle>;
  readonly embeddedAssemblies: ReadonlyMap<string, EmbeddedAssemblyDocumentBundle>;
  readonly partFiles: readonly EmbeddedPartFile[];
}

/** kindでdocumentの型も決まる。文書をnullにはしない。導出した形は入れない。 */
export type DocumentBundle = PartDocumentBundle | AssemblyDocumentBundle;

export function createPartDocumentBundle(
  document: PartDocument,
  attachments: EmbeddedPartAttachments = emptyEmbeddedPartAttachments(),
): PartDocumentBundle {
  return { kind: 'part', document, attachments };
}

export function createAssemblyDocumentBundle(
  document: AssemblyDocument,
  library: PartLibrary = EMPTY_PART_LIBRARY,
): AssemblyDocumentBundle {
  const embeddedDocuments = new Map<string, PartDocumentBundle>();
  for (const [ref, part] of library.parts) {
    embeddedDocuments.set(ref, createPartDocumentBundle(part, library.attachments.get(ref)));
  }
  const embeddedAssemblies = new Map<string, EmbeddedAssemblyDocumentBundle>(
    [...(library.assemblies ?? [])].map(([ref, assembly]) => [
      ref, { kind: 'assembly', document: assembly },
    ]),
  );
  return {
    kind: 'assembly',
    document,
    attachments: emptyEmbeddedPartAttachments(),
    partFiles: library.partFiles,
    embeddedDocuments,
    embeddedAssemblies,
  };
}

/** 既存の部品の抱き込み・置換APIへそのまま渡せる。 */
export function partLibraryOfBundle(bundle: AssemblyDocumentBundle): PartLibrary {
  const parts = new Map<string, PartDocument>();
  const attachments = new Map<string, EmbeddedPartAttachments>();
  const assemblies = new Map<string, AssemblyDocument>();
  for (const [ref, embedded] of bundle.embeddedDocuments) {
    parts.set(ref, embedded.document);
    attachments.set(ref, embedded.attachments);
  }
  for (const [ref, embedded] of bundle.embeddedAssemblies) {
    assemblies.set(ref, embedded.document);
  }
  return {
    partFiles: bundle.partFiles,
    parts,
    attachments,
    assemblies,
  };
}
