/**
 * XCAF の STEP から共有部品定義と配置木を読む(P7 タスク42、FR-802 / FR-804)。
 *
 * `GetFreeShapes` → `GetComponents` → `GetReferredShape` / `GetLocation` の順でたどる。
 * 形は定義ラベルごとに 1 回だけ取り出し、複数の occurrence は同じ `definitionId` を指す。
 * P6 の平らな STEP は、自由形を恒等配置の部品として同じ結果へ畳む。
 */
import type {
  OpenCascadeInstance,
  TDF_Label,
  TopLoc_Location,
  TopoDS_Shape,
  XCAFDoc_ColorTool,
} from 'opencascade.js/dist/opencascade.full.js';

import type { PlacementSpec, ShapeAssemblyNode, SolidBodyKind } from '../types.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import {
  classifyStepUnit,
  prepareStepReadUnit,
  readStepLabelColor,
  readStepLabelName,
  readStepUnitNames,
  STEP_NO_SHAPE_MESSAGE,
  STEP_NO_SOLID_MESSAGE,
  STEP_READ_FAILED_MESSAGE,
  STEP_STORAGE_FORMAT,
  type StepFileLengthUnit,
  type StepReadOptions,
} from './readStep.js';
import { hasSolid } from './solidMesh.js';
import { withVirtualFileInput } from './virtualFile.js';
import type { RgbTuple } from './xcafDocument.js';
import { decodeStepAssemblyOccurrenceName } from './stepAssemblyMetadata.js';

export const STEP_ASSEMBLY_CYCLE_MESSAGE =
  'この STEP ファイルのアセンブリ参照が循環しているため、読み込めません。';
export const STEP_ASSEMBLY_COMPONENT_MESSAGE =
  'この STEP ファイルのアセンブリ構造を読み取れませんでした。';

/** 共有部品定義。shape の解放は結果の `delete()` がまとめて行う。 */
export interface StepAssemblyDefinition {
  readonly id: string;
  readonly name: string | null;
  readonly shape: TopoDS_Shape;
  readonly color: RgbTuple | null;
  readonly kind: SolidBodyKind;
}

/** 読み込んだ XCAF アセンブリ。 */
export interface StepAssemblyReadResult {
  readonly name: string | null;
  readonly definitions: readonly StepAssemblyDefinition[];
  readonly children: readonly ShapeAssemblyNode[];
  readonly unit: StepFileLengthUnit;
  readonly unitNames: readonly string[];
  delete(): void;
}

/** 行列から四元数へ直す。STEP の location は剛体変換なので尺度は持ち込まない。 */
function quaternionFromRotation(values: readonly number[]): readonly [number, number, number, number] {
  const m00 = values[0] ?? 1;
  const m01 = values[1] ?? 0;
  const m02 = values[2] ?? 0;
  const m10 = values[3] ?? 0;
  const m11 = values[4] ?? 1;
  const m12 = values[5] ?? 0;
  const m20 = values[6] ?? 0;
  const m21 = values[7] ?? 0;
  const m22 = values[8] ?? 1;
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const scale = Math.sqrt(trace + 1) * 2;
    w = scale / 4;
    x = (m21 - m12) / scale;
    y = (m02 - m20) / scale;
    z = (m10 - m01) / scale;
  } else if (m00 > m11 && m00 > m22) {
    const scale = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / scale;
    x = scale / 4;
    y = (m01 + m10) / scale;
    z = (m02 + m20) / scale;
  } else if (m11 > m22) {
    const scale = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / scale;
    x = (m01 + m10) / scale;
    y = scale / 4;
    z = (m12 + m21) / scale;
  } else {
    const scale = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / scale;
    x = (m02 + m20) / scale;
    y = (m12 + m21) / scale;
    z = scale / 4;
  }
  const length = Math.hypot(x, y, z, w);
  if (!Number.isFinite(length) || length === 0) {
    return [0, 0, 0, 1];
  }
  const sign = w < 0 ? -1 : 1;
  return [x * sign / length, y * sign / length, z * sign / length, w * sign / length];
}

/** TopLoc_Location を model へ依存しない配置の値へ写す。 */
export function placementFromStepLocation(
  location: TopLoc_Location,
  keep: Allocations['keep'],
): PlacementSpec {
  const transform = keep(location.Transformation());
  const rotation = [
    transform.Value(1, 1), transform.Value(1, 2), transform.Value(1, 3),
    transform.Value(2, 1), transform.Value(2, 2), transform.Value(2, 3),
    transform.Value(3, 1), transform.Value(3, 2), transform.Value(3, 3),
  ];
  return {
    position: [transform.Value(1, 4), transform.Value(2, 4), transform.Value(3, 4)],
    rotation: quaternionFromRotation(rotation),
  };
}

function containsLabel(labels: readonly TDF_Label[], candidate: TDF_Label): boolean {
  return labels.some((label) => label.IsEqual(candidate));
}

