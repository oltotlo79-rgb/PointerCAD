import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { makePrimitive } from './makePrimitive.js';
import { makePlanarFace } from './makePlanarFace.js';
import { loadOcctForNode } from './loadOcct.node.js';
import * as allocationModule from './allocations.js';
import { createAllocations } from './allocations.js';
import type { OcctDeletable } from './allocations.js';
import { buildSolidBodyMesh, measureVolume } from './solidMesh.js';
import { boxSubShapeOrigins, cylinderSubShapeOrigins, sphereSubShapeOrigins, coneSubShapeOrigins, torusSubShapeOrigins, prismSubShapeOrigins, prismCurveSubShapeOrigins,
  rebindCopiedBoxOrigins, rebindCopiedCylinderOrigins, rebindTransformedOrigins } from './subShapeOrigins.js';
import { mirrorShape, scaleShape, transformShape } from './transformShape.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);
afterEach(() => { vi.restoreAllMocks(); });

interface OwnedRecord { readonly item: OcctDeletable; readonly dispose: () => void; deletes: number }
function observeOwnership(failDelete = false): OwnedRecord[] {
  const records: OwnedRecord[] = [], create = allocationModule.createAllocations;
  let injected = false;
  vi.spyOn(allocationModule, 'createAllocations').mockImplementation(() => {
    const owned = create();
    return { release: owned.release, keep<T extends OcctDeletable>(item: T): T {
      const dispose = item.delete.bind(item), record: OwnedRecord = { item, dispose, deletes: 0 };
      records.push(record);
      item.delete = () => {
        record.deletes++;
        dispose();
        if (failDelete && !injected && item instanceof oc.TopTools_IndexedMapOfShape) {
          injected = true; throw new Error('injected map delete failure');
        }
      };
      return owned.keep(item);
    } };
  });
  return records;
}
function stopObserving(records: readonly OwnedRecord[]): void {
  vi.restoreAllMocks();
  for (const record of records) if (record.deletes === 0) record.dispose();
}

function boundingBox(shape: Parameters<typeof measureVolume>[1]) {
  const owned = createAllocations();
  try {
    const bounds = owned.keep(new oc.Bnd_Box_1());
    oc.BRepBndLib.AddOptimal(shape, bounds, false, false);
    bounds.SetGap(0);
    const low = owned.keep(bounds.CornerMin()), high = owned.keep(bounds.CornerMax());
    return { minimum: [low.X(), low.Y(), low.Z()], maximum: [high.X(), high.Y(), high.Z()] };
  } finally { owned.release(); }
}

