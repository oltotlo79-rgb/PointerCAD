import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BRepBuilderAPI_MakeShape, TopoDS_Shape, TopTools_ListOfShape } from 'opencascade.js/dist/opencascade.full.js';
import { loadOcctForNode } from './loadOcct.node.js';
import * as allocationModule from './allocations.js';
import type { Allocations, OcctDeletable } from './allocations.js';
import { isFilletShape } from './makeFillet.js';
import { makePrimitive } from './makePrimitive.js';
import { edgeAt } from './subShapes.js';
import { buildSolidBodyMesh, isValidShape, measureVolume } from './solidMesh.js';
import { extractSubShapeHistory, type SubShapeHistoryEntry } from './subShapeHistory.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);
afterEach(() => { vi.restoreAllMocks(); });
type Operation = 'union' | 'difference' | 'intersection' | 'fillet' | 'chamfer';
interface Fixture {
  readonly builder: BRepBuilderAPI_MakeShape;
  readonly inputs: readonly { readonly sourceId: string; readonly shape: TopoDS_Shape }[];
  readonly output: TopoDS_Shape;
  readonly original: TopoDS_Shape;
  readonly release: () => void;
}
function box(owned: Allocations, x: number, y: number, z: number): TopoDS_Shape {
  const point = owned.keep(new oc.gp_Pnt_3(x, y, z));
  const maker = owned.keep(new oc.BRepPrimAPI_MakeBox_3(point, 20, 20, 20));
  return owned.keep(maker.Shape());
}
function cylinder(owned: Allocations, radius: number, z: number, featureId: string): TopoDS_Shape {
  return owned.keep(makePrimitive(oc, { kind: 'primitive', origin: [0, 0, z], axis: [0, 0, 1],
    shape: { kind: 'cylinder', radius, height: 20 }, originQuery: null, targetKey: null }, featureId)).shape;
}
function cylinderFixture(operation: 'union' | 'difference' | 'intersection'): Fixture {
  const owned = allocationModule.createAllocations();
  try {
    const original = cylinder(owned, 5, 0, 'cylinder-target');
    const tool = cylinder(owned, 3, 10, 'cylinder-tool');
    const maker = operation === 'union' ? owned.keep(new oc.BRepAlgoAPI_Fuse_1())
      : operation === 'difference' ? owned.keep(new oc.BRepAlgoAPI_Cut_1())
        : owned.keep(new oc.BRepAlgoAPI_Common_1());
    const argumentsList = owned.keep(new oc.TopTools_ListOfShape_1());
    const tools = owned.keep(new oc.TopTools_ListOfShape_1());
    owned.keep(argumentsList.Append_1(original)); owned.keep(tools.Append_1(tool));
    maker.SetArguments(argumentsList); maker.SetTools(tools); maker.SetNonDestructive(true);
    const range = owned.keep(new oc.Message_ProgressRange_1());
    maker.Build(range);
    if (!maker.IsDone() || maker.HasErrors()) throw new Error('Real cylinder Boolean failed');
    return { builder: maker, original, output: owned.keep(maker.Shape()),
      inputs: [{ sourceId: 'target', shape: original }, { sourceId: 'tool', shape: tool }],
      release: owned.release };
  } catch (error) { owned.release(); throw error; }
}
function fixture(operation: Operation): Fixture {
  const owned = allocationModule.createAllocations();
  try {
    const original = box(owned, 0, 0, 0), range = owned.keep(new oc.Message_ProgressRange_1());
    if (operation === 'fillet' || operation === 'chamfer') {
      const copier = owned.keep(new oc.BRepBuilderAPI_Copy_2(original, true, false));
      const input = owned.keep(copier.Shape()), edge = edgeAt(oc, input, 0);
      if (edge === null) throw new Error('Real box edge required');
      owned.keep(edge);
      const style = oc.ChFi3d_FilletShape.ChFi3d_Rational;
      if (!isFilletShape(style)) throw new Error('Fillet enumeration required');
      const maker = operation === 'fillet' ? owned.keep(new oc.BRepFilletAPI_MakeFillet(input, style))
        : owned.keep(new oc.BRepFilletAPI_MakeChamfer(input));
      maker.Add_2(2, edge);
      maker.Build(range);
      if (!maker.IsDone()) throw new Error('Real finishing operation failed');
      return { builder: maker, inputs: [{ sourceId: 'target', shape: input }],
        original, output: owned.keep(maker.Shape()), release: owned.release };
    }
    const tool = box(owned, 10, 10, 10);
    const maker = operation === 'union' ? owned.keep(new oc.BRepAlgoAPI_Fuse_1())
      : operation === 'difference' ? owned.keep(new oc.BRepAlgoAPI_Cut_1()) : owned.keep(new oc.BRepAlgoAPI_Common_1());
    const argumentsList = owned.keep(new oc.TopTools_ListOfShape_1()), tools = owned.keep(new oc.TopTools_ListOfShape_1());
    owned.keep(argumentsList.Append_1(original)); owned.keep(tools.Append_1(tool));
    maker.SetArguments(argumentsList); maker.SetTools(tools); maker.SetNonDestructive(true); maker.Build(range);
    if (!maker.IsDone() || maker.HasErrors()) throw new Error('Real Boolean failed');
    return { builder: maker, inputs: [{ sourceId: 'target', shape: original }, { sourceId: 'tool', shape: tool }],
      original, output: owned.keep(maker.Shape()), release: owned.release };
  } catch (error) { owned.release(); throw error; }
}
function metrics(shape: TopoDS_Shape) {
  const owned = allocationModule.createAllocations();
  try {
    const bounds = owned.keep(new oc.Bnd_Box_1());
    oc.BRepBndLib.AddOptimal(shape, bounds, false, false); bounds.SetGap(0);
    const low = owned.keep(bounds.CornerMin()), high = owned.keep(bounds.CornerMax());
    return { volume: measureVolume(oc, shape), minimum: [low.X(), low.Y(), low.Z()], maximum: [high.X(), high.Y(), high.Z()] };
  } finally { owned.release(); }
}
interface OwnedRecord { readonly item: OcctDeletable; readonly dispose: () => void; deletes: number }
function observeOwnership(failDelete: boolean): OwnedRecord[] {
  const records: OwnedRecord[] = [], create = allocationModule.createAllocations;
  let injected = false;
  vi.spyOn(allocationModule, 'createAllocations').mockImplementation(() => {
    const owned = create();
    return { release: owned.release, keep<T extends OcctDeletable>(item: T): T {
      const dispose = item.delete.bind(item), record: OwnedRecord = { item, dispose, deletes: 0 };
      records.push(record);
      item.delete = () => { record.deletes++; dispose();
        if (failDelete && !injected && item instanceof oc.TopTools_ListOfShape) {
          injected = true; throw new Error('injected list delete failure'); } };
      return owned.keep(item);
    } };
  });
  return records;
}
function cleanup(records: readonly OwnedRecord[]): void {
  vi.restoreAllMocks();
  for (const record of records) if (record.deletes === 0) record.dispose();
}
function summary(table: readonly SubShapeHistoryEntry[]) {
  return { entries: table.length, modified: table.filter(entry => entry.modified.length > 0).length,
    generated: table.filter(entry => entry.generated.length > 0).length, deleted: table.filter(entry => entry.deleted).length,
    unchanged: table.filter(entry => entry.unchanged !== null).length };
}

