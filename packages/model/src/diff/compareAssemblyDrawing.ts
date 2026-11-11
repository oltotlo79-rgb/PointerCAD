import type { DrawingDocument } from '@pointercad/drawing';
import type { AssemblyDocument } from '../assembly/types.js';
import {
  compareDefinitionEntries, DocumentComparisonLimit,
  type DefinitionGroup, type DocumentDefinitionComparison, type DocumentDefinitionEntry, type DocumentRelationship,
} from './compareDocuments.js';

/** 部品の中身は比較せず、内容ハッシュで「どの部品が変わったか」だけを示す。部品どうしは部品の比較で調べる。 */
export interface LibraryItemDigest { readonly name: string; readonly hash: string }
/** 組立が抱き込む部品・サブ組立・添付の要約(Workerが作る)。 */
export interface AssemblyLibraryDigest {
  readonly parts: ReadonlyMap<string, LibraryItemDigest>;
  readonly assemblies: ReadonlyMap<string, LibraryItemDigest>;
  readonly attachmentsDigest: string;
}
interface CompareLimits { readonly relationship: DocumentRelationship; readonly maxWork?: number; readonly maxChanges?: number }

/** 文書の欄は、型検査で分類を要求する(新しい欄を無言で比較から落とさない)。 */
const ASSEMBLY_FIELDS = {
  id: 'document', name: 'document', schemaVersion: 'document', bom: 'document',
  components: 'component', mates: 'mate', joints: 'joint', presentation: 'presentation',
  parameters: 'parameter', namedViews: 'named-view',
  beamAnalysisInputs: 'document',
  mechanismCouplings: 'document',
  camCouplings: 'document',
  boltedJoints: 'document',
  crossLevelGearCouplings: 'document',
  crossLevelCamCouplings: 'document',
  contextReferences: 'document',
  jointOccurrenceConnections: 'document',
} satisfies Record<keyof AssemblyDocument, DefinitionGroup>;
const DRAWING_FIELDS = {
  id: 'document', name: 'document', schemaVersion: 'document', source: 'document', sheet: 'document',
  views: 'drawing-view', dimensions: 'dimension', annotations: 'annotation', tables: 'table', balloons: 'balloon',
  datums: 'datum', gdtFrames: 'gdt', weldSymbols: 'weld', layers: 'layer', parameters: 'drawing-parameter',
} satisfies Record<keyof DrawingDocument, DefinitionGroup>;

function text(value: unknown): string | null { return typeof value === 'string' ? value : null; }

function recordEntries(document: object, fields: Readonly<Record<string, DefinitionGroup>>, tick: () => void,
  documentGroup: DefinitionGroup): DocumentDefinitionEntry[] {
  const result: DocumentDefinitionEntry[] = [];
  const own: Record<string, unknown> = {};
  const data = document as Readonly<Record<string, unknown>>;
  for (const [field, group] of Object.entries(fields)) {
    const optionalRelations = field === 'mechanismCouplings' || field === 'camCouplings' || field === 'contextReferences'
      || field === 'jointOccurrenceConnections' || field === 'boltedJoints'
      || field === 'crossLevelGearCouplings' || field === 'crossLevelCamCouplings';
    const value = optionalRelations ? data[field] ?? [] : data[field];
    if (group === 'document' || !Array.isArray(value)) { own[field] = value; continue; }
    const items: readonly unknown[] = value;
    items.forEach((item, index) => {
      tick();
      const record = typeof item === 'object' && item !== null ? item as Readonly<Record<string, unknown>> : {};
      const id = text(record.id) ?? text(record.mathId) ?? text(record.name) ?? `#${index}`;
      result.push({ key: JSON.stringify([group, '', id]), group, name: text(record.name) ?? '', owner: '',
        definition: item, orderGroup: field });
    });
  }
  result.unshift({ key: JSON.stringify([documentGroup, '', 'document']), group: documentGroup,
    name: text(data.name) ?? '', owner: '', definition: own });
  return result;
}

function ensureUnique(entries: readonly DocumentDefinitionEntry[]): void {
  if (new Set(entries.map(entry => entry.key)).size !== entries.length) throw new Error('比較対象の識別子が重複しています。');
}

function budgetOf(options: CompareLimits): { tick: () => void } {
  let remaining = options.maxWork ?? 1_000_000;
  if (!Number.isSafeInteger(remaining) || remaining <= 0) throw new DocumentComparisonLimit();
  return { tick: () => { if (--remaining < 0) throw new DocumentComparisonLimit(); } };
}

/** 組立の定義(部品の配置・合致・ジョイント・部品表の設定・抱き込んだ部品の内容ハッシュ)を比べる。形状は比べない。 */
export function compareAssemblyDocuments(before: AssemblyDocument, after: AssemblyDocument, options: CompareLimits & {
  readonly beforeLibrary: AssemblyLibraryDigest;
  readonly afterLibrary: AssemblyLibraryDigest;
}): DocumentDefinitionComparison {
  const { tick } = budgetOf(options);
  const entries = (document: AssemblyDocument, library: AssemblyLibraryDigest): DocumentDefinitionEntry[] => {
    const result = recordEntries(document, ASSEMBLY_FIELDS, tick, 'assembly-document');
    for (const [ref, item] of library.parts) result.push({ key: JSON.stringify(['library-part', '', ref]),
      group: 'library-part', name: item.name, owner: '', definition: { name: item.name, contentHash: item.hash } });
    for (const [ref, item] of library.assemblies) result.push({ key: JSON.stringify(['library-assembly', '', ref]),
      group: 'library-assembly', name: item.name, owner: '', definition: { name: item.name, contentHash: item.hash } });
    result.push({ key: JSON.stringify(['attachments', '', 'attachments']), group: 'attachments', name: '', owner: '',
      definition: library.attachmentsDigest });
    ensureUnique(result);
    return result;
  };
  return compareDefinitionEntries(entries(before, options.beforeLibrary), entries(after, options.afterLibrary),
    { before: new Map(), after: new Map() },
    { relationship: options.relationship, tick, ...(options.maxChanges === undefined ? {} : { maxChanges: options.maxChanges }) });
}

/** 図面の定義(ビュー・寸法・注記・表・レイヤー等)と、参照元一式の内容ハッシュを比べる。 */
export function compareDrawingDocuments(before: DrawingDocument, after: DrawingDocument, options: CompareLimits & {
  readonly beforeSourceHash: string;
  readonly afterSourceHash: string;
}): DocumentDefinitionComparison {
  const { tick } = budgetOf(options);
  const entries = (document: DrawingDocument, sourceHash: string): DocumentDefinitionEntry[] => {
    const result = recordEntries(document, DRAWING_FIELDS, tick, 'drawing-document');
    result.push({ key: JSON.stringify(['drawing-source', '', document.source.sourceRef]), group: 'drawing-source',
      name: document.source.sourceRef, owner: '', definition: { sourceKind: document.source.sourceKind, contentHash: sourceHash } });
    ensureUnique(result);
    return result;
  };
  return compareDefinitionEntries(entries(before, options.beforeSourceHash), entries(after, options.afterSourceHash),
    { before: new Map(), after: new Map() },
    { relationship: options.relationship, tick, ...(options.maxChanges === undefined ? {} : { maxChanges: options.maxChanges }) });
}
