import type { OpenCascadeInstance, TDF_Label, TopoDS_Shape, TopTools_IndexedMapOfShape } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations } from './allocations.js';
import { hasIgesBindings, IGES_UNAVAILABLE } from './igesBindings.js';
import { readStepLabelName, STEP_NO_SHAPE_MESSAGE, STEP_READ_FAILED_MESSAGE, type StepFileLengthUnit } from './readStep.js';
import { shapeBodyKind } from './shapeBodyKind.js';
import { withVirtualFileInput } from './virtualFile.js';
import { createXcafDocumentTools, readXcafBodyColor, type RgbTuple } from './xcafDocument.js';
import type { FaceColorMap } from './xcafFaceColors.js';

interface IgesBody {
  readonly shape: TopoDS_Shape;
  readonly name: string | null;
  readonly color: RgbTuple | null;
  readonly faceColors: FaceColorMap;
  readonly kind: ReturnType<typeof shapeBodyKind>;
}

interface IgesReadResult {
  readonly bodies: readonly IgesBody[];
  readonly unit: StepFileLengthUnit;
  readonly unitNames: readonly string[];
  delete(): void;
}

type XcafTools = ReturnType<typeof createXcafDocumentTools>;

function readFaceColors(
  oc: OpenCascadeInstance, tools: XcafTools, root: TDF_Label, faces: TopTools_IndexedMapOfShape,
): FaceColorMap {
  const colors = new Map<number, RgbTuple>();
  const faceLabel = new oc.TDF_Label();
  try {
    for (let index = 1; index <= faces.Size(); index += 1) {
      const { keep, release } = createAllocations();
      try {
        const face = keep(faces.FindKey(index));
        if (!tools.shapeTool.FindSubShape(root, face, faceLabel)) continue;
        const color = readXcafBodyColor(oc, tools.colorTool, faceLabel, keep);
        if (color !== null) colors.set(index - 1, color);
      } finally { release(); }
    }
    return colors;
  } finally { faceLabel.delete(); }
}

function uniformFaceColor(faceColors: FaceColorMap, faceCount: number): RgbTuple | null {
  const first = faceColors.get(0);
  if (first === undefined || faceColors.size !== faceCount) return null;
  for (const color of faceColors.values()) {
    if (color[0] !== first[0] || color[1] !== first[1] || color[2] !== first[2]) return null;
  }
  return first;
}

function readBody(
  oc: OpenCascadeInstance, tools: XcafTools, label: TDF_Label, shape: TopoDS_Shape, withColors: boolean,
): IgesBody | null {
  if (shape.IsNull()) return null;
  const { keep, release } = createAllocations();
  try {
    const faces = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_1(shape, oc.TopAbs.ShapeTypeFromString_1('FACE'), faces);
    if (faces.Size() === 0) return null;

    const rootColor = withColors ? readXcafBodyColor(oc, tools.colorTool, label, keep) : null;
    const faceColors = withColors ? readFaceColors(oc, tools, label, faces) : new Map<number, RgbTuple>();
    // For a trimmed-surface group OCCT can attach the inherited color to each
    // face and leave the free label uncolored. Partial or mixed colors stay on the faces.
    return {
      shape,
      name: readStepLabelName(oc, label, keep),
      color: rootColor ?? uniformFaceColor(faceColors, faces.Size()),
      faceColors,
      kind: shapeBodyKind(oc, shape),
    };
  } finally { release(); }
}

function fileUnit(flag: number, value: number, scale: number): StepFileLengthUnit {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(scale) || scale <= 0) {
    throw new Error(STEP_READ_FAILED_MESSAGE);
  }
  // OCCT transfers the geometry in millimeters. These fields describe the source only.
  if (flag === 1) return 'inch';
  if (flag === 2) return 'mm';
  return 'other';
}

export function readIges(oc: OpenCascadeInstance, bytes: Uint8Array, withColors = true): IgesReadResult {
  if (!hasIgesBindings(oc)) throw new Error(IGES_UNAVAILABLE);
  if (bytes.byteLength === 0) throw new Error(STEP_NO_SHAPE_MESSAGE);
  const { keep, release } = createAllocations();
  try {
    return withVirtualFileInput(oc, 'import.iges', bytes, path => {
      const tools = createXcafDocumentTools(oc, keep);
      const reader = keep(new oc.IGESCAFControl_Reader_1());
      const name = keep(new oc.TCollection_AsciiString_2(path));
      const progress = keep(new oc.Message_ProgressRange_1());
      reader.SetNameMode(true);
      reader.SetColorMode(withColors);
      reader.SetLayerMode(false);
      if (!reader.Perform_1(name, tools.handle, progress)) throw new Error(STEP_READ_FAILED_MESSAGE);

      const unit = fileUnit(reader.FileUnitFlag(), reader.FileUnitValue(), reader.FileScale());
      const labels = keep(new oc.TDF_LabelSequence_1());
      tools.shapeTool.GetFreeShapes(labels);
      const bodies: IgesBody[] = [];
      for (let index = 1; index <= labels.Length(); index += 1) {
        const label: TDF_Label = keep(labels.Value(index));
        const shape = keep(oc.XCAFDoc_ShapeTool.GetShape_2(label));
        const body = readBody(oc, tools, label, shape, withColors);
        if (body !== null) bodies.push(body);
      }
      if (bodies.length === 0) throw new Error(STEP_NO_SHAPE_MESSAGE);
      return { bodies, unit, unitNames: unit === 'other' ? [] : [unit], delete: release };
    });
  } catch (error) {
    release();
    throw error;
  }
}
