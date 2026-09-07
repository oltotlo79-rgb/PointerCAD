/**
 * P7 タスク51: 固定 WASM の XCAF 階層を実証する専用の口。公開 index へは載せない。
 *
 * 所有権の表 (rules/06 10.13・10.16):
 * | 分類 | 対象 | 解放 |
 * | ① new の単独所有 | 文字列、ラベル列、ラベル、builder、変換、Location、reader/writer、GProps、境界箱、名前属性 | keep → release の逆順 |
 * | ② Handle へ所有移譲 | new TDocStd_Document → Handle_TDocStd_Document_2 | Handle だけ keep。本体は delete しない |
 * | ③ 借用 get() | Handle_XCAFDoc_ShapeTool.get() | keep も delete もしない。Handle は keep |
 * | ④ TopoDS wrapper のコピー | maker.Shape()、copy.Shape()、GetShape_2、Moved | 各 wrapper を keep。共有 TShape は参照数で管理 |
 *
 * fixture はこの実証で新規作成し、AddShape へ渡す前に BRepBuilderAPI_Copy_2 で
 * 幾何を複製する。キャッシュ上の形は受け取らない。戻り値は JS の文字列・数値だけ。
 * ラベル・GetLocation・Transformation・GetID・Get・境界箱の角の戻りもコピーとして
 * keep する。TDataStd_Name.Set_1 と ShapeTool の戻りは Handle だけを keep する。
 *
 * 固定版 2.0.0-beta.b5ff984 で実測 (2026-09-07): 4葉/5参照/2部品定義が往復する。
 * 3回とも書き61/61・読み142/142の確保/解放、解放例外0。空rootは書けるが
 * 読み戻しで IsAssembly=false になるため明示して拒否する。製品の後退処理は作らない。
 */
import type {
  OpenCascadeInstance,
  TDF_Label,
  TopLoc_Location,
  TopoDS_Shape,
} from 'opencascade.js/dist/opencascade.full.js';

import type { PlacementSpec, Vec3Tuple } from '../types.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import { makePlacementTransform } from './placeBodies.js';
import { withVirtualFile, withVirtualFileInput } from './virtualFile.js';

export type AssemblyProbeFixture = 'single' | 'nested' | 'empty';

export interface ProbeMeasurement {
  readonly volume: number;
  readonly center: Vec3Tuple;
  readonly min: Vec3Tuple;
  readonly max: Vec3Tuple;
}

export interface ProbeDefinition {
  readonly id: string;
  readonly name: string | null;
  readonly measurement: ProbeMeasurement;
}

export interface ProbeOccurrence {
  readonly id: string;
  /** null は root の直下。名前は識別子に使わない。 */
  readonly parent: string | null;
  /** 部品定義への鍵。assembly 自身は部品として数えず null。 */
  readonly definition: string | null;
  readonly definitionName: string | null;
  readonly name: string | null;
  readonly assembly: boolean;
  /** 行優先の 3×4 剛体変換 (mm)。 */
  readonly location: readonly number[];
  readonly worldLocation: readonly number[];
  readonly measurement: ProbeMeasurement | null;
}

export interface AssemblyProbeReadResult {
  readonly roots: readonly string[];
  readonly definitions: readonly ProbeDefinition[];
  readonly occurrences: readonly ProbeOccurrence[];
}

function nameLabel(
  oc: OpenCascadeInstance,
  label: TDF_Label,
  name: string,
  keep: Allocations['keep'],
): void {
  const text = keep(new oc.TCollection_ExtendedString_2(name, true));
  keep(oc.TDataStd_Name.Set_1(label, text));
}

