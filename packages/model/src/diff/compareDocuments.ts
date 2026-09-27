import type { PartDocument } from '../part/types.js';
import { featureNoteTargetKey } from '../history/featureNotes.js';
import { compareDefinitionValues, type DefinitionDifference, type DiffBudget } from './definitionValues.js';

export type DocumentRelationship = 'versions' | 'unrelated';
export type DefinitionGroup = 'document' | 'sketch' | 'sketch-feature' | 'reference' | 'solid'
  | 'parameter' | 'configuration' | 'sheet-unfold' | 'named-view' | 'selection-set' | 'canvas'
  | 'appearance' | 'note' | 'folder' | 'math-problem' | 'attachments';
export interface DocumentDefinitionEntry {
  readonly key: string;
  readonly group: DefinitionGroup;
  readonly name: string;
  readonly owner: string;
  readonly definition: unknown;
  readonly orderGroup?: string;
}
export interface DocumentDefinitionChange {
  readonly key: string;
  readonly group: DefinitionGroup;
  readonly beforeName: string | null;
  readonly afterName: string | null;
  readonly owner: string;
  readonly ownerName: string;
  readonly status: 'added' | 'removed' | 'changed';
  readonly differences: readonly DefinitionDifference[];
}
export interface DocumentDefinitionComparison {
  readonly relationship: DocumentRelationship;
  readonly changes: readonly DocumentDefinitionChange[];
  readonly unchanged: number;
  /** 定義と保存された値の比較であり、形状の一致を証明しない。 */
  readonly geometryCompared: false;
}
export class DocumentComparisonLimit extends Error {
  constructor() { super('比較できる文書の大きさを超えています。'); this.name = 'DocumentComparisonLimit'; }
}

// 追加項目を無言で比較対象から落とさない。新しい保存欄は型検査で分類を要求する。
const FIELDS = {
  id: 'identity', name: 'document', schemaVersion: 'format', mathParameterSerial: 'serial',
  unresolvedMathProblems: 'entries', mathGeometry: 'document', featureNotes: 'entries', featureFolders: 'entries', sketches: 'entries', activeSketchId: 'view',
  references: 'entries', solids: 'entries', sheetUnfolds: 'entries', parameters: 'entries',
  namedViews: 'entries', configurations: 'entries', activeConfigurationId: 'document',
  appearance: 'document', selectionSets: 'entries', canvases: 'entries',
} satisfies Record<keyof PartDocument, 'identity' | 'format' | 'serial' | 'view' | 'document' | 'entries'>;

function documentKey(key: string): key is keyof PartDocument { return Object.hasOwn(FIELDS, key); }

function entries(document: PartDocument, attachmentsDigest: string, tick: () => void): readonly DocumentDefinitionEntry[] {
  const result: DocumentDefinitionEntry[] = [];
  const add = (group: DefinitionGroup, id: string, name: string, definition: unknown, owner = '', orderGroup?: string): void => {
    tick(); result.push({ key: JSON.stringify([group, owner, id]), group, name, owner, definition,
      ...(orderGroup === undefined ? {} : { orderGroup }) });
  };
  const documentFields: Record<string, unknown> = {};
  for (const [field, policy] of Object.entries(FIELDS)) {
    if (policy === 'document' && field !== 'appearance' && documentKey(field)) {
      documentFields[field] = document[field];
    }
  }
  add('document', 'document', document.name, documentFields);
  add('appearance', 'appearance', '', document.appearance);
  add('attachments', 'attachments', '', attachmentsDigest);
  for (const sketch of document.sketches) {
    const { features, ...definition } = sketch;
    add('sketch', sketch.id, sketch.name, { ...definition, constraints: sketch.constraints ?? [] }, '', 'sketch');
    for (const feature of features) add('sketch-feature', feature.id, feature.name, feature, sketch.id, `sketch:${sketch.id}`);
  }
  for (const feature of document.references) add('reference', feature.id, feature.name, feature, '', 'reference');
  for (const feature of document.solids) add('solid', feature.id, feature.name, feature, '', 'solid');
  for (const parameter of document.parameters) add('parameter', parameter.mathId ?? parameter.name, parameter.name, parameter, '', 'parameter');
  for (const configuration of document.configurations) add('configuration', configuration.id, configuration.name, configuration);
  for (const definition of document.sheetUnfolds) add('sheet-unfold', definition.sourceFeatureId,
    document.solids.find(feature => feature.id === definition.sourceFeatureId)?.name ?? definition.sourceFeatureId, definition);
  for (const view of document.namedViews) add('named-view', view.id, view.name, view);
  for (const set of document.selectionSets) add('selection-set', set.id, set.name, set);
  for (const canvas of document.canvases) add('canvas', canvas.id, canvas.name, canvas);
  for (const note of document.featureNotes ?? []) add('note', featureNoteTargetKey(note.target), '', note);
  for (const folder of document.featureFolders ?? []) add('folder', folder.id, folder.name, folder);
  for (const problem of document.unresolvedMathProblems ?? []) add('math-problem', problem.id, problem.name, problem);
  const keys = new Set(result.map(entry => entry.key));
  if (keys.size !== result.length) throw new Error('比較対象の識別子が重複しています。');
  return result;
}

