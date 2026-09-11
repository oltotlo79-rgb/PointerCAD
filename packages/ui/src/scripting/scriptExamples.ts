import { SCRIPT_EXAMPLE_PROGRAMS, type ScriptExampleId } from '@pointercad/model/scripting';
import type { MessageKey } from '../i18n/t.js';
export interface ScriptExample { readonly id: ScriptExampleId; readonly label: MessageKey; readonly source: string }
const labels = { plate: 'script.example.plate', sketch: 'script.example.sketch', grid: 'script.example.grid', read: 'script.example.read' } satisfies Record<ScriptExampleId, MessageKey>;
export const SCRIPT_EXAMPLES: readonly ScriptExample[] = SCRIPT_EXAMPLE_PROGRAMS.map(program => ({ ...program, label: labels[program.id] }));