/** A は 10×20×40、B は 6×8×12。寸法・配置の単位は mm / rad。 */
export function writeAssemblyProbe(
  oc: OpenCascadeInstance,
  fixture: AssemblyProbeFixture,
  allocations: Allocations = createAllocations(),
): string {
  const { keep, release } = allocations;
  try {
    const format = keep(new oc.TCollection_ExtendedString_2('BinXCAF', false));
    const doc = new oc.TDocStd_Document(format);
    // Handle の構築に失敗した場合だけ、移譲前の本体を自分で解放する。
    const handle = (() => {
      try {
        return new oc.Handle_TDocStd_Document_2(doc);
      } catch (error) {
        doc.delete();
        throw error;
      }
    })();
    keep(handle);
    const main = keep(doc.Main());
    const shapeTool = keep(oc.XCAFDoc_DocumentTool.ShapeTool(main)).get();
    const root = keep(shapeTool.NewShape());
    nameLabel(oc, root, 'Root', keep);

    function definition(name: string, dx: number, dy: number, dz: number): TDF_Label {
      const maker = keep(new oc.BRepPrimAPI_MakeBox_2(dx, dy, dz));
      const source = keep(maker.Shape());
      const copier = keep(new oc.BRepBuilderAPI_Copy_2(source, true, false));
      const shape = keep(copier.Shape());
      const label = keep(shapeTool.AddShape(shape, false, false));
      nameLabel(oc, label, name, keep);
      return label;
    }

    function occurrence(
      parent: TDF_Label,
      part: TDF_Label,
      name: string,
      placement: PlacementSpec,
    ): void {
      const trsf = makePlacementTransform(oc, placement, keep);
      const location = keep(new oc.TopLoc_Location_2(trsf));
      const label = keep(shapeTool.AddComponent_1(parent, part, location));
      nameLabel(oc, label, name, keep);
    }

    if (fixture !== 'empty') {
      const a = definition('Part A', 10, 20, 40);
      occurrence(root, a, 'A1', { position: [3, -7, 11], rotation: [0, 0, 0, 1] });
      if (fixture === 'nested') {
        occurrence(root, a, 'A2', {
          position: [100, 0, 0],
          rotation: [0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)],
        });
        const b = definition('Part B', 6, 8, 12);
        occurrence(root, b, 'B1', { position: [-30, 4, 9], rotation: [0, 0, 0, 1] });
        const child = keep(shapeTool.NewShape());
        nameLabel(oc, child, 'Child definition', keep);
        occurrence(child, a, 'A3', {
          position: [7, 11, 13],
          rotation: [0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)],
        });
        occurrence(root, child, 'Child1', {
          position: [0, 50, 0],
          rotation: [Math.sin(Math.PI / 12), 0, 0, Math.cos(Math.PI / 12)],
        });
      }
    }
    shapeTool.UpdateAssemblies();
    const writer = keep(new oc.STEPCAFControl_Writer_1());
    writer.SetNameMode(true);
    const range = keep(new oc.Message_ProgressRange_1());
    const files = withVirtualFile(oc, 'step', (path) => {
      if (!writer.Perform_2(handle, path, range)) {
        throw new Error('Assembly probe: STEPCAFControl_Writer.Perform_2 returned false');
      }
    });
    return new TextDecoder().decode(files[0].bytes);
  } finally {
    release();
  }
}

function readName(
  oc: OpenCascadeInstance,
  label: TDF_Label,
  keep: Allocations['keep'],
): string | null {
  const attribute = keep(new oc.Handle_TDF_Attribute_1());
  const guid = keep(oc.TDataStd_Name.GetID());
  if (!label.FindAttribute_1(guid, attribute)) {
    return null;
  }
  // readStep.ts と同じく基底属性の Handle で受け、Restore で名前属性へ写す。
  const holder = keep(new oc.TDataStd_Name());
  holder.Restore(attribute);
  const extended = keep(holder.Get());
  const ascii = keep(new oc.TCollection_AsciiString_13(extended, 0));
  const raw = ascii.ToCString();
  return new TextDecoder().decode(Uint8Array.from(raw, (char) => char.charCodeAt(0)));
}

function matrix(location: TopLoc_Location, keep: Allocations['keep']): readonly number[] {
  // Transformation() の戻りも embind のコピー。get() の借用とは区別して返す。
  const trsf = keep(location.Transformation());
  const values: number[] = [];
  for (let row = 1; row <= 3; row += 1) {
    for (let column = 1; column <= 4; column += 1) {
      values.push(trsf.Value(row, column));
    }
  }
  return values;
}

function measure(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  keep: Allocations['keep'],
): ProbeMeasurement {
  const props = keep(new oc.GProp_GProps_1());
  oc.BRepGProp.VolumeProperties_1(shape, props, true, false, false);
  const center = keep(props.CentreOfMass());
  const box = keep(new oc.Bnd_Box_1());
  oc.BRepBndLib.Add(shape, box, false);
  if (box.IsVoid()) {
    throw new Error('Assembly probe: empty definition');
  }
  box.SetGap(0);
  const low = keep(box.CornerMin());
  const high = keep(box.CornerMax());
  return {
    volume: props.Mass(),
    center: [center.X(), center.Y(), center.Z()],
    min: [low.X(), low.Y(), low.Z()],
    max: [high.X(), high.Y(), high.Z()],
  };
}

/**
 * 階層の実測結果だけを返す。形は持ち帰らないため、成功時も全 wrapper をここで返す。
 * GetComponents は definition 上で直接の子だけ(false)、GetLocation は occurrence 上で
 * 読む。GetShape_2(occurrence) は配置済みなので使わず、definition の形へ世界配置を1回掛ける。
 */
