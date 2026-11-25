import { MAX_SUB_ASSEMBLY_DEPTH, type AssemblyDocument, type PartLibrary } from '@pointercad/model';

/** Counts saved occurrences, including hidden and suppressed branches. */
export function sharedPartOccurrenceCount(
  assembly: AssemblyDocument, library: PartLibrary, partRef: string,
): { readonly count: number; readonly complete: boolean } {
  interface Count { readonly count: number; readonly complete: boolean }
  const memo = new Map<string, Count>();
  const visit = (document: AssemblyDocument, ancestors: ReadonlySet<string>, depth: number): Count => {
    let count = 0;
    let complete = true;
    const add = (value: number): void => {
      if (value > Number.MAX_SAFE_INTEGER - count) {
        count = Number.MAX_SAFE_INTEGER;
        complete = false;
      } else count += value;
    };
    for (const component of document.components) {
      if (component.source.kind === 'part') {
        if (component.source.partRef === partRef) add(1);
      } else if (component.source.kind === 'subAssembly') {
        const ref = component.source.assemblyRef;
        const nested = library.assemblies?.get(ref);
        if (nested === undefined || ancestors.has(ref) || depth + 1 > MAX_SUB_ASSEMBLY_DEPTH) {
          complete = false;
          continue;
        }
        const nextAncestors = new Set([...ancestors, ref]);
        const key = JSON.stringify([ref, depth + 1, [...nextAncestors].sort()]);
        let result = memo.get(key);
        if (result === undefined) {
          result = visit(nested, nextAncestors, depth + 1);
          memo.set(key, result);
        }
        add(result.count);
        complete = complete && result.complete;
      }
    }
    return { count, complete };
  };
  return visit(assembly, new Set(), 0);
}