/** 配列への挿入で後続すべてを「移動」にせず、両版で共通する段の相対順だけを比較する。 */
function commonOrder(entries: readonly DocumentDefinitionEntry[], otherKeys: ReadonlySet<string>): ReadonlyMap<string, number> {
  const next = new Map<string, number>(), result = new Map<string, number>();
  for (const entry of entries) {
    if (entry.orderGroup === undefined || !otherKeys.has(entry.key)) continue;
    const index = next.get(entry.orderGroup) ?? 0;
    result.set(entry.key, index); next.set(entry.orderGroup, index + 1);
  }
  return result;
}

/** 関係の指定を必須にする。旧文書のpart-1を由来の証明にしない。入力は一切更新しない。 */
export function compareDocuments(before: PartDocument, after: PartDocument, options: {
  readonly relationship: DocumentRelationship;
  readonly beforeAttachmentsDigest: string;
  readonly afterAttachmentsDigest: string;
  readonly maxWork?: number;
  readonly maxChanges?: number;
}): DocumentDefinitionComparison {
  let remaining = options.maxWork ?? 1_000_000;
  const maxChanges = options.maxChanges ?? 10_000;
  if (!Number.isSafeInteger(remaining) || remaining <= 0 || !Number.isSafeInteger(maxChanges) || maxChanges <= 0) throw new DocumentComparisonLimit();
  const tick = (): void => { if (--remaining < 0) throw new DocumentComparisonLimit(); };
  let outputCharacters = 8_000_000;
  const budget: DiffBudget = { tick, text: length => { outputCharacters -= length; if (outputCharacters < 0) throw new DocumentComparisonLimit(); },
    fail: () => { throw new DocumentComparisonLimit(); } };
  const old = entries(before, options.beforeAttachmentsDigest, tick), next = entries(after, options.afterAttachmentsDigest, tick);
  const oldOwners = new Map(before.sketches.map(sketch => [sketch.id, sketch.name]));
  const nextOwners = new Map(after.sketches.map(sketch => [sketch.id, sketch.name]));
  const changes: DocumentDefinitionChange[] = [];
  const append = (entry: DocumentDefinitionEntry, previous: DocumentDefinitionEntry | null, status: DocumentDefinitionChange['status'], differences: readonly DefinitionDifference[]): void => {
    if (changes.length >= maxChanges || differences.length > 1_024) throw new DocumentComparisonLimit();
    const ownerName = (status === 'removed' ? oldOwners : nextOwners).get(entry.owner) ?? '';
    budget.text(entry.key.length + entry.group.length + entry.name.length + (previous?.name.length ?? 0) + entry.owner.length + ownerName.length + status.length);
    changes.push({ key: `${status}:${entry.key}`, group: entry.group, beforeName: previous?.name ?? null,
      afterName: status === 'removed' ? null : entry.name, owner: entry.owner, ownerName, status, differences });
  };
  const oldByKey = new Map(old.map(entry => [entry.key, entry])), nextKeys = new Set(next.map(entry => entry.key));
  const oldOrder = commonOrder(old, nextKeys), nextOrder = commonOrder(next, new Set(oldByKey.keys()));
  let unchanged = 0;
  for (const entry of old) {
    tick();
    if (options.relationship === 'unrelated' || !nextKeys.has(entry.key)) append(entry, entry, 'removed', []);
  }
  for (const entry of next) {
    tick();
    const previous = options.relationship === 'unrelated' ? undefined : oldByKey.get(entry.key);
    if (previous === undefined) { append(entry, null, 'added', []); continue; }
    const differences = [...compareDefinitionValues(previous.definition, entry.definition, budget)];
    if (oldOrder.get(entry.key) !== nextOrder.get(entry.key)) differences.push({ path: ['order'], kind: 'order',
      before: String((oldOrder.get(entry.key) ?? 0) + 1), after: String((nextOrder.get(entry.key) ?? 0) + 1) });
    if (differences.length === 0) unchanged += 1;
    else append(entry, previous, 'changed', differences);
  }
  return { relationship: options.relationship, changes, unchanged, geometryCompared: false };
}
