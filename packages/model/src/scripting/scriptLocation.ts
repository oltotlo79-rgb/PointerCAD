import type { ScriptLocation } from './scriptTypes.js';

/** Accept only caller source names supplied by the host; private bootstrap frames are excluded. */
export function locateScriptError(stack: string, sources: ReadonlyMap<string, string>): ScriptLocation | null {
  const frames = stack.slice(0, 16384).split('\n');
  for (const frame of frames) {
    // QuickJS stack frames end in filename:line[:column], optionally enclosed in ().
    const match = /(?:\(|\s)([^\s():]+\.js):(\d+)(?::(\d+))?\)?\s*$/.exec(frame);
    if (!match) continue;
    const source = sources.get(match[1]);
    if (source === undefined) continue;
    const line = Number(match[2]), column = match[3] === undefined ? null : Number(match[3]);
    const lines = source.split('\n');
    if (!Number.isSafeInteger(line) || line < 1 || line > lines.length) continue;
    if (column !== null && (!Number.isSafeInteger(column) || column < 1 || column > lines[line - 1].length + 1)) continue;
    return { file: match[1], line, column };
  }
  return null;
}