describe('実nativeから得た意味起点', () => {
  it('円筒makerの全3面/3辺/2頂点だけを束縛し、Copyと移動後に全8を現featureへ再束縛する', () => {
    const owned = createAllocations();
    try {
      const maker = owned.keep(new oc.BRepPrimAPI_MakeCylinder_1(5, 20));
      const source = owned.keep(maker.Shape());
      expect(measureVolume(oc, source)).toBeCloseTo(500 * Math.PI, 6);
      const origins = cylinderSubShapeOrigins(oc, maker, source, 'original');
      expect(origins.state).toBe('tracked');
      if (origins.state !== 'tracked') return;
      expect(origins.bindings).toHaveLength(8);
      expect(origins.bindings.map(binding => binding.origin.identity.kind)).toEqual([
        'cylinder-face', 'cylinder-face', 'cylinder-face',
        'cylinder-edge', 'cylinder-edge', 'cylinder-edge',
        'cylinder-vertex', 'cylinder-vertex',
      ]);
      expect(origins.bindings.map(binding => 'role' in binding.origin.identity
        ? binding.origin.identity.role : '')).toEqual([
        'side', 'start', 'end', 'start-ring', 'end-ring', 'seam', 'seam-start', 'seam-end',
      ]);
      expect(new Set(origins.bindings.map(binding => binding.state === 'unique'
        ? `${binding.current.kind}:${binding.current.index}` : '')).size).toBe(8);
      const faces = buildSolidBodyMesh(oc, 'cylinder', source).faces;
      const areas = origins.bindings.slice(0, 3).map(binding => {
        if (binding.state !== 'unique') throw new Error('円筒面が一意でありません');
        return faces[binding.current.index].area;
      });
      expect(areas[0]).toBeCloseTo(200 * Math.PI, 6);
      expect(areas[1]).toBeCloseTo(25 * Math.PI, 6);
      expect(areas[2]).toBeCloseTo(25 * Math.PI, 6);
      const copier = owned.keep(new oc.BRepBuilderAPI_Copy_2(source, true, true));
      const copied = owned.keep(copier.Shape());
      const rebound = rebindCopiedCylinderOrigins(oc, origins, source, copier, copied, 'copied');
      expect(rebound.state).toBe('tracked');
      if (rebound.state === 'tracked') {
        expect(rebound.bindings).toHaveLength(8);
        expect(rebound.bindings.every(binding => binding.origin.identity.featureId === 'copied')).toBe(true);
      }
      const shift = owned.keep(new oc.gp_Vec_4(1e6, -1e6, 7));
      const transform = owned.keep(new oc.gp_Trsf_1());
      transform.SetTranslation_1(shift);
      const location = owned.keep(new oc.TopLoc_Location_2(transform));
      const moved = owned.keep(copied.Moved(location, true));
      const movedOrigins = rebindCopiedCylinderOrigins(oc, origins, source, copier, moved, 'moved', location);
      expect(movedOrigins.state).toBe('tracked');
      if (movedOrigins.state === 'tracked') {
        expect(movedOrigins.bindings).toHaveLength(8);
        expect(movedOrigins.bindings.every(binding => binding.origin.identity.featureId === 'moved')).toBe(true);
      }
      const boxMaker = owned.keep(new oc.BRepPrimAPI_MakeBox_2(10, 10, 20));
      const wrongOutput = owned.keep(boxMaker.Shape());
      expect(cylinderSubShapeOrigins(oc, maker, wrongOutput, 'wrong')).toEqual({
        version: 1, state: 'untracked', reason: 'missing-native-map',
      });
      const cylinder = owned.keep(maker.Cylinder());
      const wrongAlias = vi.spyOn(maker, 'Face').mockImplementation(() => cylinder.BottomFace());
      try {
        expect(cylinderSubShapeOrigins(oc, maker, source, 'wrong-alias')).toEqual({
          version: 1, state: 'untracked', reason: 'missing-native-map',
        });
      } finally { wrongAlias.mockRestore(); }
      expect(rebindCopiedCylinderOrigins(oc, { ...origins, bindings: origins.bindings.slice(0, 7) },
        source, copier, copied, 'partial')).toEqual({ version: 1, state: 'untracked', reason: 'missing-native-map' });
      expect(rebindCopiedCylinderOrigins(oc, { ...origins,
        bindings: [...origins.bindings.slice(0, 7), origins.bindings[0]] },
      source, copier, copied, 'duplicate')).toEqual({ version: 1, state: 'untracked', reason: 'missing-native-map' });
    } finally { owned.release(); }
  });

  it('rigid transform carries every tracked cylinder origin to the moved members with unchanged identities', () => {
    // Regression for the transform step that recorded moved bodies as untracked (unsupported-producer).
    const owned = createAllocations();
    try {
      const maker = owned.keep(new oc.BRepPrimAPI_MakeCylinder_1(10, 40));
      const source = owned.keep(maker.Shape());
      const origins = cylinderSubShapeOrigins(oc, maker, source, 'cylinder-1');
      if (origins.state !== 'tracked') throw new Error('cylinder origins must be tracked');
      let rebound: ReturnType<typeof rebindTransformedOrigins> | undefined;
      let wrong: ReturnType<typeof rebindTransformedOrigins> | undefined;
      const boxMaker = owned.keep(new oc.BRepPrimAPI_MakeBox_2(10, 10, 20));
      const box = owned.keep(boxMaker.Shape());
      const boxOrigins = boxSubShapeOrigins(oc, boxMaker, box, 'box-1');
      const moved = owned.keep(transformShape(oc, source,
        { translation: [100, 0, 0], rotationAxis: [1, 0, 0], rotationAngle: Math.PI / 2, rotationOrigin: [0, 0, 0] },
        (transformer, output) => {
          rebound = rebindTransformedOrigins(oc, origins, source, transformer, output);
          // Origins of another shape are not members of this history and must not be accepted.
          wrong = rebindTransformedOrigins(oc, boxOrigins, box, transformer, output);
        }));
      expect(wrong).toEqual({ version: 1, state: 'untracked', reason: 'missing-native-map' });
      if (rebound?.state !== 'tracked') throw new Error('moved cylinder origins must stay tracked');
      expect(rebound.bindings.map(binding => binding.origin)).toEqual(origins.bindings.map(binding => binding.origin));
      expect(new Set(rebound.bindings.map(binding => binding.state === 'unique'
        ? `${binding.current.kind}:${binding.current.index}` : '')).size).toBe(8);
      const side = rebound.bindings[0];
      if (side.state !== 'unique' || side.current.kind !== 'face') throw new Error('side face binding must be unique');
      const face = buildSolidBodyMesh(oc, 'moved', moved.shape).faces[side.current.index];
      // R_x(+90) maps the cylinder axis (0, 0, 1) to (0, -1, 0); the side area 2 * pi * 10 * 40 is unchanged.
      expect(face.surfaceKind).toBe('cylinder');
      expect(face.area).toBeCloseTo(800 * Math.PI, 6);
      if (face.axis === null) throw new Error('moved side axis missing');
      expect(Math.abs(Math.abs(face.axis[1]) - 1)).toBeLessThan(1e-9);
      expect(Math.abs(face.axis[0]) + Math.abs(face.axis[2])).toBeLessThan(1e-9);
    } finally { owned.release(); }
  });

  it('mirror and uniform scale carry every tracked cylinder origin; per-axis scale exposes no history', () => {
    // Regression for mirror/scale steps that recorded their bodies as untracked (unsupported-producer).
    const owned = createAllocations();
    try {
      const build = (radius: number) => {
        const maker = owned.keep(new oc.BRepPrimAPI_MakeCylinder_1(radius, 40));
        const shape = owned.keep(maker.Shape());
        const origins = cylinderSubShapeOrigins(oc, maker, shape, 'cylinder-1');
        if (origins.state !== 'tracked') throw new Error('cylinder origins must be tracked');
        return { shape, origins };
      };
      const boxMaker = owned.keep(new oc.BRepPrimAPI_MakeBox_2(10, 10, 20));
      const box = owned.keep(boxMaker.Shape());
      const boxOrigins = boxSubShapeOrigins(oc, boxMaker, box, 'box-1');
      const roleOf = (binding: { origin: { identity: object } }) =>
        'role' in binding.origin.identity ? binding.origin.identity.role : undefined;
      const check = (source: ReturnType<typeof build>, run: (onBuilt: Parameters<typeof transformShape>[3]) =>
        { shape: Parameters<typeof buildSolidBodyMesh>[2] }) => {
        // A holder object, not `let`: TypeScript keeps a callback-assigned `let` narrowed to undefined (never after a guard).
        const captured: { rebound?: ReturnType<typeof rebindTransformedOrigins>; wrong?: ReturnType<typeof rebindTransformedOrigins> } = {};
        const result = run((transformer, output) => {
          captured.rebound = rebindTransformedOrigins(oc, source.origins, source.shape, transformer, output);
          // Origins of another shape are not members of this history and must not be accepted.
          captured.wrong = rebindTransformedOrigins(oc, boxOrigins, box, transformer, output);
        });
        expect(captured.wrong).toEqual({ version: 1, state: 'untracked', reason: 'missing-native-map' });
        const rebound = captured.rebound;
        if (rebound?.state !== 'tracked') throw new Error('rebound cylinder origins must stay tracked');
        expect(rebound.bindings.map(binding => binding.origin)).toEqual(source.origins.bindings.map(binding => binding.origin));
        expect(new Set(rebound.bindings.map(binding => binding.state === 'unique'
          ? `${binding.current.kind}:${binding.current.index}` : '')).size).toBe(8);
        const faces = buildSolidBodyMesh(oc, 'result', result.shape).faces;
        const faceOf = (role: string) => {
          const binding = rebound.bindings.find(item => item.origin.shapeKind === 'face' && roleOf(item) === role);
          if (binding?.state !== 'unique' || binding.current.kind !== 'face') throw new Error(`${role} face binding must be unique`);
          return { index: binding.current.index, face: faces[binding.current.index] };
        };
        return { side: faceOf('side'), start: faceOf('start'), end: faceOf('end') };
      };

      // Mirror in the plane z = 50: the start disk (z = 0) maps to z = 100 and the end disk (z = 40) to z = 60, so the
      // references keep their roles on the reflected members (not swapped by the orientation reversal).
      const plane = { origin: [0, 0, 50] as const, normal: [0, 0, 1] as const };
      const first = build(10);
      const mirrored = check(first, onBuilt => owned.keep(mirrorShape(oc, first.shape, plane, onBuilt)));
      expect(mirrored.side.face.surfaceKind).toBe('cylinder');
      expect(mirrored.side.face.area).toBeCloseTo(800 * Math.PI, 6);
      expect(mirrored.start.face.centroid[2]).toBeCloseTo(100, 6);
      expect(mirrored.end.face.centroid[2]).toBeCloseTo(60, 6);
      expect(Math.abs(Math.abs(mirrored.start.face.axis?.[2] ?? 0) - 1)).toBeLessThan(1e-9);

      // Edit the radius and mirror again: the same semantic side reference resolves to the same member of the new result.
      const edited = build(12);
      const remirrored = check(edited, onBuilt => owned.keep(mirrorShape(oc, edited.shape, plane, onBuilt)));
      expect(remirrored.side.index).toBe(mirrored.side.index);
      expect(remirrored.side.face.area).toBeCloseTo(960 * Math.PI, 6);
      expect(remirrored.start.face.centroid[2]).toBeCloseTo(100, 6);

      // Uniform scale 2 about the origin: radius 20, height 80, side area 2 * pi * 20 * 80.
      const scaled = check(first, onBuilt => owned.keep(scaleShape(oc, first.shape,
        { origin: [0, 0, 0], uniform: 2, perAxis: null }, onBuilt)));
      expect(scaled.side.face.surfaceKind).toBe('cylinder');
      expect(scaled.side.face.area).toBeCloseTo(3200 * Math.PI, 6);
      expect(scaled.start.face.centroid[2]).toBeCloseTo(0, 6);
      expect(scaled.end.face.centroid[2]).toBeCloseTo(80, 6);

      // Per-axis scale (GTransform) must never offer a history to bind through: its result stays untracked.
      const calls = { count: 0 };
      owned.keep(scaleShape(oc, first.shape, { origin: [0, 0, 0], uniform: null, perAxis: [1, 2, 3] }, () => { calls.count += 1; }));
      expect(calls.count).toBe(0);
    } finally { owned.release(); }
  });

  it('円筒accessor例外でもhelper所有mapを解放しmaker/outputを借用のまま保つ', () => {
    const fixture = createAllocations();
    try {
      const maker = fixture.keep(new oc.BRepPrimAPI_MakeCylinder_1(5, 20));
      const source = fixture.keep(maker.Shape());
      const volume = measureVolume(oc, source);
      const borrowed = [vi.spyOn(maker, 'delete'), vi.spyOn(source, 'delete')];
      vi.spyOn(maker, 'Cylinder').mockImplementation(() => { throw new Error('injected cylinder query failure'); });
      const records = observeOwnership();
      try {
        expect(() => cylinderSubShapeOrigins(oc, maker, source, 'failure')).toThrow('injected cylinder query failure');
        expect(records.length).toBeGreaterThan(0);
        expect(records.every(record => record.deletes === 1)).toBe(true);
        expect(borrowed.every(spy => spy.mock.calls.length === 0)).toBe(true);
      } finally { stopObserving(records); }
      expect(measureVolume(oc, source)).toBeCloseTo(volume, 6);
    } finally { fixture.release(); }
  });

  it.each(['success', 'query', 'delete'] as const)('Box helperの%s経路でowned各1回・借用0回', mode => {
    const fixture = createAllocations();
    const maker = fixture.keep(new oc.BRepPrimAPI_MakeBox_2(20, 20, 20));
    const box = fixture.keep(maker.Shape());
    const originalVolume = measureVolume(oc, box);
    const borrowed = [vi.spyOn(maker, 'delete'), vi.spyOn(box, 'delete')];
    const records = observeOwnership(mode === 'delete');
    try {
      if (mode === 'query') vi.spyOn(maker, 'TopFace').mockImplementation(() => { throw new Error('injected face failure'); });
      if (mode === 'success') {
        const result = boxSubShapeOrigins(oc, maker, box, 'feature');
        expect(result.state).toBe('tracked');
        expect(boxSubShapeOrigins(oc, maker, box, 'feature')).toEqual(result);
      } else expect(() => boxSubShapeOrigins(oc, maker, box, 'feature')).toThrow();
      expect(records.length).toBeGreaterThan(0);
      expect(records.every(record => record.deletes === 1)).toBe(true);
      expect(borrowed.every(spy => spy.mock.calls.length === 0)).toBe(true);
    } finally {
      stopObserving(records);
      expect(measureVolume(oc, box)).toBeCloseTo(originalVolume, 6);
      fixture.release();
    }
  });

  it.each(['unknown-map', 'query'] as const)('Copyの%s時は偽のtrackedを返さず、所有物を解放する', mode => {
    const fixture = createAllocations();
    try {
      const maker = fixture.keep(new oc.BRepPrimAPI_MakeBox_2(20, 20, 20));
      const source = fixture.keep(maker.Shape());
      const origins = boxSubShapeOrigins(oc, maker, source, 'prototype');
      const copier = fixture.keep(new oc.BRepBuilderAPI_Copy_2(source, true, true));
      const output = fixture.keep(copier.Shape());
      const before = measureVolume(oc, output);
      const borrowed = [vi.spyOn(source, 'delete'), vi.spyOn(output, 'delete'), vi.spyOn(copier, 'delete')];
      if (mode === 'unknown-map') vi.spyOn(copier, 'ModifiedShape').mockImplementation(() => source.EmptyCopied());
      else vi.spyOn(copier, 'ModifiedShape').mockImplementation(() => { throw new Error('injected copy query failure'); });
      const records = observeOwnership();
      try {
        if (mode === 'unknown-map') expect(rebindCopiedBoxOrigins(oc, origins, source, copier, output, 'current'))
          .toEqual({ version: 1, state: 'untracked', reason: 'missing-native-map' });
        else expect(() => rebindCopiedBoxOrigins(oc, origins, source, copier, output, 'current')).toThrow();
        expect(records.length).toBeGreaterThan(0);
        expect(records.every(record => record.deletes === 1)).toBe(true);
        expect(borrowed.every(spy => spy.mock.calls.length === 0)).toBe(true);
      } finally {
        stopObserving(records);
        expect(measureVolume(oc, output)).toBeCloseTo(before, 6);
      }
    } finally { fixture.release(); }
  });

  it('Boxのmaker面とincident同一shapeが6/12/8の一意roleを与え、Copyが現在featureへ再束縛する', () => {
    const owned = createAllocations();
    let serialized: string | undefined;
    try {
      const maker = owned.keep(new oc.BRepPrimAPI_MakeBox_2(20, 20, 20));
      const box = owned.keep(maker.Shape());
      expect(measureVolume(oc, box)).toBeCloseTo(8000, 6);
      expect(boundingBox(box)).toEqual({ minimum: [0, 0, 0], maximum: [20, 20, 20] });
      const origins = boxSubShapeOrigins(oc, maker, box, 'prototype');
      expect(origins.state).toBe('tracked');
      expect(boxSubShapeOrigins(oc, maker, box, 'prototype')).toEqual(origins);
      if (origins.state !== 'tracked') return;
      expect(origins.bindings.filter(binding => binding.origin.shapeKind === 'face')).toHaveLength(6);
      expect(origins.bindings.filter(binding => binding.origin.shapeKind === 'edge')).toHaveLength(12);
      expect(origins.bindings.filter(binding => binding.origin.shapeKind === 'vertex')).toHaveLength(8);
      expect(new Set(origins.bindings.map(binding => JSON.stringify(binding.origin))).size).toBe(26);
      const copier = owned.keep(new oc.BRepBuilderAPI_Copy_2(box, true, true));
      const copied = owned.keep(copier.Shape());
      expect(measureVolume(oc, copied)).toBeCloseTo(8000, 6);
      expect(boundingBox(copied)).toEqual(boundingBox(box));
      const rebound = (() => {
        const borrowed = [vi.spyOn(box, 'delete'), vi.spyOn(copier, 'delete'), vi.spyOn(copied, 'delete')];
        const records = observeOwnership();
        try {
          const first = rebindCopiedBoxOrigins(oc, origins, box, copier, copied, 'current');
          expect(rebindCopiedBoxOrigins(oc, origins, box, copier, copied, 'current')).toEqual(first);
          expect(records.length).toBeGreaterThan(0);
          expect(records.every(record => record.deletes === 1)).toBe(true);
          expect(borrowed.every(spy => spy.mock.calls.length === 0)).toBe(true);
          return first;
        } finally { stopObserving(records); }
      })();
      expect(rebound.state).toBe('tracked');
      if (rebound.state !== 'tracked') return;
      expect(rebound.bindings).toHaveLength(26);
      expect(rebound.bindings.every(binding => binding.origin.identity.featureId === 'current')).toBe(true);
      expect(JSON.stringify(rebound)).not.toContain('prototype');
      const shift = owned.keep(new oc.gp_Vec_4(5, 7, -3));
      const transform = owned.keep(new oc.gp_Trsf_1());
      transform.SetTranslation_1(shift);
      const location = owned.keep(new oc.TopLoc_Location_2(transform));
      const moved = owned.keep(copied.Moved(location, true));
      expect(measureVolume(oc, moved)).toBeCloseTo(8000, 6);
      expect(boundingBox(moved)).toEqual({ minimum: [5, 7, -3], maximum: [25, 27, 17] });
      const movedOrigins = rebindCopiedBoxOrigins(oc, origins, box, copier, moved, 'moved-current', location);
      expect(movedOrigins.state).toBe('tracked');
      if (movedOrigins.state === 'tracked') {
        expect(movedOrigins.bindings).toHaveLength(26);
        expect(movedOrigins.bindings.every(binding => binding.origin.identity.featureId === 'moved-current')).toBe(true);
      }
      serialized = JSON.stringify(rebound);
      console.info('OCCT_ORIGIN_BOX_PROOF', JSON.stringify({ volume: measureVolume(oc, box),
        counts: { faces: 6, edges: 12, vertices: 8 }, unique: origins.bindings.length,
        copyRebound: rebound.bindings.length, movedRebound: movedOrigins.state === 'tracked' ? movedOrigins.bindings.length : 0,
        movedBBox: boundingBox(moved), originalIdLeak: 0 }));
    } finally { owned.release(); }
    expect(JSON.parse(serialized ?? '{}')).toMatchObject({ state: 'tracked' });
  });

  it.each([-15, 5] as const)('保存された独立4lineの実prism開始Z=%iで側面4とcap2を束縛する', startZ => {
    const owned = createAllocations();
    let serialized: string | undefined;
    try {
      const corners = [[0, 0, startZ], [10, 0, startZ], [10, 20, startZ], [0, 20, startZ]] as const;
      const wireMaker = owned.keep(new oc.BRepBuilderAPI_MakeWire_1());
      const vertices = corners.map(corner => {
        const point = owned.keep(new oc.gp_Pnt_3(corner[0], corner[1], corner[2]));
        return owned.keep(owned.keep(new oc.BRepBuilderAPI_MakeVertex(point)).Vertex());
      });
      const lines = corners.map((_, index) => {
        const edgeMaker = owned.keep(new oc.BRepBuilderAPI_MakeEdge_2(vertices[index], vertices[(index + 1) % vertices.length]));
        const edge = owned.keep(edgeMaker.Edge());
        wireMaker.Add_1(edge);
        return { edge, anchor: { sketchId: 'sketch', faceFeatureId: 'region',
          lineFeatureId: `line-${index}`, role: 'whole-line' as const } };
      });
      expect(wireMaker.IsDone()).toBe(true);
      const wire = owned.keep(wireMaker.Wire());
      expect(wire.Closed_1()).toBe(true);
      const faceMaker = owned.keep(new oc.BRepBuilderAPI_MakeFace_15(wire, true));
      expect(faceMaker.IsDone()).toBe(true);
      const face = owned.keep(faceMaker.Face());
      const faceBefore = boundingBox(face);
      expect(faceBefore).toEqual({ minimum: [0, 0, startZ], maximum: [10, 20, startZ] });
      const direction = owned.keep(new oc.gp_Vec_4(0, 0, 30));
      const prism = owned.keep(new oc.BRepPrimAPI_MakePrism_1(face, direction, false, true));
      const output = owned.keep(prism.Shape());
      expect(measureVolume(oc, output)).toBeCloseTo(6000, 6);
      expect(boundingBox(output)).toEqual({ minimum: [0, 0, startZ], maximum: [10, 20, startZ + 30] });
      const region = { sketchId: 'sketch', faceFeatureId: 'region',
        lineFeatureIds: ['line-0', 'line-1', 'line-2', 'line-3'] as [string, string, string, string] };
      const savedIdBefore = JSON.stringify({ region, anchors: lines.map(line => line.anchor) });
      const faceMap = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
      const outputMap = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
      oc.TopExp.MapShapes_2(face, faceMap, true, true);
      oc.TopExp.MapShapes_2(output, outputMap, true, true);
      const nativeProbe = lines.map(line => {
        const list = owned.keep(prism.Generated(line.edge));
        const first = list.Size() > 0 ? owned.keep(list.First_1()) : null;
        return { inFace: faceMap.FindIndex(line.edge), generated: list.Size(),
          inOutput: first === null ? -1 : outputMap.FindIndex(first) };
      });
      const firstCap = owned.keep(prism.FirstShape_1()), lastCap = owned.keep(prism.LastShape_1());
      console.info('OCCT_ORIGIN_PRISM_DIAG', JSON.stringify({ nativeProbe,
        capInOutput: [outputMap.FindIndex(firstCap), outputMap.FindIndex(lastCap)] }));
      const origins = (() => {
        const borrowed = [vi.spyOn(prism, 'delete'), vi.spyOn(face, 'delete'), vi.spyOn(output, 'delete'),
          ...lines.map(line => vi.spyOn(line.edge, 'delete'))];
        const records = observeOwnership();
        try {
          const first = prismSubShapeOrigins(oc, prism, face, output, lines, region, 'extrude');
          expect(prismSubShapeOrigins(oc, prism, face, output, lines, region, 'extrude')).toEqual(first);
          expect(records.length).toBeGreaterThan(0);
          expect(records.every(record => record.deletes === 1)).toBe(true);
          expect(borrowed.every(spy => spy.mock.calls.length === 0)).toBe(true);
          return first;
        } finally { stopObserving(records); }
      })();
      expect(origins.state).toBe('tracked');
      if (origins.state !== 'tracked') return;
      expect(origins.bindings).toHaveLength(6);
      expect(origins.bindings.filter(binding => binding.origin.identity.kind === 'extrude-side')).toHaveLength(4);
      expect(origins.bindings.filter(binding => binding.origin.identity.kind === 'extrude-cap')).toHaveLength(2);
      expect(new Set(origins.bindings.map(binding => binding.state === 'unique' ? binding.current.index : -1)).size).toBe(6);
      expect(prismSubShapeOrigins(oc, prism, face, output, lines, { ...region,
        lineFeatureIds: ['line-0', 'line-1', 'line-2', 'unrelated'] }, 'extrude'))
        .toEqual({ version: 1, state: 'untracked', reason: 'unsupported-profile-piece' });
      const faces = buildSolidBodyMesh(oc, 'prism', output).faces;
      const areas = origins.bindings.map(binding => {
        if (binding.state !== 'unique') throw new Error('expected unique native binding');
        return faces[binding.current.index].area;
      });
      [300, 600, 300, 600, 200, 200].forEach((area, index) =>
        expect(areas[index]).toBeCloseTo(area, 6));
      expect(boundingBox(face)).toEqual(faceBefore);
      expect(JSON.stringify({ region, anchors: lines.map(line => line.anchor) })).toBe(savedIdBefore);
      for (const mode of ['empty-generated', 'query', 'first-shape'] as const) {
        if (mode === 'empty-generated') vi.spyOn(prism, 'Generated').mockImplementation(() => new oc.TopTools_ListOfShape_1());
        if (mode === 'query') vi.spyOn(prism, 'Generated').mockImplementation(() => { throw new Error('injected prism query failure'); });
        if (mode === 'first-shape') vi.spyOn(prism, 'FirstShape_1').mockImplementation(() => { throw new Error('injected first shape failure'); });
        const borrowed = [vi.spyOn(prism, 'delete'), vi.spyOn(face, 'delete'), vi.spyOn(output, 'delete')];
        const records = observeOwnership();
        try {
          if (mode === 'empty-generated') expect(prismSubShapeOrigins(oc, prism, face, output, lines, region, 'extrude'))
            .toEqual({ version: 1, state: 'untracked', reason: 'missing-native-map' });
          else expect(() => prismSubShapeOrigins(oc, prism, face, output, lines, region, 'extrude')).toThrow();
          expect(records.length).toBeGreaterThan(0);
          expect(records.every(record => record.deletes === 1)).toBe(true);
          expect(borrowed.every(spy => spy.mock.calls.length === 0)).toBe(true);
        } finally { stopObserving(records); }
      }
      serialized = JSON.stringify(origins);
      console.info('OCCT_ORIGIN_PRISM_PROOF', JSON.stringify({ startZ, volume: measureVolume(oc, output),
        bbox: boundingBox(output), areas, sideFaces: 4, capFaces: 2,
        savedLineIds: lines.map(line => line.anchor.lineFeatureId) }));
    } finally { owned.release(); }
    expect(JSON.parse(serialized ?? '{}')).toMatchObject({ state: 'tracked' });
  });
});


