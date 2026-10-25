import type { PartDocument } from '../../part/types.js';
import { steelFinishedLength } from './steelFinishedLength.js';
import type { AssemblyDocument } from '../types.js';
import { MAX_SUB_ASSEMBLY_DEPTH } from '../resolveAssembly.js';
import { hasSteelOptions, STEEL_CATALOG_REVISION, STEEL_GENERATOR_REVISION,
  steelLength, steelProductFromSource, type SteelProduct } from './steelCatalog.js';

export interface SteelStockRow {
  readonly key: string;
  readonly product: SteelProduct;
  /** The saved source revisions, so reports never parse the grouping key. */
  readonly catalogRevision: string;
  readonly generatorRevision: string;
  /** Original purchased length, retained for existing callers. */
  readonly lengthMm: number;
  /** Exact only for a complete generator-matching axial history; never a mesh bound. */
  readonly finishedLengthMm: number | null;
  readonly quantity: number;
  readonly totalLengthMm: number;
  readonly componentIds: readonly string[];
  /** Component ids at each level, as in BOM; ids containing '/' remain unambiguous. */
  readonly occurrencePaths: readonly (readonly string[])[];
}
export interface SteelStockList {
  readonly rows: readonly SteelStockRow[];
  readonly totalQuantity: number;
  readonly totalLengthMm: number;
  readonly unresolvedComponentIds: readonly string[];
  readonly unassignedSectionComponentIds: readonly string[];
  readonly subAssemblyComponentIds: readonly string[];
  readonly issues: readonly {
    readonly reason: 'unknownSteel' | 'unassignedMaterial' | 'missingAssembly' | 'cycle' | 'depthLimit';
    readonly occurrencePath: readonly string[];
    readonly occurrenceNames: readonly string[];
    readonly assemblyRef?: string;
  }[];
}

/** Expand each occurrence using the same flat library and branch/depth contract as resolveAssembly.
 * Hidden parts count; suppressed parts and their descendants do not. No material is inferred.
 */
export function buildSteelStockList(assembly: AssemblyDocument,
  subAssemblies: ReadonlyMap<string, AssemblyDocument> = new Map(),
  parts: ReadonlyMap<string, PartDocument> = new Map()): SteelStockList {
  const groups = new Map<string, SteelStockRow>();
  const unresolvedComponentIds: string[] = [];
  const unassignedSectionComponentIds: string[] = [];
  const subAssemblyComponentIds: string[] = [];
  const issues: SteelStockList['issues'][number][] = [];
  const visit = (currentAssembly: AssemblyDocument, parentPath: readonly string[],
    parentNames: readonly string[], ancestors: readonly string[]): void => {
    for (const component of currentAssembly.components) {
      if (component.suppressed) continue;
      const occurrencePath = [...parentPath, component.id];
      const occurrenceNames = [...parentNames, component.name];
      const componentSource = component.source;
      const part = componentSource.kind === 'part' ? parts.get(componentSource.partRef) : undefined;
      const source = componentSource.kind === 'part' ? part?.steelStockSource : componentSource;
      if (source === undefined) continue;
      if (source.kind === 'subAssembly') {
        const nested = subAssemblies.get(source.assemblyRef);
        const reason = ancestors.includes(source.assemblyRef) ? 'cycle'
          : ancestors.length + 1 > MAX_SUB_ASSEMBLY_DEPTH ? 'depthLimit'
            : nested === undefined ? 'missingAssembly' : null;
        if (reason !== null) {
          subAssemblyComponentIds.push(component.id);
          issues.push({ reason, occurrencePath, occurrenceNames, assemblyRef: source.assemblyRef });
        } else if (nested !== undefined) {
          visit(nested, occurrencePath, occurrenceNames, [...ancestors, source.assemblyRef]);
        }
        continue;
      }
      if (source.kind !== 'standardPart') continue;
      const product = steelProductFromSource(source);
      if (product === undefined) {
        if (hasSteelOptions(source.options) || source.catalogRevision === STEEL_CATALOG_REVISION
          || source.generatorRevision === STEEL_GENERATOR_REVISION || source.catalog === 'flatBar'
          || source.catalog === 'roundBar' || source.catalog === 'steelPipe') {
          unresolvedComponentIds.push(component.id);
          issues.push({ reason: 'unknownSteel', occurrencePath, occurrenceNames });
        } else if (source.catalog === 'equalAngle' || source.catalog === 'channel' || source.catalog === 'hBeam') {
          unassignedSectionComponentIds.push(component.id);
          issues.push({ reason: 'unassignedMaterial', occurrencePath, occurrenceNames });
        }
        continue;
      }
      const length = steelLength(source.options.length ?? '1000');
      if (length === null) {
        unresolvedComponentIds.push(component.id);
        issues.push({ reason: 'unknownSteel', occurrencePath, occurrenceNames });
        continue;
      }
      const proved = part === undefined ? length.value : steelFinishedLength(part, source);
      // A part lengthened past its purchased stock cannot be cut from it; never report that length as finished.
      const finishedLengthMm = proved !== null && proved > length.value + 1e-9 * Math.max(1, length.value)
        ? null : proved;
      const key = `${product.key}@${source.catalogRevision}/${source.generatorRevision}:${length.value}:finished:${finishedLengthMm ?? 'unknown'}`;
      const current = groups.get(key);
      const quantity = (current?.quantity ?? 0) + 1;
      groups.set(key, { key, product, catalogRevision: source.catalogRevision, generatorRevision: source.generatorRevision,
        lengthMm: length.value, finishedLengthMm, quantity,
        totalLengthMm: length.value * quantity,
        componentIds: [...(current?.componentIds ?? []), component.id],
        occurrencePaths: [...(current?.occurrencePaths ?? []), occurrencePath] });
    }
  };
  visit(assembly, [], [], []);
  const rows = [...groups.values()];
  return { rows, totalQuantity: rows.reduce((total, row) => total + row.quantity, 0),
    totalLengthMm: rows.reduce((total, row) => total + row.totalLengthMm, 0), unresolvedComponentIds,
    unassignedSectionComponentIds, subAssemblyComponentIds, issues };
}
