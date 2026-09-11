import { createScriptFile, type ScriptFile, type ScriptIcon } from '@pointercad/model/scripting';

export interface ScriptDraft {
  readonly scriptId: string; readonly name: string; readonly icon: ScriptIcon; readonly source: string;
  readonly modules: readonly { readonly name: string; readonly source: string }[];
  readonly seed: string; readonly time: string;
}
export function draftFromScript(file: ScriptFile): ScriptDraft {
  return { scriptId: file.scriptId, name: file.name, icon: file.icon, source: file.program.source, modules: file.program.modules,
    seed: String(file.seed), time: new Date(file.timeMs).toISOString() };
}
export function newScriptDraft(): ScriptDraft {
  return { scriptId: crypto.randomUUID(), name: '', icon: 'code', source: '', modules: [], seed: '1', time: new Date().toISOString() };
}
export function fileFromDraft(draft: ScriptDraft) {
  const parsed = Date.parse(draft.time);
  const normalized = draft.time.endsWith('.000Z') ? draft.time : draft.time.replace(/(?<=:\d{2})Z$/u, '.000Z');
  const validTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(draft.time)
    && Number.isFinite(parsed) && new Date(parsed).toISOString() === normalized;
  return createScriptFile({ ...draft, seed: /^\d{1,10}$/.test(draft.seed) ? Number(draft.seed) : Number.NaN,
    // Explicit UTC prevents the same saved input changing with the computer's time zone.
    timeMs: validTime ? parsed : Number.NaN });
}
