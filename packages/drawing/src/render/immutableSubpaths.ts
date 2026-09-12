import type { RenderSubpath } from './types.js';

// Only font geometry built by this package is enrolled. Caller-owned paths remain uncached
// so their edits and invalid coordinates are checked on every SVG export.
const immutable = new WeakSet<readonly RenderSubpath[]>();
const serialized = new WeakMap<readonly RenderSubpath[], string | null>();

/** Freeze owned glyph coordinates before sharing the outline across labels and frames. */
export function freezeFontSubpaths(paths: readonly RenderSubpath[]): readonly RenderSubpath[] {
  for (const path of paths) {
    for (const command of path.commands) {
      if (command.kind !== 'Z') Object.freeze(command.to);
      if (command.kind === 'C') { Object.freeze(command.control1); Object.freeze(command.control2); }
      Object.freeze(command);
    }
    Object.freeze(path.commands); Object.freeze(path);
  }
  Object.freeze(paths); immutable.add(paths); return paths;
}

/** Weak ownership lets the bounded font cache release both geometry and its SVG text. */
export function immutablePathData(paths: readonly RenderSubpath[], serialize: (paths: readonly RenderSubpath[]) => string | null): string | null {
  if (!immutable.has(paths)) return serialize(paths);
  if (serialized.has(paths)) return serialized.get(paths) ?? null;
  const value = serialize(paths); serialized.set(paths, value); return value;
}
