import type { DatumDefinition, Dimension, DrawingDocument, GdtFeature, GdtFrameSegment, GdtShapeTarget,
  GeometricToleranceFrame, ToleranceCharacteristic, ToleranceZone, Vector3, WeldKind, WeldSymbol } from '../../packages/drawing/src/index.js';
import { expressionValueFromNumber as number } from '../../packages/expression/src/index.js';
import { readPcaddFile, writePcaddFile } from '../../packages/io/src/index.js';
import { createKernelApi } from '../../packages/kernel/src/worker/kernelApi.js';
import { loadOcctForNode } from '../../packages/kernel/src/occt/loadOcct.node.js';
import { absoluteCoordinate, appendFeature, appendSolid, createDirectKernelBridge, createDrawingDocument, createEmptyPartDocument,
  createPointFeature, createPrimitiveFeature, DEFAULT_FACE_COLOR, DEFAULT_WORK_PLANE_ID, drawingSourceInputHash, IDENTITY_PLACEMENT,
  recomputePart, resolveDrawingGdt, resolveDrawingWelds, type PartDocument, type SketchDocument, type SketchFaceFeature,
  type SolidBody, type SolidEdgeEntry, type SolidFaceEntry } from '../../packages/model/src/index.js';

function sourcePart(): PartDocument {
  let part: PartDocument = { ...createEmptyPartDocument(), name: '幾何公差14種類の実形状' };
  for (const [z, width, height] of [[0, 20, 20], [40, 30, 10]]) {
    const primitive = createPrimitiveFeature(part, 'box', { kind: 'coordinate', value: absoluteCoordinate(0, 0, z) });
    if (primitive.shape.kind !== 'box') throw new Error('box required');
    part = appendSolid(part, { ...primitive, shape: { ...primitive.shape, sizeX: number(width), sizeZ: number(height) } });
  }
  for (const [z, radius] of [[0, 10], [30, 6]]) {
    const primitive = createPrimitiveFeature(part, 'cylinder', { kind: 'coordinate', value: absoluteCoordinate(60, 0, z) });
    if (primitive.shape.kind !== 'cylinder') throw new Error('cylinder required');
    part = appendSolid(part, { ...primitive, shape: { ...primitive.shape, radius: number(radius) } });
  }
  let sketch: SketchDocument = { id: 'wedge-sketch', name: '45度の断面', features: [] };
  const boundary: { featureId: string }[] = [];
  for (const [x, y] of [[100, -10], [120, -10], [120, 10]]) {
    const point = createPointFeature(sketch, absoluteCoordinate(x, y, 0)); sketch = appendFeature(sketch, point); boundary.push({ featureId: point.id });
  }
  const face: SketchFaceFeature = { id: 'face-1', name: '三角形', kind: 'face', planeId: DEFAULT_WORK_PLANE_ID, boundary, color: DEFAULT_FACE_COLOR };
  part = { ...part, sketches: [...part.sketches, appendFeature(sketch, face)] };
  return appendSolid(part, { id: 'wedge', name: '45度の三角柱', kind: 'extrude', suppressed: false,
    profile: { sketchId: sketch.id, faceFeatureId: face.id }, distance: number(20), reversed: false, symmetric: false });
}

function one<T>(items: readonly T[], label: string): T {
  if (items.length !== 1) throw new Error(`${label}: ${items.length} candidates`); return items[0];
}
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