describe('whole sphere native producer', () => {
  it('binds the actual single surface and rejects foreign, partial and mismatched native faces', () => {
    const owned = createAllocations();
    try {
      const maker = owned.keep(new oc.BRepPrimAPI_MakeSphere_1(10));
      const output = owned.keep(maker.Shape());
      const origins = sphereSubShapeOrigins(oc, maker, output, 'saved-sphere');
      expect(origins.state).toBe('tracked');
      if (origins.state !== 'tracked') throw new Error('Sphere origin missing');
      expect(origins.bindings).toHaveLength(1);
      const binding = origins.bindings[0];
      if (binding.state !== 'unique') throw new Error('Sphere origin not unique');
      expect(binding.origin).toEqual({ version: 1, shapeKind: 'face', identity: {
        kind: 'sphere-face', featureId: 'saved-sphere', role: 'surface',
      } });
      const faces = buildSolidBodyMesh(oc, 'runtime-body', output).faces;
      expect(faces).toHaveLength(1);
      expect(faces[binding.current.index].surfaceKind).toBe('sphere');
      expect(faces[binding.current.index].area).toBeCloseTo(400 * Math.PI, 6);
      const foreign = owned.keep(new oc.BRepPrimAPI_MakeSphere_1(10));
      const foreignOutput = owned.keep(foreign.Shape());
      expect(sphereSubShapeOrigins(oc, maker, foreignOutput, 'foreign')).toEqual({
        version: 1, state: 'untracked', reason: 'missing-native-map',
      });
      const partial = owned.keep(new oc.BRepPrimAPI_MakeSphere_2(10, Math.PI));
      expect(sphereSubShapeOrigins(oc, partial, owned.keep(partial.Shape()), 'partial')).toEqual({
        version: 1, state: 'untracked', reason: 'missing-native-map',
      });
      const wrongAlias = vi.spyOn(maker, 'Face').mockImplementation(() => foreign.Face());
      try {
        expect(sphereSubShapeOrigins(oc, maker, output, 'wrong-alias')).toEqual({
          version: 1, state: 'untracked', reason: 'missing-native-map',
        });
      } finally { wrongAlias.mockRestore(); }
      expect(sphereSubShapeOrigins(oc, maker, output, 'x'.repeat(257))).toEqual({
        version: 1, state: 'untracked', reason: 'limit',
      });
    } finally { owned.release(); }
  });

  it.each([5, 10])('the real primitive route keeps the saved surface identity at radius %i', radius => {
    const handle = makePrimitive(oc, { kind: 'primitive', origin: [11, -7, 3], axis: [0, 1, 0],
      shape: { kind: 'sphere', radius }, originQuery: null, targetKey: null }, 'persisted-sphere');
    try {
      const origins = handle.origins;
      expect(origins?.state).toBe('tracked');
      if (origins?.state !== 'tracked') throw new Error('Primitive did not forward native origin');
      expect(origins.bindings).toHaveLength(1);
      const binding = origins.bindings[0];
      if (binding.state !== 'unique') throw new Error('Primitive origin not unique');
      expect(binding.origin).toEqual({ version: 1, shapeKind: 'face', identity: {
        kind: 'sphere-face', featureId: 'persisted-sphere', role: 'surface',
      } });
      const face = buildSolidBodyMesh(oc, 'different-runtime-id', handle.shape).faces[binding.current.index];
      expect(face.surfaceKind).toBe('sphere');
      expect(face.radius).toBeCloseTo(radius, 9);
      expect(measureVolume(oc, handle.shape)).toBeCloseTo(4 / 3 * Math.PI * radius ** 3, 6);
    } finally { handle.delete(); }
  });

  it('releases owned maps when the sphere accessor fails without deleting borrowed inputs', () => {
    const fixture = createAllocations();
    try {
      const maker = fixture.keep(new oc.BRepPrimAPI_MakeSphere_1(10));
      const output = fixture.keep(maker.Shape());
      const borrowed = [vi.spyOn(maker, 'delete'), vi.spyOn(output, 'delete')];
      vi.spyOn(maker, 'Sphere').mockImplementation(() => { throw new Error('sphere accessor failure'); });
      const records = observeOwnership();
      try {
        expect(() => sphereSubShapeOrigins(oc, maker, output, 'sphere')).toThrow('sphere accessor failure');
        expect(records.length).toBeGreaterThan(0);
        expect(records.every(record => record.deletes === 1)).toBe(true);
        expect(borrowed.every(spy => spy.mock.calls.length === 0)).toBe(true);
      } finally { stopObserving(records); }
    } finally { fixture.release(); }
  });
});


