import { resolveSketch, type SketchResolveOptions } from '../resolveSketch.js';
import type { ResolvedSketch, SketchDocument, SketchError } from '../types.js';
import { constraintTargets, sketchConstraints } from './types.js';
import { featureIdOfPointKey } from './variables.js';

/** A failed constraint invalidates its connected component, never an unrelated sketch component. */
export function expandInvalidConstraintInputs(document: SketchDocument, input: ReadonlyMap<string, string> | undefined):
  ReadonlyMap<string, string> | undefined {
  if (input === undefined || input.size === 0) return input;
  const connected = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    const neighbors = connected.get(a) ?? new Set<string>();
    neighbors.add(b); connected.set(a, neighbors);
  };
  for (const constraint of sketchConstraints(document)) {
    for (const target of constraintTargets(constraint)) {
      const id = target.kind === 'curve' ? target.element.featureId
        : target.kind === 'vertex' ? target.featureId : featureIdOfPointKey(target.pointId);
      link(constraint.id, id); link(id, constraint.id);
    }
  }
  const invalid = new Map(input), queue = [...input.keys()];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor], message = invalid.get(id);
    if (message === undefined) continue;
    for (const neighbor of connected.get(id) ?? []) {
      if (invalid.has(neighbor)) continue;
      invalid.set(neighbor, message); queue.push(neighbor);
    }
  }
  return invalid;
}

/**
 * Resolution also exposes geometric dependencies (relative points, curve copies, faces).
 * Close those failures together with constraint components before building any solver rows.
 * Every further pass adds a previously unseen owner; no retry of the same failed state.
 * The ordinary successful path still resolves exactly once.
 */
export function resolveInvalidConstraintInputs(document: SketchDocument, options: SketchResolveOptions): {
  readonly options: SketchResolveOptions;
  readonly base: ResolvedSketch;
} {
  if (options.invalidInputs === undefined || options.invalidInputs.size === 0) {
    return { options, base: resolveSketch(document, options) };
  }
  let invalid = options.invalidInputs;
  const originalErrors = new Map<string, SketchError>();
  for (;;) {
    const expanded = expandInvalidConstraintInputs(document, invalid);
    const checked = { ...options, invalidInputs: expanded };
    const base = resolveSketch(document, checked);
    const discovered = new Map(expanded);
    for (const error of base.errors) {
      if (!originalErrors.has(error.featureId)) originalErrors.set(error.featureId, error);
      if (!discovered.has(error.featureId)) discovered.set(error.featureId, error.message);
    }
    if (discovered.size === expanded?.size) {
      return { options: checked, base: { ...base,
        errors: base.errors.map(error => originalErrors.get(error.featureId) ?? error) } };
    }
    invalid = discovered;
  }
}
