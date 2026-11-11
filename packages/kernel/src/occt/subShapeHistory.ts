import type { BRepBuilderAPI_MakeShape, OpenCascadeInstance, TopoDS_Shape, TopTools_IndexedMapOfShape,
  TopTools_ListOfShape } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations, type Allocations } from './allocations.js';

export type HistoryShapeKind = 'face' | 'edge' | 'vertex';
/** Zero-based address in this build only. Not a persistent or semantic identifier. */
export interface HistoryShapeAddress { readonly kind: HistoryShapeKind; readonly index: number }
export interface SubShapeHistoryEntry {
  readonly sourceId: string;
  readonly input: HistoryShapeAddress;
  readonly modified: readonly HistoryShapeAddress[];
  readonly generated: readonly HistoryShapeAddress[];
  /** Raw builder flag; finishing builders may report true even for an identical output shape. */
  readonly deleted: boolean;
  /** Native same-shape presence in this output, independent of the builder's deleted flag. */
  readonly unchanged: HistoryShapeAddress | null;
}
type ShapeMaps = Readonly<Record<HistoryShapeKind, TopTools_IndexedMapOfShape>>;
const KINDS: readonly HistoryShapeKind[] = ['face', 'edge', 'vertex'];
const MAX_HISTORY_ROWS = 100_000;
const MAX_HISTORY_LINKS = 400_000;
export class OriginHistoryLimitError extends Error {}

function shapeKind(oc: OpenCascadeInstance, shape: TopoDS_Shape): HistoryShapeKind | null {
  const kind = shape.ShapeType();
  if (kind === oc.TopAbs_ShapeEnum.TopAbs_FACE) return 'face';
  if (kind === oc.TopAbs_ShapeEnum.TopAbs_EDGE) return 'edge';
  if (kind === oc.TopAbs_ShapeEnum.TopAbs_VERTEX) return 'vertex';
  return null;
}

function shapeMaps(oc: OpenCascadeInstance, shape: TopoDS_Shape, owned: Allocations): ShapeMaps {
  const maps = { face: owned.keep(new oc.TopTools_IndexedMapOfShape_1()),
    edge: owned.keep(new oc.TopTools_IndexedMapOfShape_1()), vertex: owned.keep(new oc.TopTools_IndexedMapOfShape_1()) };
  const temporary = createAllocations();
  try {
    const all = temporary.keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, all, true, true);
    for (let index = 1; index <= all.Size(); index++) {
      const value = temporary.keep(all.FindKey(index)), kind = shapeKind(oc, value);
      if (kind !== null) maps[kind].Add(value);
    }
    return maps;
  } finally { temporary.release(); }
}

/** Copies the returned list before traversal; never removes entries from the builder's list. */
function readList(oc: OpenCascadeInstance, list: TopTools_ListOfShape, maps: ShapeMaps,
  modifiedKind: HistoryShapeKind | null, links: { count: number }): readonly HistoryShapeAddress[] {
  const owned = createAllocations();
  owned.keep(list);
  try {
    const copy = owned.keep(new oc.TopTools_ListOfShape_3(list));
    const result: HistoryShapeAddress[] = [];
    while (copy.Size() > 0) {
      const shape = owned.keep(copy.First_1()), kind = shapeKind(oc, shape);
      if (kind === null || (modifiedKind !== null && kind !== modifiedKind)) {
        throw new Error('加工履歴の形状種類が対応していません。');
      }
      const index = maps[kind].FindIndex(shape);
      if (index < 1) throw new Error('加工履歴の形状が現在の出力に存在しません。');
      result.push({ kind, index: index - 1 });
      links.count += 1;
      if (links.count > MAX_HISTORY_LINKS) throw new OriginHistoryLimitError('加工履歴の対応件数が上限を超えました。');
      copy.RemoveFirst();
    }
    return result;
  } finally { owned.release(); }
}

/** Extracts one real builder's correspondence to plain data; owns none of its inputs or builder. */
export function extractSubShapeHistory(oc: OpenCascadeInstance, builder: Pick<BRepBuilderAPI_MakeShape, 'Modified' | 'Generated' | 'IsDeleted'>,
  inputs: readonly { readonly sourceId: string; readonly shape: TopoDS_Shape }[],
  output: TopoDS_Shape): readonly SubShapeHistoryEntry[] {
  if (new Set(inputs.map(input => input.sourceId)).size !== inputs.length) throw new Error('加工履歴の入力IDが重複しています。');
  const owned = createAllocations();
  try {
    const outputMaps = shapeMaps(oc, output, owned), result: SubShapeHistoryEntry[] = [];
    const links = { count: 0 };
    if (KINDS.reduce((sum, kind) => sum + outputMaps[kind].Size(), 0) > MAX_HISTORY_ROWS) {
      throw new OriginHistoryLimitError('加工履歴の形状件数が上限を超えました。');
    }
    for (const input of inputs) {
      const maps = shapeMaps(oc, input.shape, owned);
      if (result.length + KINDS.reduce((sum, kind) => sum + maps[kind].Size(), 0) > MAX_HISTORY_ROWS) {
        throw new OriginHistoryLimitError('加工履歴の入力件数が上限を超えました。');
      }
      for (const kind of KINDS) for (let index = 1; index <= maps[kind].Size(); index++) {
        const source = owned.keep(maps[kind].FindKey(index));
        const modified = readList(oc, builder.Modified(source), outputMaps, kind, links);
        const generated = readList(oc, builder.Generated(source), outputMaps, null, links);
        const currentIndex = outputMaps[kind].FindIndex(source);
        result.push({ sourceId: input.sourceId, input: { kind, index: index - 1 }, modified, generated,
          deleted: builder.IsDeleted(source), unchanged: currentIndex < 1 ? null : { kind, index: currentIndex - 1 } });
      }
    }
    return result;
  } finally { owned.release(); }
}
