/** サブアセンブリの循環・深さを解決前に確かめる道具(FR-613)。 */
import {
  MAX_SUB_ASSEMBLY_DEPTH,
  SUB_ASSEMBLY_CYCLE_MESSAGE,
  SUB_ASSEMBLY_DEPTH_MESSAGE,
  resolveAssembly,
  type ResolveAssemblyOptions,
  type ResolvedAssembly,
} from './resolveAssembly.js';
import type { AssemblyDocument } from './types.js';

export type SubAssemblyProblem =
  | { readonly kind: 'cycle'; readonly message: string; readonly path: readonly string[] }
  | { readonly kind: 'depth'; readonly message: string; readonly path: readonly string[] };

/**
 * 参照の枝を文書順にたどり、最初の循環または深さ超過を返す。
 * 同じ非循環の組を別の場所へ置くことは許すため、訪問済みは枝ごとに持つ。
 */
export function detectSubAssemblyProblem(
  assembly: AssemblyDocument,
  documents: ReadonlyMap<string, AssemblyDocument>,
): SubAssemblyProblem | null {
  const visit = (
    current: AssemblyDocument,
    path: readonly string[],
  ): SubAssemblyProblem | null => {
    for (const component of current.components) {
      if (component.suppressed || component.source.kind !== 'subAssembly') continue;
      const ref = component.source.assemblyRef;
      const nextPath = [...path, ref];
      if (path.includes(ref)) {
        return { kind: 'cycle', message: SUB_ASSEMBLY_CYCLE_MESSAGE, path: nextPath };
      }
      if (nextPath.length > MAX_SUB_ASSEMBLY_DEPTH) {
        return { kind: 'depth', message: SUB_ASSEMBLY_DEPTH_MESSAGE, path: nextPath };
      }
      const nested = documents.get(ref);
      if (nested !== undefined) {
        const found = visit(nested, nextPath);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return visit(assembly, []);
}

/** 計画書の短い名前。循環があれば参照経路、無ければ null。 */
export function detectCycle(
  assembly: AssemblyDocument,
  documents: ReadonlyMap<string, AssemblyDocument>,
): readonly string[] | null {
  const problem = detectSubAssemblyProblem(assembly, documents);
  return problem?.kind === 'cycle' ? problem.path : null;
}

/**
 * サブアセンブリ用の公開入口。中の部品は親の配置と合成される一方、返した組そのものは
 * 外側の合致では 1 部品として扱われる。
 */
export function resolveSubAssembly(
  assembly: AssemblyDocument,
  depth = 0,
  options: ResolveAssemblyOptions = {},
): ResolvedAssembly {
  return resolveAssembly(assembly, { ...options, depth });
}