export function readAssemblyProbe(
  oc: OpenCascadeInstance,
  text: string,
  allocations: Allocations = createAllocations(),
): AssemblyProbeReadResult {
  const { keep, release } = allocations;
  try {
    const format = keep(new oc.TCollection_ExtendedString_2('BinXCAF', false));
    const doc = new oc.TDocStd_Document(format);
    const handle = (() => {
      try {
        return new oc.Handle_TDocStd_Document_2(doc);
      } catch (error) {
        doc.delete();
        throw error;
      }
    })();
    keep(handle);
    const reader = keep(new oc.STEPCAFControl_Reader_1());
    reader.SetNameMode(true);
    const range = keep(new oc.Message_ProgressRange_1());
    const ok = withVirtualFileInput(
      oc,
      'assembly-probe.step',
      new TextEncoder().encode(text),
      (path) => reader.Perform_2(path, handle, range),
    );
    if (!ok) {
      throw new Error('Assembly probe: STEPCAFControl_Reader.Perform_2 returned false');
    }
    const main = keep(doc.Main());
    const shapeTool = keep(oc.XCAFDoc_DocumentTool.ShapeTool(main)).get();
    const free = keep(new oc.TDF_LabelSequence_1());
    shapeTool.GetFreeShapes(free);
    const roots: string[] = [];
    const definitions: ProbeDefinition[] = [];
    const occurrences: ProbeOccurrence[] = [];
    const knownParts: {
      readonly label: TDF_Label;
      readonly shape: TopoDS_Shape;
      readonly value: ProbeDefinition;
    }[] = [];

    function part(label: TDF_Label): typeof knownParts[number] {
      const existing = knownParts.find((entry) => entry.label.IsEqual(label));
      if (existing !== undefined) {
        return existing;
      }
      const shape = keep(oc.XCAFDoc_ShapeTool.GetShape_2(label));
      const value: ProbeDefinition = {
        id: `part:${String(definitions.length + 1)}`,
        name: readName(oc, label, keep),
        measurement: measure(oc, shape, keep),
      };
      const entry = { label, shape, value };
      knownParts.push(entry);
      definitions.push(value);
      return entry;
    }

    function children(
      label: TDF_Label,
      parent: string | null,
      path: string,
      parentWorld: TopLoc_Location,
      ancestors: readonly TDF_Label[],
    ): void {
      if (ancestors.some((ancestor) => ancestor.IsEqual(label))) {
        throw new Error('Assembly probe: cyclic assembly reference');
      }
      const labels = keep(new oc.TDF_LabelSequence_1());
      if (!oc.XCAFDoc_ShapeTool.GetComponents(label, labels, false)) {
        throw new Error('Assembly probe: GetComponents returned false for assembly');
      }
      for (let index = 1; index <= Number(labels.Length()); index += 1) {
        const occurrence = keep(labels.Value(index));
        // out 引数は独立したラベル wrapper。参照先の同一性は IsEqual で照合する。
        const referred = keep(new oc.TDF_Label());
        if (!oc.XCAFDoc_ShapeTool.GetReferredShape(occurrence, referred)) {
          throw new Error('Assembly probe: GetReferredShape returned false for occurrence');
        }
        const local = keep(oc.XCAFDoc_ShapeTool.GetLocation(occurrence));
        const world = keep(parentWorld.Multiplied(local));
        const id = `${path}/${String(index)}`;
        const assembly = oc.XCAFDoc_ShapeTool.IsAssembly(referred);
        const leaf = assembly ? null : part(referred);
        occurrences.push({
          id,
          parent,
          assembly,
          definition: leaf?.value.id ?? null,
          definitionName: readName(oc, referred, keep),
          name: readName(oc, occurrence, keep),
          location: matrix(local, keep),
          worldLocation: matrix(world, keep),
          measurement: leaf === null
            ? null
            : measure(oc, keep(leaf.shape.Moved(world, true)), keep),
        });
        if (assembly) {
          children(referred, id, id, world, [...ancestors, label]);
        }
      }
    }

    for (let index = 1; index <= Number(free.Length()); index += 1) {
      const label = keep(free.Value(index));
      roots.push(readName(oc, label, keep) ?? '');
      if (!oc.XCAFDoc_ShapeTool.IsAssembly(label)) {
        throw new Error('Assembly probe: root is not an assembly');
      }
      children(
        label,
        null,
        `root:${String(index)}`,
        keep(oc.XCAFDoc_ShapeTool.GetLocation(label)),
        [],
      );
    }
    return { roots, definitions, occurrences };
  } finally {
    release();
  }
}
