import type { PartDocument } from '../part/types.js';
import { nextSerialName } from '../sketch/createSketchDocument.js';
import { componentNamePrefix, COMPONENT_NAME_SEPARATOR } from './assemblyEdit.js';
import type { CatalogRegistry } from './catalog/registry.js';
import type { PartLibrary } from './partLibrary.js';
import type { StandardPartSource } from './resolveAssembly.js';
import type { ComponentSource } from './types.js';

/** 族の部品の保存の形で、族と行を指す欄の鍵(一括の書き換え memberBulkEdit.ts も使う)。 */
export const FAMILY_KEY = 'family', ITEM_KEY = 'item';

interface PlacementNameSources {
  readonly library?: PartLibrary;
  readonly registry: CatalogRegistry;
  readonly buildStandardPartFromSource: (source: StandardPartSource) => PartDocument | null;
}

/** 置いた時の部品名。抱き込んだ文書、族の行と指定値、または規格部品の生成結果から引く。 */
export function placedPartName(source: ComponentSource, sources: PlacementNameSources): string | null {
  switch (source.kind) {
    case 'part':
      return sources.library?.parts.get(source.partRef)?.name ?? null;
    case 'subAssembly':
      return sources.library?.assemblies?.get(source.assemblyRef)?.name ?? null;
    case 'standardPart': {
      if (source.catalog !== 'catalogItem') return sources.buildStandardPartFromSource(source)?.name ?? null;
      const family = sources.registry.loaded(source.options[FAMILY_KEY] ?? '');
      const row = family?.rows.find((candidate) => candidate.key === source.options[ITEM_KEY]);
      if (family === undefined || row === undefined) return null;
      const values = Object.fromEntries(family.options.map((spec) => [spec.key, source.options[spec.key] ?? spec.defaultValue]));
      return family.partName(row, values);
    }
    default:
      return null;
  }
}

export interface ReplacementPartNames {
  readonly before: string | null;
  readonly after: string | null;
}

/** 「元の部品名:番号」の時だけ、配置と同じ連番で新しい名前を付ける。 */
export function nextComponentNameFor(name: string, { before, after }: ReplacementPartNames, used: Iterable<string>): string {
  if (before === null || after === null) return name;
  const prefix = componentNamePrefix(before);
  const legacyPrefix = `${before}${COMPONENT_NAME_SEPARATOR}`;
  const nextPrefix = componentNamePrefix(after);
  // 旧版で空の文書名から作った「:番号」も、その元文書を替える時は従来の自動名として扱う。
  const previous = [prefix, legacyPrefix].find(value => name.startsWith(value) && /^[0-9]+$/u.test(name.slice(value.length)));
  return previous === undefined || previous === nextPrefix ? name : nextSerialName(used, nextPrefix);
}