/** STEP のバイト列から定義と配置木を取り出す。 */
export function readStepAssembly(
  oc: OpenCascadeInstance,
  bytes: Uint8Array,
  options: StepReadOptions = {},
): StepAssemblyReadResult {
  const fileName = options.fileName ?? 'import.step';
  const withColors = options.withColors ?? true;
  prepareStepReadUnit(oc);

  return withVirtualFileInput(oc, fileName, bytes, (path) => {
    const { keep, release } = createAllocations();
    try {
      const format = keep(new oc.TCollection_ExtendedString_2(STEP_STORAGE_FORMAT, false));
      const doc = new oc.TDocStd_Document(format);
      const handle = keep(new oc.Handle_TDocStd_Document_2(doc));
      const reader = keep(new oc.STEPCAFControl_Reader_1());
      reader.SetColorMode(withColors);
      reader.SetNameMode(true);
      const range = keep(new oc.Message_ProgressRange_1());
      if (!reader.Perform_2(path, handle, range)) {
        throw new Error(STEP_READ_FAILED_MESSAGE);
      }
      const unitNames = readStepUnitNames(oc, reader, keep);
      const main = keep(doc.Main());
      const shapeTool = keep(oc.XCAFDoc_DocumentTool.ShapeTool(main)).get();
      const colorTool: XCAFDoc_ColorTool = keep(oc.XCAFDoc_DocumentTool.ColorTool(main)).get();
      const free = keep(new oc.TDF_LabelSequence_1());
      shapeTool.GetFreeShapes(free);
      if (Number(free.Length()) === 0) {
        throw new Error(STEP_NO_SHAPE_MESSAGE);
      }

      const definitions: StepAssemblyDefinition[] = [];
      const known: { readonly label: TDF_Label; readonly value: StepAssemblyDefinition }[] = [];
      let solidFound = false;
      const definitionOf = (label: TDF_Label): StepAssemblyDefinition => {
        const existing = known.find((entry) => entry.label.IsEqual(label));
        if (existing !== undefined) {
          return existing.value;
        }
        const shape = keep(oc.XCAFDoc_ShapeTool.GetShape_2(label));
        const solid = hasSolid(oc, shape);
        solidFound = solidFound || solid;
        const value: StepAssemblyDefinition = {
          id: `definition-${String(definitions.length + 1)}`,
          name: readStepLabelName(oc, label, keep),
          shape,
          color: withColors ? readStepLabelColor(oc, colorTool, label, keep) : null,
          kind: solid ? 'solid' : 'shell',
        };
        known.push({ label, value });
        definitions.push(value);
        return value;
      };

      const childrenOf = (
        assembly: TDF_Label,
        pathPrefix: string,
        ancestors: readonly TDF_Label[],
      ): ShapeAssemblyNode[] => {
        const labels = keep(new oc.TDF_LabelSequence_1());
        if (!oc.XCAFDoc_ShapeTool.GetComponents(assembly, labels, false)) {
          throw new Error(STEP_ASSEMBLY_COMPONENT_MESSAGE);
        }
        const children: ShapeAssemblyNode[] = [];
        for (let index = 1; index <= Number(labels.Length()); index += 1) {
          const occurrence = keep(labels.Value(index));
          const referred = keep(new oc.TDF_Label());
          if (!oc.XCAFDoc_ShapeTool.GetReferredShape(occurrence, referred)) {
            throw new Error(STEP_ASSEMBLY_COMPONENT_MESSAGE);
          }
          if (containsLabel(ancestors, referred)) {
            throw new Error(STEP_ASSEMBLY_CYCLE_MESSAGE);
          }
          const location = keep(oc.XCAFDoc_ShapeTool.GetLocation(occurrence));
          const id = `${pathPrefix}/${String(index)}`;
          const occurrenceName = decodeStepAssemblyOccurrenceName(
            readStepLabelName(oc, occurrence, keep),
          );
          if (oc.XCAFDoc_ShapeTool.IsAssembly(referred)) {
            const name = occurrenceName ?? readStepLabelName(oc, referred, keep);
            children.push({
              kind: 'assembly',
              id,
              name,
              placement: placementFromStepLocation(location, keep),
              children: childrenOf(referred, id, [...ancestors, referred]),
            });
          } else {
            const definition = definitionOf(referred);
            children.push({
              kind: 'part',
              id,
              name: occurrenceName ?? definition.name,
              definitionId: definition.id,
              placement: placementFromStepLocation(location, keep),
            });
          }
        }
        return children;
      };

      const children: ShapeAssemblyNode[] = [];
      const rootNames: (string | null)[] = [];
      for (let index = 1; index <= Number(free.Length()); index += 1) {
        const label = keep(free.Value(index));
        const rootName = readStepLabelName(oc, label, keep);
        rootNames.push(rootName);
        if (oc.XCAFDoc_ShapeTool.IsAssembly(label)) {
          children.push(...childrenOf(label, `root:${String(index)}`, [label]));
        } else {
          const definition = definitionOf(label);
          const location = keep(oc.XCAFDoc_ShapeTool.GetLocation(label));
          children.push({
            kind: 'part',
            id: `root:${String(index)}`,
            name: rootName,
            definitionId: definition.id,
            placement: placementFromStepLocation(location, keep),
          });
        }
      }
      if (!solidFound) {
        throw new Error(STEP_NO_SOLID_MESSAGE);
      }
      return {
        name: rootNames.length === 1 ? rootNames[0] ?? null : null,
        definitions,
        children,
        unit: classifyStepUnit(unitNames),
        unitNames,
        delete: release,
      };
    } catch (error) {
      release();
      throw error;
    }
  });
}
