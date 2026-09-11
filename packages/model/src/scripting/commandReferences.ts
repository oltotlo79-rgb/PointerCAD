/** Validate the whole dependency order before constructing any candidate document. */
import { SCRIPT_LIMITS, type ScriptCommand } from './scriptTypes.js';

export type ScriptReferenceKind = 'sketch' | 'point' | 'edge' | 'face' | 'solid';
export interface ScriptReference {
  readonly kind: ScriptReferenceKind;
  /** Actual owner sketch, or null for a document-level solid/sketch. */
  readonly sketch: string | null;
}
export type ScriptReferenceOutcome = { readonly ok: true }
  | { readonly ok: false; readonly commandIndex: number; readonly reference: string; readonly reason: 'count' | 'duplicate' | 'order' | 'kind' | 'owner' };

export function validateScriptReferences(commands: readonly ScriptCommand[], existing: ReadonlyMap<string, ScriptReference>, executionId: string): ScriptReferenceOutcome {
  if (commands.length > SCRIPT_LIMITS.commands) return { ok: false, commandIndex: SCRIPT_LIMITS.commands, reference: '', reason: 'count' };
  const known = new Map(existing);
  let serial = 0;
  for (const [commandIndex, command] of commands.entries()) {
    if (command.resultId !== null) {
      serial++;
      if (known.has(command.resultId)) return { ok: false, commandIndex, reference: command.resultId, reason: 'duplicate' };
      if (command.resultId !== `${executionId}:${serial}`) return { ok: false, commandIndex, reference: command.resultId, reason: 'order' };
    }
    const needs: { id: string; kind: ScriptReferenceKind; sketch?: string }[] = [];
    let result: ScriptReference | null = null;
    switch (command.kind) {
      case 'parameter.set': break;
      case 'sketch.create': result = { kind: 'sketch', sketch: null }; break;
      case 'sketch.point':
        needs.push({ id: command.fields.sketch, kind: 'sketch' });
        result = { kind: 'point', sketch: command.fields.sketch }; break;
      case 'sketch.line':
        needs.push({ id: command.fields.sketch, kind: 'sketch' },
          { id: command.fields.start, kind: 'point', sketch: command.fields.sketch },
          { id: command.fields.end, kind: 'point', sketch: command.fields.sketch });
        result = { kind: 'edge', sketch: command.fields.sketch }; break;
      case 'sketch.face':
        needs.push({ id: command.fields.sketch, kind: 'sketch' });
        for (const edge of command.fields.edges) needs.push({ id: edge, kind: 'edge', sketch: command.fields.sketch });
        result = { kind: 'face', sketch: command.fields.sketch }; break;
      case 'solid.extrude':
        needs.push({ id: command.fields.face, kind: 'face' });
        result = { kind: 'solid', sketch: null }; break;
      case 'solid.hole':
        needs.push({ id: command.fields.target, kind: 'solid' });
        result = { kind: 'solid', sketch: null }; break;
      case 'solid.box': case 'solid.sphere': case 'solid.cylinder': case 'solid.cone': case 'solid.torus':
        result = { kind: 'solid', sketch: null }; break;
    }
    for (const needed of needs) {
      const found = known.get(needed.id);
      if (!found) return { ok: false, commandIndex, reference: needed.id, reason: 'order' };
      if (found.kind !== needed.kind) return { ok: false, commandIndex, reference: needed.id, reason: 'kind' };
      if (needed.sketch !== undefined && found.sketch !== needed.sketch) return { ok: false, commandIndex, reference: needed.id, reason: 'owner' };
    }
    if (result && command.resultId !== null) known.set(command.resultId, result);
  }
  return { ok: true };
}
