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

export interface AssemblyDocumentBundle {
  readonly kind: 'assembly';
  readonly document: AssemblyDocument;
  /** アセンブリ自身は原本を持たない。原本はembeddedDocuments内の部品に属する。 */
  readonly attachments: EmbeddedPartAttachments;
  readonly embeddedDocuments: ReadonlyMap<string, PartDocumentBundle>;
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
  return {
    kind: 'assembly',
    document,
    attachments: emptyEmbeddedPartAttachments(),
    partFiles: library.partFiles,
    embeddedDocuments: new Map([...library.parts].map(([ref, part]) => [
      ref,
      createPartDocumentBundle(part, library.attachments.get(ref)),
    ])),
  };
}

/** 既存の部品の抱き込み・置換APIへそのまま渡せる。 */
export function partLibraryOfBundle(bundle: AssemblyDocumentBundle): PartLibrary {
  return {
    partFiles: bundle.partFiles,
    parts: new Map([...bundle.embeddedDocuments].map(([ref, part]) => [ref, part.document])),
    attachments: new Map([...bundle.embeddedDocuments].map(([ref, part]) => [ref, part.attachments])),
  };
}
