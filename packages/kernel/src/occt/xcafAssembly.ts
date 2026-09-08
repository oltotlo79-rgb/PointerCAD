/**
 * XCAF の共有部品定義と配置木を STEP へ書く(P7 タスク41、FR-804)。
 *
 * 同じ部品は `definitions` に 1 回だけ置き、`children` はそのラベルへの参照だけを持つ。
 * 50 個の同一部品でも B-rep は 1 個で、増えるのは `AddComponent_1` の配置参照だけである。
 * 入れ子は子アセンブリ用の `NewShape()` を作ってから親へ参照として足す。
 */
import type { OpenCascadeInstance, TDF_Label } from 'opencascade.js/dist/opencascade.full.js';

import type { ShapeAssemblyNode } from '../types.js';
import type { Allocations } from './allocations.js';
import type { OcctShapeHandle } from './makeBox.js';
import { makeCompound } from './transformShape.js';
import type { StepWriteOptions, StepWriteResult } from './writeStep.js';
import { writeXcafStepDocument } from './writeStep.js';
import type { XcafShapeEntry } from './xcafDocument.js';
import { createXcafDocumentBuilder } from './xcafDocument.js';
import {
  normalizeStepAssemblyMetadata,
  stepAssemblyOccurrenceName,
  type StepAssemblyOccurrenceName,
} from './stepAssemblyMetadata.js';

export const ASSEMBLY_NO_SHAPE_MESSAGE = '書き出せる部品がありません。';
export const ASSEMBLY_DUPLICATE_DEFINITION_MESSAGE = '部品定義の id が重複しています。';
export const ASSEMBLY_DUPLICATE_NODE_MESSAGE = '配置の id が重複しています。';
export const ASSEMBLY_MISSING_DEFINITION_MESSAGE = '配置が参照する部品定義が見つかりません。';
export const ASSEMBLY_EMPTY_DEFINITION_MESSAGE = '形を持たない部品定義は書き出せません。';
export const ASSEMBLY_EMPTY_NODE_MESSAGE = '空のサブアセンブリは書き出せません。';
/** OCCT の形を持つ、製品内の部品定義 1 つ。 */
export interface XcafAssemblyDefinition {
  readonly id: string;
  readonly name: string | null;
  readonly bodies: readonly XcafShapeEntry[];
}

/** XCAF 文書へ渡すアセンブリ全体。 */
export interface XcafAssemblySpec {
  readonly name: string | null;
  readonly definitions: readonly XcafAssemblyDefinition[];
  readonly children: readonly ShapeAssemblyNode[];
}

/** 書き出し時の細かい指定。確保の控えは所有権検査からだけ渡す。 */
export interface XcafAssemblyWriteOptions extends StepWriteOptions {
  readonly allocations?: Allocations;
}

interface ValidatedAssembly {
  readonly definitions: ReadonlyMap<string, XcafAssemblyDefinition>;
}

/** 形へ触れる前に、参照と id の不整合をすべて断る。 */
function validateAssembly(spec: XcafAssemblySpec): ValidatedAssembly {
  if (spec.children.length === 0) {
    throw new Error(ASSEMBLY_NO_SHAPE_MESSAGE);
  }
  const definitions = new Map<string, XcafAssemblyDefinition>();
  for (const definition of spec.definitions) {
    if (definitions.has(definition.id)) {
      throw new Error(ASSEMBLY_DUPLICATE_DEFINITION_MESSAGE);
    }
    if (definition.bodies.length === 0) {
      throw new Error(ASSEMBLY_EMPTY_DEFINITION_MESSAGE);
    }
    definitions.set(definition.id, definition);
  }
  const nodeIds = new Set<string>();
  const visit = (node: ShapeAssemblyNode): void => {
    if (nodeIds.has(node.id)) {
      throw new Error(ASSEMBLY_DUPLICATE_NODE_MESSAGE);
    }
    nodeIds.add(node.id);
    if (node.kind === 'part') {
      if (!definitions.has(node.definitionId)) {
        throw new Error(ASSEMBLY_MISSING_DEFINITION_MESSAGE);
      }
      return;
    }
    if (node.children.length === 0) {
      throw new Error(ASSEMBLY_EMPTY_NODE_MESSAGE);
    }
    node.children.forEach(visit);
  };
  spec.children.forEach(visit);
  return { definitions };
}

/**
 * 共有部品定義と配置木を STEP のバイト列へする。
 * `bodies` の形は借り物で、この関数は compound wrapper と XCAF の持ち物だけを返す。
 */
export function writeStepAssembly(
  oc: OpenCascadeInstance,
  spec: XcafAssemblySpec,
  options: XcafAssemblyWriteOptions = {},
): StepWriteResult {
  const validated = validateAssembly(spec);
  const builder = createXcafDocumentBuilder(oc, {
    withColors: options.withColors,
    allocations: options.allocations,
  });
  const compounds: OcctShapeHandle[] = [];
  const occurrences: StepAssemblyOccurrenceName[] = [];
  try {
    const labels = new Map<string, TDF_Label>();
    for (const definition of validated.definitions.values()) {
      const [only] = definition.bodies;
      if (definition.bodies.length === 1 && only !== undefined) {
        // 単一形状は XCAF に分解させず、共有定義を 1 つだけ登録する。
        labels.set(definition.id, builder.addShape({ ...only, name: definition.name }, false, false));
        continue;
      }
      const compound = makeCompound(oc, definition.bodies.map((body) => body.shape));
      compounds.push(compound);
      labels.set(definition.id, builder.addShape({
        shape: compound.shape,
        name: definition.name,
        color: null,
      }, false, true));
      // AddShape(..., makePrepare=true) が登録した compound の部分形状へ色を載せる。
      definition.bodies.forEach((body) => builder.applyAppearance(body));
    }

    const root = builder.addAssembly(spec.name);
    const occurrenceName = (name: string | null): string => {
      const occurrence = stepAssemblyOccurrenceName(occurrences.length + 1, name);
      occurrences.push(occurrence);
      return occurrence.token;
    };
    const addNode = (parent: TDF_Label, node: ShapeAssemblyNode): void => {
      if (node.kind === 'part') {
        const definition = labels.get(node.definitionId);
        if (definition === undefined) {
          // validateAssembly 後なので通常は通らない。Map の書き換えを黙って欠落させない。
          throw new Error(ASSEMBLY_MISSING_DEFINITION_MESSAGE);
        }
        builder.addComponent(parent, definition, occurrenceName(node.name), node.placement);
        return;
      }
      const nested = builder.addAssembly(node.name);
      node.children.forEach((child) => addNode(nested, child));
      builder.addComponent(parent, nested, occurrenceName(node.name), node.placement);
    };
    spec.children.forEach((node) => addNode(root, node));
    builder.updateAssemblies();
    const written = writeXcafStepDocument(oc, builder, { withColors: options.withColors });
    return {
      ...written,
      bytes: normalizeStepAssemblyMetadata(written.bytes, occurrences),
    };
  } finally {
    // 文書が compound を参照している間は元の形を返さない。文書を先に閉じた後、
    // 複数ボディ用にこの関数が作った wrapper を逆順に返す。
    try {
      builder.delete();
    } finally {
      for (let index = compounds.length - 1; index >= 0; index -= 1) {
        compounds[index]?.delete();
      }
    }
  }
}