describe('full cone and torus native face producers', () => {
  it.each([[10, 5], [10, 0], [0, 10], [5, 10]])('cone radii %i/%i retain only actual side and caps', (bottomRadius, topRadius) => {
    const handle = makePrimitive(oc, { kind: 'primitive', origin: [3, -4, 7], axis: [0, 0, 1],
      shape: { kind: 'cone', bottomRadius, topRadius, height: 20 }, originQuery: null, targetKey: null }, 'saved-cone');
    try {
      const origins = handle.origins;
      if (origins?.state !== 'tracked') throw new Error('Cone native origin missing');
      const roles = ['side', ...(bottomRadius > 0 ? ['start'] : []), ...(topRadius > 0 ? ['end'] : [])];
      expect(origins.bindings).toHaveLength(roles.length);
      const faces = buildSolidBodyMesh(oc, 'runtime-cone', handle.shape).faces;
      expect(faces).toHaveLength(roles.length);
      const used = new Set<number>();
      for (const [index, binding] of origins.bindings.entries()) {
        if (binding.state !== 'unique') throw new Error('Cone face not unique');
        expect(binding.origin).toEqual({ version: 1, shapeKind: 'face', identity: {
          kind: 'cone-face', featureId: 'saved-cone', role: roles[index],
        } });
        used.add(binding.current.index);
        const face = faces[binding.current.index];
        if (roles[index] === 'side') {
          expect(face.surfaceKind).toBe('cone');
          expect(face.area).toBeCloseTo(Math.PI * (bottomRadius + topRadius) * Math.hypot(20, bottomRadius - topRadius), 6);
        } else {
          expect(face.surfaceKind).toBe('plane');
          const radius = roles[index] === 'start' ? bottomRadius : topRadius;
          expect(face.area).toBeCloseTo(Math.PI * radius ** 2, 6);
          expect(face.centroid[2]).toBeCloseTo(roles[index] === 'start' ? 7 : 27, 6);
        }
      }
      expect(used.size).toBe(faces.length);
      expect(measureVolume(oc, handle.shape)).toBeCloseTo(Math.PI * 20 / 3
        * (bottomRadius ** 2 + bottomRadius * topRadius + topRadius ** 2), 6);
    } finally { handle.delete(); }
  });

  it.each([[20, 5], [30, 3]])('torus radii %i/%i retain the same saved surface through the real primitive route', (majorRadius, minorRadius) => {
    const handle = makePrimitive(oc, { kind: 'primitive', origin: [11, -7, 3], axis: [0, 1, 0],
      shape: { kind: 'torus', majorRadius, minorRadius }, originQuery: null, targetKey: null }, 'saved-torus');
    try {
      const origins = handle.origins;
      if (origins?.state !== 'tracked') throw new Error('Torus native origin missing');
      expect(origins.bindings).toHaveLength(1);
      const binding = origins.bindings[0];
      if (binding.state !== 'unique') throw new Error('Torus face not unique');
      expect(binding.origin).toEqual({ version: 1, shapeKind: 'face', identity: {
        kind: 'torus-face', featureId: 'saved-torus', role: 'surface',
      } });
      const faces = buildSolidBodyMesh(oc, 'runtime-torus', handle.shape).faces;
      expect(faces).toHaveLength(1);
      expect(faces[binding.current.index].surfaceKind).toBe('torus');
      expect(faces[binding.current.index].area).toBeCloseTo(4 * Math.PI ** 2 * majorRadius * minorRadius, 6);
      expect(measureVolume(oc, handle.shape)).toBeCloseTo(2 * Math.PI ** 2 * majorRadius * minorRadius ** 2, 6);
    } finally { handle.delete(); }
  });

  it('refuses foreign, partial and aliased cone faces, including a duplicate cap claim', () => {
    const owned = createAllocations();
    const refused = { version: 1, state: 'untracked', reason: 'missing-native-map' };
    try {
      const maker = owned.keep(new oc.BRepPrimAPI_MakeCone_1(10, 5, 20));
      const output = owned.keep(maker.Shape());
      const foreign = owned.keep(new oc.BRepPrimAPI_MakeCone_1(10, 5, 20));
      expect(coneSubShapeOrigins(oc, maker, owned.keep(foreign.Shape()), 'foreign')).toEqual(refused);
      expect(coneSubShapeOrigins(oc, maker, owned.keep(maker.Face()), 'face-only')).toEqual(refused);
      const partial = owned.keep(new oc.BRepPrimAPI_MakeCone_2(10, 5, 20, Math.PI));
      expect(coneSubShapeOrigins(oc, partial, owned.keep(partial.Shape()), 'partial')).toEqual(refused);
      const alias = vi.spyOn(maker, 'Face').mockImplementation(() => foreign.Face());
      try { expect(coneSubShapeOrigins(oc, maker, output, 'alias')).toEqual(refused); }
      finally { alias.mockRestore(); }
      const actualCone = maker.Cone.bind(maker);
      const duplicate = vi.spyOn(maker, 'Cone').mockImplementation(() => {
        const cone = actualCone();
        cone.TopFace = () => cone.BottomFace();
        return cone;
      });
      try { expect(coneSubShapeOrigins(oc, maker, output, 'duplicate')).toEqual(refused); }
      finally { duplicate.mockRestore(); }
      expect(coneSubShapeOrigins(oc, maker, output, 'x'.repeat(257))).toEqual({
        version: 1, state: 'untracked', reason: 'limit',
      });
    } finally { owned.release(); }
  });

  it('refuses a foreign torus, either open period, and a mismatched native alias', () => {
    const owned = createAllocations();
    const refused = { version: 1, state: 'untracked', reason: 'missing-native-map' };
    try {
      const maker = owned.keep(new oc.BRepPrimAPI_MakeTorus_1(20, 5));
      const output = owned.keep(maker.Shape());
      const foreign = owned.keep(new oc.BRepPrimAPI_MakeTorus_1(20, 5));
      expect(torusSubShapeOrigins(oc, maker, owned.keep(foreign.Shape()), 'foreign')).toEqual(refused);
      expect(torusSubShapeOrigins(oc, maker, owned.keep(maker.Face()), 'face-only')).toEqual(refused);
      const partial = owned.keep(new oc.BRepPrimAPI_MakeTorus_2(20, 5, Math.PI));
      expect(torusSubShapeOrigins(oc, partial, owned.keep(partial.Shape()), 'open-major')).toEqual(refused);
      const partialMinor = owned.keep(new oc.BRepPrimAPI_MakeTorus_3(20, 5, -Math.PI / 2, Math.PI / 2));
      expect(torusSubShapeOrigins(oc, partialMinor, owned.keep(partialMinor.Shape()), 'open-minor')).toEqual(refused);
      const alias = vi.spyOn(maker, 'Face').mockImplementation(() => foreign.Face());
      try { expect(torusSubShapeOrigins(oc, maker, output, 'alias')).toEqual(refused); }
      finally { alias.mockRestore(); }
      expect(torusSubShapeOrigins(oc, maker, output, 'x'.repeat(257))).toEqual({
        version: 1, state: 'untracked', reason: 'limit',
      });
    } finally { owned.release(); }
  });

  it.each(['cone', 'torus'] as const)('releases owned wrappers on %s accessor failure while retaining borrowed shape', kind => {
    const fixture = createAllocations();
    try {
      const maker = kind === 'cone' ? fixture.keep(new oc.BRepPrimAPI_MakeCone_1(10, 5, 20))
        : fixture.keep(new oc.BRepPrimAPI_MakeTorus_1(20, 5));
      const output = fixture.keep(maker.Shape());
      const borrowed = [vi.spyOn(maker, 'delete'), vi.spyOn(output, 'delete')];
      const fail = (): never => { throw new Error('native producer accessor failure'); };
      if (maker instanceof oc.BRepPrimAPI_MakeCone) vi.spyOn(maker, 'Cone').mockImplementation(fail);
      else vi.spyOn(maker, 'Torus').mockImplementation(fail);
      const records = observeOwnership();
      try {
        expect(() => maker instanceof oc.BRepPrimAPI_MakeCone
          ? coneSubShapeOrigins(oc, maker, output, 'failure')
          : torusSubShapeOrigins(oc, maker, output, 'failure')).toThrow('native producer accessor failure');
        expect(records.length).toBeGreaterThan(0);
        expect(records.every(record => record.deletes === 1)).toBe(true);
        expect(borrowed.every(spy => spy.mock.calls.length === 0)).toBe(true);
      } finally { stopObserving(records); }
    } finally { fixture.release(); }
  });

  it('does not make new origins a bypass for invalid existing primitive input', () => {
    const common = { kind: 'primitive' as const, origin: [0, 0, 0] as const, axis: [0, 0, 1] as const,
      originQuery: null, targetKey: null };
    expect(() => makePrimitive(oc, { ...common, shape: { kind: 'cone', bottomRadius: 0, topRadius: 0, height: 20 } }, 'invalid')).toThrow();
    expect(() => makePrimitive(oc, { ...common, shape: { kind: 'cone', bottomRadius: 10, topRadius: 10, height: 20 } }, 'invalid')).toThrow();
    expect(() => makePrimitive(oc, { ...common, shape: { kind: 'torus', majorRadius: 5, minorRadius: 10 } }, 'invalid')).toThrow();
  });
});
it('binds actual MakeWire inserted curved edges and rejects omitted, repeated, foreign and absent native history', () => {
  const owned = createAllocations();
  try {
    const region = { sketchId: 'sketch', faceFeatureId: 'region', curveFeatureIds: ['spline', 'a', 'b'] as const };
    const profile = owned.keep(makePlanarFace(oc, [
      { kind: 'spline', mode: 'control', closed: false, points: [[0, 0, 0], [0.5, 0, 0], [1, 1, 0]] },
      { kind: 'segment', from: [1, 1, 0], to: [1, 0, 0] },
      { kind: 'segment', from: [1, 0, 0], to: [0, 0, 0] },
    ], {}, region));
    const curves = profile.nativeProfileCurves;
    expect(curves).toHaveLength(3);
    if (curves === undefined) throw new Error('Missing actual inserted native edges');
    const direction = owned.keep(new oc.gp_Vec_4(0, 0, 1));
    const prism = owned.keep(new oc.BRepPrimAPI_MakePrism_1(profile.face, direction, false, true));
    expect(prism.IsDone()).toBe(true);
    const output = owned.keep(prism.Shape());
    expect(measureVolume(oc, output)).toBeCloseTo(1 / 3, 8);
    const bind = (input: typeof curves) =>
      prismCurveSubShapeOrigins(oc, prism, profile.face, output, input, region, 'extrude');
    const result = bind(curves);
    expect(result.state).toBe('tracked');
    if (result.state !== 'tracked') throw new Error('Expected real native provenance');
    expect(result.bindings).toHaveLength(5);
    expect(new Set(result.bindings.map(binding => binding.state === 'unique' ? binding.current.index : -1)).size).toBe(5);
    expect(bind(curves.slice(1))).toEqual({ version: 1, state: 'untracked', reason: 'limit' });
    expect(prismCurveSubShapeOrigins(oc, prism, profile.face, output, curves, { ...region, sketchId: '' }, 'extrude'))
      .toEqual({ version: 1, state: 'untracked', reason: 'unsupported-profile-piece' });
    expect(bind([curves[0], { ...curves[1], edge: curves[0].edge }, curves[2]]))
      .toEqual({ version: 1, state: 'untracked', reason: 'missing-native-map' });
    expect(bind([curves[0], { ...curves[1], anchor: curves[0].anchor }, curves[2]]))
      .toEqual({ version: 1, state: 'untracked', reason: 'unsupported-profile-piece' });
    const foreign = owned.keep(new oc.BRepBuilderAPI_MakeEdge_3(
      owned.keep(new oc.gp_Pnt_3(0, 0, 0)), owned.keep(new oc.gp_Pnt_3(1, 0, 0))));
    expect(bind([curves[0], curves[1], { ...curves[2], edge: owned.keep(foreign.Edge()) }]))
      .toEqual({ version: 1, state: 'untracked', reason: 'missing-native-map' });
    const generated = vi.spyOn(prism, 'Generated').mockImplementation(() => new oc.TopTools_ListOfShape_1());
    try { expect(bind(curves)).toEqual({ version: 1, state: 'untracked', reason: 'missing-native-map' }); }
    finally { generated.mockRestore(); }
    const first = vi.spyOn(prism, 'FirstShape_1').mockImplementation(() => prism.LastShape_1());
    try { expect(bind(curves)).toEqual({ version: 1, state: 'untracked', reason: 'missing-native-map' }); }
    finally { first.mockRestore(); }
  } finally { owned.release(); }
}, 180_000);
