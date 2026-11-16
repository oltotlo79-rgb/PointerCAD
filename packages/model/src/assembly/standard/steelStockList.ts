import type { PartDocument } from '../../part/types.js';
import { steelFinishedLength } from './steelFinishedLength.js';
import type { AssemblyDocument } from '../types.js';
import { MAX_SUB_ASSEMBLY_DEPTH } from '../resolveAssembly.js';
import { PRODUCT_CATALOG_REGISTRY, type CatalogRegistry } from '../catalog/registry.js';
import { catalogStockItem, type CatalogStockItem } from '../catalog/stockList.js';
import { hasSteelOptions, isSteelCatalogRevision, STEEL_GENERATOR_REVISION,
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
  /**
   * 長さを持つ族(フレームなど)の部品の行。同じ族・版・行・長さを束ね、鋼材の行・合計とは別に持つ(族の部品が無い文書では空)。
   * massTotalG は 1 本の質量 × 本数(1 本の質量が出せない時は null)。K-06 段 2 の土台。
   */
  readonly catalogRows: readonly (CatalogStockItem & {
    readonly quantity: number;
    readonly totalLengthMm: number;
    readonly massTotalG: number | null;
    readonly componentIds: readonly string[];
    readonly occurrencePaths: readonly (readonly string[])[];
  })[];
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
 * Catalog family parts of a 'linear' family are grouped into `catalogRows` (never into the steel rows or totals).
 */
export function buildSteelStockList(assembly: AssemblyDocument,
  subAssemblies: ReadonlyMap<string, AssemblyDocument> = new Map(),
  parts: ReadonlyMap<string, PartDocument> = new Map(),
  registry: CatalogRegistry = PRODUCT_CATALOG_REGISTRY): SteelStockList {
  const groups = new Map<string, SteelStockRow>();
  const catalogGroups = new Map<string, SteelStockList['catalogRows'][number]>();
  const addCatalogRow = (item: CatalogStockItem, componentId: string, occurrencePath: readonly string[]): void => {
    const current = catalogGroups.get(item.key);
    const quantity = (current?.quantity ?? 0) + 1;
    catalogGroups.set(item.key, { ...item, quantity, totalLengthMm: item.lengthMm * quantity,
      massTotalG: item.massEachG === null ? null : item.massEachG * quantity,
      componentIds: [...(current?.componentIds ?? []), componentId],
      occurrencePaths: [...(current?.occurrencePaths ?? []), occurrencePath] });
  };
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
      if (source.catalog === 'catalogItem') {
        const item = catalogStockItem(source, registry);
        if (item !== null) addCatalogRow(item, component.id, occurrencePath);
        continue;
      }
      const product = steelProductFromSource(source);
      if (product === undefined) {
        if (hasSteelOptions(source.options) || isSteelCatalogRevision(source.catalogRevision)
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
  return { rows, catalogRows: [...catalogGroups.values()], totalQuantity: rows.reduce((total, row) => total + row.quantity, 0),
    totalLengthMm: rows.reduce((total, row) => total + row.totalLengthMm, 0), unresolvedComponentIds,
    unassignedSectionComponentIds, subAssemblyComponentIds, issues };
}
