import type { PartDocument } from '../part/types.js';
import type { LengthUnit } from '../units/length.js';
import { scriptUtf8Bytes } from './scriptBytes.js';
import type { ScriptModelReference } from './scriptCommandContext.js';
import { SCRIPT_LIMITS } from './scriptTypes.js';

export interface ScriptSnapshot {
  readonly json: string;
  readonly references: ReadonlyMap<string, ScriptModelReference>;
}
/** Aliases include document generation; point-1 may belong to many different sketches. */
export function createScriptSnapshot(document: PartDocument, namespace: string, lengthUnit: LengthUnit): ScriptSnapshot {
  const references = new Map<string, ScriptModelReference>();
  const alias = (reference: ScriptModelReference): string => {
    const id = `existing:${namespace}:${references.size + 1}`; references.set(id, reference); return id;
  };
  const sketches = document.sketches.map((sketch) => {
    const id = alias({ kind: 'sketch', sketchId: sketch.id, featureId: sketch.id, planeId: sketch.features[0]?.planeId ?? 'xy' });
    const elements = sketch.features.flatMap((feature) => {
      const kind = feature.kind === 'point' ? 'point' : feature.kind === 'line' ? 'edge' : feature.kind === 'face' ? 'face' : null;
      if (kind === null) return [];
      return [{ id: alias({ kind, sketchId: sketch.id, featureId: feature.id, planeId: feature.planeId }), kind, name: feature.name }];
    });
    return { id, name: sketch.name, elements };
  });
  const solids = document.solids.map((solid) => ({ id: alias({ kind: 'solid', sketchId: null, featureId: solid.id, planeId: 'xy' }),
    name: solid.name, kind: solid.kind, suppressed: solid.suppressed }));
  const json = JSON.stringify({ name: document.name, lengthUnit, parameters: document.parameters.map((parameter) => ({
    name: parameter.name, source: parameter.value.source, unit: parameter.unit, description: parameter.description,
  })), sketches, solids });
  if (scriptUtf8Bytes(json, SCRIPT_LIMITS.commandBytes) === null) throw new Error('この文書は処理へ渡せる大きさを超えています。');
  return { json, references };
}