/** 正規履歴を実OCCTで計算した面・辺を使う製作指示用紙。ブラウザーには.pcaddとして開かせる。 */
export async function fullManufacturingDrawing(): Promise<{ readonly bytes: Uint8Array; readonly document: DrawingDocument }> {
  const part = sourcePart(), partId = 'p9-manufacturing-fixture', api = createKernelApi(loadOcctForNode);
  try {
    const result = await recomputePart(part, createDirectKernelBridge(api), { partId, generation: 1 });
    if (result.errors.length !== 0 || result.cancelled || result.bodies.length !== 5) throw new Error(`OCCT fixture: ${JSON.stringify(result.errors)}`);
    const body = (id: string) => one(result.bodies.filter((item) => item.featureId === id), id);
    const boxes = result.bodies.filter((item) => item.featureId.startsWith('box-'));
    const cylinders = result.bodies.filter((item) => item.featureId.startsWith('cylinder-'));
    if (boxes.length !== 2 || cylinders.length !== 2) throw new Error('fixture primitives missing');
    const [box, datumBox] = boxes, [journal, otherJournal] = cylinders, wedge = body('wedge');
    const source = { sourceKind: 'part' as const, document: part }, sourceRef = 'source-1';
    let document = createDrawingDocument('幾何公差14種と溶接記号8種', { sourceRef, sourceKind: 'part', path: '', fileName: '製作指示.pcad',
      contentHash: await drawingSourceInputHash(source), importedAt: '2026-09-10T00:00:00.000Z' });
    document = { ...document, sheet: { ...document.sheet, paperSizeId: 'A2-landscape' }, views: [
      { id: 'front', name: '正面図', kind: 'front', position: [105, 300], direction: [0, 1, 0], xDir: [1, 0, 0], scale: 1,
        showHidden: true, showCenterLines: true, layerId: 'layer-1' },
      { id: 'top', name: '平面図', kind: 'top', position: [105, 210], direction: [0, 0, -1], xDir: [1, 0, 0], scale: 1,
        showHidden: true, showCenterLines: true, layerId: 'layer-1' },
    ] };
    const faceTarget = (solid: SolidBody, face: SolidFaceEntry, viewId = 'front'): GdtShapeTarget => ({ kind: 'subShape', viewId, sourceRef,
      ref: { bodyFeatureId: solid.featureId, index: face.index, fingerprint: { kind: 'face', surfaceKind: face.surfaceKind,
        area: face.area, position: face.centroid, axis: face.axis, radius: face.radius } } });
    const edgeTarget = (solid: SolidBody, edge: SolidEdgeEntry, viewId = 'top'): GdtShapeTarget => ({ kind: 'subShape', viewId, sourceRef,
      ref: { bodyFeatureId: solid.featureId, index: edge.index, fingerprint: { kind: 'edge', curveKind: edge.curveKind,
        length: edge.length, position: edge.midpoint, axis: edge.axis, radius: edge.radius } } });
    const plane = (solid: SolidBody, axis: number, coordinate: number) => one(solid.faces.filter((face) => face.surfaceKind === 'plane'
      && face.axis !== null && near(Math.abs(face.axis[axis]), 1) && near(face.centroid[axis], coordinate)), `plane ${axis}/${coordinate}`);
    const median = (solid: SolidBody, width: number): Extract<GdtFeature, { kind: 'medianPlane' }> => ({ kind: 'medianPlane',
      targets: [faceTarget(solid, plane(solid, 0, -width / 2)), faceTarget(solid, plane(solid, 0, width / 2))] });
    const circumference = (solid: SolidBody) => {
      const circles = solid.edges.filter((edge) => edge.curveKind === 'circle' && edge.axisOrigin !== undefined);
      const height = Math.max(...circles.map((edge) => edge.axisOrigin?.[2] ?? -Infinity));
      return one(circles.filter((edge) => near(edge.axisOrigin?.[2] ?? -Infinity, height)), 'upper circle');
    };
    const journalCircle = edgeTarget(journal, circumference(journal)), otherCircle = edgeTarget(otherJournal, circumference(otherJournal));
    const journalAxis: GdtFeature = { kind: 'axis', target: journalCircle }, otherAxis: GdtFeature = { kind: 'axis', target: otherCircle };
    const firstMedian = median(box, 20), secondMedian = median(datumBox, 30);
    const front: GdtFeature = { kind: 'surface', target: faceTarget(box, plane(box, 1, -10)) };
    const top: GdtFeature = { kind: 'surface', target: faceTarget(box, plane(box, 2, 10), 'top') };
    const cylinder: GdtFeature = { kind: 'surface', target: faceTarget(otherJournal,
      one(otherJournal.faces.filter((face) => face.surfaceKind === 'cylinder'), 'cylinder face')) };
    const diagonal = edgeTarget(wedge, one(wedge.edges.filter((edge) => edge.curveKind === 'line' && near(edge.length, Math.sqrt(800))
      && near(edge.midpoint[2], 20)), '45 degree edge'));
    const horizontal = edgeTarget(wedge, one(wedge.edges.filter((edge) => edge.curveKind === 'line' && near(edge.length, 20)
      && near(edge.midpoint[1], -10) && near(edge.midpoint[2], 20)), 'angle reference edge'));
    const size = (id: string, kind: 'diameter' | 'length', targets: readonly GdtShapeTarget[], at: number): Dimension => ({ id, kind,
      measurement: kind === 'diameter' ? 'radius' : 'trueDistance', targets, placement: { commonNormalCoordinate: at, textPosition: null },
      origin: 'manual', reference: false, layerId: 'layer-4' });
    const angle: Dimension = { ...size('dim-angle', 'length', [horizontal, diagonal], 40), kind: 'angle', measurement: 'angle', basic: true };
    document = { ...document, dimensions: [size('dim-journal', 'diameter', [journalCircle], 240), size('dim-other', 'diameter', [otherCircle], 255),
      size('dim-box', 'length', firstMedian.targets, 275), size('dim-datum-box', 'length', secondMedian.targets, 355), angle] };
    const datum = (id: string, label: string, feature: GdtFeature, position: readonly [number, number], sizeDimensionId?: string): DatumDefinition => ({
      id, label, feature, position, height: 3.5, layerId: 'layer-5', ...(sizeDimensionId === undefined ? {} : { sizeDimensionId }) });
    document = { ...document, datums: [datum('datum-a', 'A', { kind: 'surface', target: faceTarget(datumBox, plane(datumBox, 1, -10)) }, [35, 375]),
      datum('datum-b', 'B', journalAxis, [195, 240], 'dim-journal'), datum('datum-c', 'C', otherAxis, [195, 260], 'dim-other'),
      datum('datum-d', 'D', secondMedian, [195, 355], 'dim-datum-box'), datum('datum-e', 'E', { kind: 'line', target: horizontal }, [200, 170])] };
    const ref = (id: string) => ({ kind: 'single' as const, member: { datumId: `datum-${id}`, material: 'none' as const } });
    const cases: readonly [ToleranceCharacteristic, ToleranceZone, GdtFeature, string?, string?][] = [
      ['straightness', 'betweenLines', { kind: 'line', target: horizontal }], ['flatness', 'betweenPlanes', front],
      ['roundness', 'concentricCircles', cylinder], ['cylindricity', 'coaxialCylinders', cylinder],
      ['lineProfile', 'lineProfile', { kind: 'line', target: otherCircle }], ['surfaceProfile', 'surfaceProfile', front],
      ['parallelism', 'betweenPlanes', front, 'a'], ['perpendicularity', 'betweenPlanes', top, 'a'],
      ['angularity', 'betweenLines', { kind: 'line', target: diagonal }, 'e'], ['position', 'cylinder', otherAxis, 'b', 'dim-other'],
      ['coaxiality', 'cylinder', otherAxis, 'b', 'dim-other'], ['symmetry', 'betweenPlanes', firstMedian, 'd', 'dim-box'],
      ['circularRunout', 'radialRunout', cylinder, 'b'], ['totalRunout', 'radialRunout', cylinder, 'b'],
    ];
    const frames: GeometricToleranceFrame[] = cases.map(([characteristic, zone, feature, datumId, sizeDimensionId], index) => {
      const segment: GdtFrameSegment = { characteristic, zone, material: characteristic === 'position' ? 'maximum' : 'none',
        tolerance: { expression: number(0.05), unit: 'mm' }, datums: datumId === undefined ? [] : [ref(datumId)],
        basicDimensionIds: characteristic === 'angularity' ? ['dim-angle'] : [] };
      return { id: `gdt-${index + 1}`, feature, position: [300 + Math.floor(index / 7) * 135, 370 - index % 7 * 45], height: 3.5,
        layerId: 'layer-5', segments: [segment], ...(sizeDimensionId === undefined ? {} : { sizeDimensionId }) };
    });
    // 共通データムと優先順付きの欄は異なるAST。2つの同軸円筒を同じ欄にまとめる。
    const commonFrame = frames[7];
    frames[7] = { ...commonFrame, segments: [...commonFrame.segments, { ...commonFrame.segments[0],
      datums: [{ kind: 'common', members: [{ datumId: 'datum-b', material: 'none' }, { datumId: 'datum-c', material: 'none' }] }] }] };
    const kinds: readonly WeldKind[] = ['fillet', 'squareButt', 'vButt', 'bevelButt', 'uButt', 'jButt', 'spot', 'seam'];
    const weldSymbols: WeldSymbol[] = kinds.map((kind, index) => ({ id: `weld-${index + 1}`, system: 'B', target: front.target,
      sides: [{ kind, side: index >= 6 ? 'center' : 'arrow', contour: 'none', finish: 'none',
        ...(kind === 'fillet' || kind === 'spot' || kind === 'seam' ? { size: { kind: kind === 'fillet' ? 'leg' as const : kind === 'spot' ? 'diameter' as const : 'width' as const,
          value: { expression: number(5), unit: 'mm' as const } } } : {}) }], allAround: false, fieldWeld: false, tail: '',
      position: [75 + index % 4 * 52, 110 - Math.floor(index / 4) * 40], height: 3.5, layerId: 'layer-5' }));
    document = { ...document, gdtFrames: frames, weldSymbols };
    const coordinates = result.bodies.flatMap((solid) => Array.from(solid.mesh.positions));
    const bounds = [0, 1, 2].map((axis) => coordinates.filter((_, index) => index % 3 === axis));
    const modelCenter = bounds.map((values) => (Math.min(...values) + Math.max(...values)) / 2) as [number, number, number];
    const context = { modelCenter: modelCenter as Vector3, instances: result.bodies.map((solid) => ({ sourceRef,
      bodyId: solid.featureId, body: solid, placement: IDENTITY_PLACEMENT })) };
    const gdt = resolveDrawingGdt(document, context), welds = resolveDrawingWelds(document, context);
    if (gdt.unresolvedCount !== 0 || welds.some((item) => item.issues.length > 0)) throw new Error(JSON.stringify({
      gdt: [...gdt.datums, ...gdt.frames].flatMap((item) => item.issues), weld: welds.flatMap((item) => item.issues) }));
    const bytes = writePcaddFile(document, { source, savedAt: '2026-09-10T00:00:00.000Z' });
    const saved = readPcaddFile(bytes); if (!saved.ok) throw new Error(saved.error.message);
    return { bytes, document: saved.document };
  } finally { await api.releasePart(partId); }
}