describe('固定OCCTの実加工履歴と所有権', () => {
  it.each(['union', 'difference', 'intersection'] as const)(
    '異径円筒%sのnative履歴は同kind現Mapのplain addressだけを返し借用形状を維持する', operation => {
      const built = cylinderFixture(operation);
      try {
        const expectedVolume = Math.PI * (operation === 'union' ? 590 : operation === 'difference' ? 410 : 90);
        const expectedMin = operation === 'intersection' ? [-3, -3, 10] : [-5, -5, 0];
        const expectedMax = operation === 'union' ? [5, 5, 30]
          : operation === 'difference' ? [5, 5, 20] : [3, 3, 20];
        const output = metrics(built.output), before = built.inputs.map(input => metrics(input.shape));
        expect(output.volume).toBeCloseTo(expectedVolume, 6);
        for (let coordinate = 0; coordinate < 3; coordinate++) {
          expect(output.minimum[coordinate]).toBeCloseTo(expectedMin[coordinate], 6);
          expect(output.maximum[coordinate]).toBeCloseTo(expectedMax[coordinate], 6);
        }
        expect(isValidShape(oc, built.output)).toBe(true);
        const borrowed = [vi.spyOn(built.builder, 'delete'), vi.spyOn(built.output, 'delete'),
          ...built.inputs.map(input => vi.spyOn(input.shape, 'delete'))];
        const observed = observeOwnership(false);
        let table: readonly SubShapeHistoryEntry[] = [];
        try {
          table = extractSubShapeHistory(oc, built.builder, built.inputs, built.output);
          expect(observed.length).toBeGreaterThan(0);
          expect(observed.every(record => record.deletes === 1)).toBe(true);
          expect(borrowed.every(spy => spy.mock.calls.length === 0)).toBe(true);
        } finally { cleanup(observed); }
        expect(table).toHaveLength(16);
        expect(table.filter(entry => entry.sourceId === 'target')).toHaveLength(8);
        expect(table.filter(entry => entry.sourceId === 'tool')).toHaveLength(8);
        const maps = allocationModule.createAllocations();
        try {
          const all = maps.keep(new oc.TopTools_IndexedMapOfShape_1());
          const current = { face: maps.keep(new oc.TopTools_IndexedMapOfShape_1()),
            edge: maps.keep(new oc.TopTools_IndexedMapOfShape_1()),
            vertex: maps.keep(new oc.TopTools_IndexedMapOfShape_1()) };
          oc.TopExp.MapShapes_2(built.output, all, true, true);
          for (let index = 1; index <= all.Size(); index++) {
            const shape = maps.keep(all.FindKey(index)), kind = shape.ShapeType();
            if (kind === oc.TopAbs_ShapeEnum.TopAbs_FACE) current.face.Add(shape);
            if (kind === oc.TopAbs_ShapeEnum.TopAbs_EDGE) current.edge.Add(shape);
            if (kind === oc.TopAbs_ShapeEnum.TopAbs_VERTEX) current.vertex.Add(shape);
          }
          for (const entry of table) for (const address of [...entry.modified, ...entry.generated,
            ...(entry.unchanged === null ? [] : [entry.unchanged])]) {
            expect(address.index).toBeGreaterThanOrEqual(0);
            expect(address.index).toBeLessThan(current[address.kind].Size());
            const shape = maps.keep(current[address.kind].FindKey(address.index + 1));
            const expectedKind = address.kind === 'face' ? oc.TopAbs_ShapeEnum.TopAbs_FACE
              : address.kind === 'edge' ? oc.TopAbs_ShapeEnum.TopAbs_EDGE : oc.TopAbs_ShapeEnum.TopAbs_VERTEX;
            expect(shape.ShapeType()).toBe(expectedKind);
          }
        } finally { maps.release(); }
        expect(built.inputs.map(input => metrics(input.shape))).toEqual(before);
        expect(metrics(built.output)).toEqual(output);
        expect(JSON.parse(JSON.stringify(table))).toEqual(table);
        console.info('CYLINDER_NATIVE_HISTORY', JSON.stringify({ operation, expectedVolume,
          summary: summary(table), rows: table }));
      } finally { built.release(); }
    });

  it.each(['union', 'difference', 'intersection', 'fillet', 'chamfer'] as const)(
    '%s: 借用した入力とmakerを保持し、履歴を全所有物解放後のplain表へ取り出す', operation => {
      const built = fixture(operation), before = built.inputs.map(input => metrics(input.shape));
      const original = metrics(built.original), output = metrics(built.output);
      const expectedVolume = operation === 'union' ? 15000 : operation === 'difference' ? 7000
        : operation === 'intersection' ? 1000 : operation === 'chamfer' ? 7960 : 8000 - 20 * (4 - Math.PI);
      expect(output.volume).toBeCloseTo(expectedVolume, 6);
      expect(isValidShape(oc, built.output)).toBe(true);
      const returned = new Set<TopTools_ListOfShape>(), returnedSizes: number[] = [];
      const modified = built.builder.Modified.bind(built.builder), generated = built.builder.Generated.bind(built.builder);
      vi.spyOn(built.builder, 'Modified').mockImplementation(shape => { const list = modified(shape); returned.add(list); returnedSizes.push(list.Size()); return list; });
      vi.spyOn(built.builder, 'Generated').mockImplementation(shape => { const list = generated(shape); returned.add(list); returnedSizes.push(list.Size()); return list; });
      const borrowed = [vi.spyOn(built.builder, 'delete'), vi.spyOn(built.output, 'delete'),
        ...built.inputs.map(input => vi.spyOn(input.shape, 'delete'))];
      const owned = observeOwnership(false);
      let table: readonly SubShapeHistoryEntry[];
      try {
        table = extractSubShapeHistory(oc, built.builder, built.inputs, built.output);
        expect(extractSubShapeHistory(oc, built.builder, built.inputs, built.output)).toEqual(table);
        expect(owned.every(record => record.deletes === 1)).toBe(true);
        expect(borrowed.every(spy => spy.mock.calls.length === 0)).toBe(true);
        expect([...returned].every(list => owned.some(record => record.item === list && record.deletes === 1))).toBe(true);
        expect(owned.filter(record => record.item instanceof oc.TopTools_ListOfShape && !returned.has(record.item)).length).toBe(returned.size);
        expect(owned.some(record => record.item instanceof oc.TopoDS_Shape)).toBe(true);
        expect(returnedSizes).toContain(0);
        expect(returnedSizes.some(size => size > 0)).toBe(true);
        // Stop observing before independent geometry measurements allocate their own wrappers.
        cleanup(owned);
        expect(built.inputs.map(input => metrics(input.shape))).toEqual(before);
        expect(metrics(built.original)).toEqual(original);
        expect(metrics(built.output)).toEqual(output);
        const outputFaces = buildSolidBodyMesh(oc, 'output', built.output).faces;
        if (operation === 'fillet' || operation === 'chamfer') {
          const edge = table.find(entry => entry.sourceId === 'target' && entry.input.kind === 'edge' && entry.input.index === 0);
          expect(edge?.deleted).toBe(true);
          const faceIndices = edge?.generated.filter(address => address.kind === 'face').map(address => address.index) ?? [];
          expect(faceIndices).toHaveLength(1);
          const face = outputFaces[faceIndices[0]];
          expect(face.surfaceKind).toBe(operation === 'fillet' ? 'cylinder' : 'plane');
          expect(face.area).toBeCloseTo(operation === 'fillet' ? 20 * Math.PI : 40 * Math.SQRT2, 6);
        } else {
          const sourceFaces = buildSolidBodyMesh(oc, 'source', built.inputs[0].shape).faces;
          const sourceFace = sourceFaces.find(face => face.centroid[0] === 20 && face.centroid[1] === 10 && face.centroid[2] === 10);
          if (sourceFace === undefined) throw new Error('Expected x=20 source face');
          const entry = table.find(value => value.sourceId === 'target' && value.input.kind === 'face' && value.input.index === sourceFace.index);
          expect(entry?.modified).toHaveLength(1);
          const faceIndex = entry?.modified[0]?.index;
          if (faceIndex === undefined) throw new Error('Expected modified face');
          expect(outputFaces[faceIndex].area).toBeCloseTo(operation === 'intersection' ? 100 : 300, 6);
          expect(outputFaces[faceIndex].centroid[0]).toBeCloseTo(20, 10);
        }
        console.info('OCCT_HISTORY_PROOF', JSON.stringify({ operation, summary: summary(table),
          ownership: { owned: owned.length, returnedLists: returned.size, emptyLists: returnedSizes.filter(size => size === 0).length,
            eachOwnedDeletedOnce: owned.every(record => record.deletes === 1), borrowedDeleted: 0 },
          geometry: { inputs: before, output }, table }));
      } finally { cleanup(owned); built.release(); }
      // Serialization after releasing the builder cannot access WASM-owned state.
      expect(JSON.parse(JSON.stringify(table))).toEqual(table);
    });

  it.each(['find-index', 'shape-kind', 'query', 'delete'] as const)('%s例外でも所有物は各1回、借用物は0回解放', mode => {
    const built = fixture('difference'), before = metrics(built.original), owned = observeOwnership(mode === 'delete');
    const inputDelete = vi.spyOn(built.original, 'delete'), builderDelete = vi.spyOn(built.builder, 'delete');
    try {
      if (mode === 'find-index') vi.spyOn(oc.TopTools_IndexedMapOfShape.prototype, 'FindIndex').mockReturnValue(0);
      if (mode === 'shape-kind') vi.spyOn(oc.TopTools_ListOfShape.prototype, 'First_1').mockImplementation(function (this: TopTools_ListOfShape) {
        const item = built.original.EmptyCopied();
        return item;
      });
      if (mode === 'query') vi.spyOn(built.builder, 'Generated').mockImplementation(() => { throw new Error('injected query failure'); });
      expect(() => extractSubShapeHistory(oc, built.builder, built.inputs, built.output)).toThrow();
      expect(owned.length).toBeGreaterThan(0);
      expect(owned.every(record => record.deletes === 1)).toBe(true);
      expect(inputDelete).not.toHaveBeenCalled(); expect(builderDelete).not.toHaveBeenCalled();
    } finally { cleanup(owned); expect(metrics(built.original)).toEqual(before); built.release(); }
  });
});
