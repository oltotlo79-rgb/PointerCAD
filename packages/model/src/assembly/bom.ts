/**
 * アセンブリの部品表(FR-611、P7 §2.10・§2.10.1)。
 *
 * 保存文書を書き換えず、置いた部品と解決済みの体積から表示行を作る純関数である。
 * 同じ部品の判定は `partKeyOf` に集め、材質を加えた組を部品表の同一性にする。
 * 規格部品の鍵には寸法表と生成台本の改訂も既に含まれるため、改訂が違う形を
 * 同じ行へ混ぜない。行番号は保存せず、木を最初に歩いた順から毎回導出する。
 */

import {
  findDensityMaterial,
} from '../appearance/densityMaterials.js';
import { massFromVolume } from '../measure/massProperties.js';
import type { MaterialBearingPartDocument } from './massProperties.js';
import { materialOf } from './massProperties.js';
import { partKeyOf } from './resolveAssembly.js';
import type { AssemblyComponent, AssemblyDocument, BomSettings } from './types.js';

/** 部品表の質量計算に必要な、カーネルから得たボディの最小の形。 */
export interface BomBody {
  readonly volume: number;
}

/** 展開可能なサブアセンブリ 1 件。P7 タスク36の再帰解決結果をそのまま渡せる。 */
export interface BomSubAssemblyData {
  readonly assembly: AssemblyDocument;
  readonly resolved: BomResolvedData;
}

/** 部品表が解決結果から読む欄。描画用の `AssemblyView` より小さく保つ。 */
export interface BomResolvedData {
  readonly partKeys: ReadonlyMap<string, string>;
  readonly bodies: ReadonlyMap<string, readonly BomBody[]>;
  /** 材質を持つ将来版を含む、抱き込んだ部品文書。 */
  readonly documents?: ReadonlyMap<string, MaterialBearingPartDocument>;
  /** `assemblyRef` から中身を引く表。無ければサブアセンブリは 1 行のままにする。 */
  readonly subAssemblies?: ReadonlyMap<string, BomSubAssemblyData>;
}

/** 部品表の表示元になる集計行。 */
export interface BomRow {
  /** 部品・材質・入れ子の名前空間から作る、並べ替えても変わらない識別子。 */
  readonly rowKey: string;
  /** 木で最初に現れた順から導出した表示番号。保存データではない。 */
  readonly number: number;
  readonly name: string;
  readonly configurationName: string | null;
  readonly quantity: number;
  /** 密度表の id。材質は部品表の同一性に含む。 */
  readonly materialId: string;
  /** model では翻訳を持たないため安定した材料名として id を渡す。UI が表示名へ訳す。 */
  readonly materialName: string;
  readonly massEach: number | null;
  readonly massTotal: number | null;
  readonly componentIds: readonly string[];
  /** この行を最初に作った出現の階層経路。 */
  readonly occurrencePath: readonly string[];
  /** 同じ行へ集計した全出現の階層経路。 */
  readonly occurrencePaths: readonly (readonly string[])[];
}

interface MutableBomRow {
  readonly rowKey: string;
  readonly number: number;
  readonly name: string;
  readonly configurationName: string | null;
  readonly materialId: string;
  readonly materialName: string;
  readonly massEach: number | null;
  quantity: number;
  readonly componentIds: string[];
  readonly occurrencePath: readonly string[];
  readonly occurrencePaths: (readonly string[])[];
}

/** 既定名 `<部品名>:<n>` の採番だけを落とし、利用者が付けた通常の名前は保つ。 */
export function bomPartName(component: AssemblyComponent): string {
  return component.name.replace(/:\d+$/u, '');
}

/** 行キーに区切り文字を安全に入れる。元の鍵が違えば同じ行キーにはならない。 */
function rowKeyOf(scope: string, partKey: string, materialId: string): string {
  return `bom:${encodeURIComponent(scope)}:${encodeURIComponent(partKey)}:${encodeURIComponent(materialId)}`;
}

/** ボディが得られなかった、または壊れた体積なら null。空の有効な部品は体積 0 とする。 */
function volumeOf(partKey: string, resolved: BomResolvedData): number | null {
  const bodies = resolved.bodies.get(partKey);
  if (bodies === undefined) {
    return null;
  }
  let volume = 0;
  for (const body of bodies) {
    if (!Number.isFinite(body.volume) || body.volume < 0) {
      return null;
    }
    volume += body.volume;
  }
  return Number.isFinite(volume) ? volume : null;
}

function massOf(partKey: string, materialId: string, resolved: BomResolvedData): number | null {
  const material = findDensityMaterial(materialId);
  const volume = volumeOf(partKey, resolved);
  return material === undefined || volume === null
    ? null
    : massFromVolume(volume, material.density);
}

function compareNullableNumber(left: number | null, right: number | null): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return left - right;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRows(left: BomRow, right: BomRow, settings: BomSettings): number {
  let compared = 0;
  switch (settings.sortBy) {
    case 'number': compared = left.number - right.number; break;
    case 'name': compared = compareText(left.name, right.name); break;
    case 'quantity': compared = left.quantity - right.quantity; break;
    case 'mass': compared = compareNullableNumber(left.massTotal, right.massTotal); break;
  }
  return compared === 0 ? left.number - right.number : compared;
}

/**
 * 部品を同一性ごとに集計する。非表示は組み立ての一部なので数え、抑制は数えない。
 * サブアセンブリを展開するときも、循環・深さ超過・未解決なら親を 1 行として残す。
 */
export function buildBom(
  assembly: AssemblyDocument,
  resolved: BomResolvedData,
  settings: BomSettings = assembly.bom,
): readonly BomRow[] {
  const grouped = new Map<string, MutableBomRow>();
  let nextNumber = 1;

  const add = (
    component: AssemblyComponent,
    currentResolved: BomResolvedData,
    scope: string,
    path: readonly string[],
  ): void => {
    const partKey = currentResolved.partKeys.get(component.id) ?? partKeyOf(component.source);
    const partDocument = currentResolved.documents?.get(partKey);
    const materialId = materialOf(component, partDocument);
    const configurationName = partDocument?.configurations.find((configuration) => configuration.id === partDocument.activeConfigurationId)?.name ?? null;
    const identity = `${scope}\u0000${partKey}\u0000${materialId}`;
    const found = grouped.get(identity);
    if (found !== undefined) {
      found.quantity += 1;
      found.componentIds.push(component.id);
      found.occurrencePaths.push(path);
      return;
    }
    const massEach = massOf(partKey, materialId, currentResolved);
    grouped.set(identity, {
      rowKey: rowKeyOf(scope, partKey, materialId),
      number: nextNumber,
      name: bomPartName(component),
      configurationName,
      quantity: 1,
      materialId,
      materialName: materialId,
      massEach,
      componentIds: [component.id],
      occurrencePath: path,
      occurrencePaths: [path],
    });
    nextNumber += 1;
  };

  const visit = (
    current: AssemblyDocument,
    currentResolved: BomResolvedData,
    scope: string,
    parentPath: readonly string[],
    ancestors: ReadonlySet<string>,
  ): void => {
    for (const component of current.components) {
      if (component.suppressed) continue;
      const path = [...parentPath, component.id];
      if (settings.expandSubAssemblies && component.source.kind === 'subAssembly') {
        const reference = component.source.assemblyRef;
        const nested = currentResolved.subAssemblies?.get(reference);
        if (nested !== undefined && !ancestors.has(reference) && ancestors.size < 8) {
          visit(
            nested.assembly,
            nested.resolved,
            `${scope}/${reference}`,
            path,
            new Set([...ancestors, reference]),
          );
          continue;
        }
      }
      add(component, currentResolved, scope, path);
    }
  };

  visit(assembly, resolved, 'root', [], new Set());
  const rows: BomRow[] = [...grouped.values()].map((row) => ({
    ...row,
    massTotal: row.massEach === null ? null : row.massEach * row.quantity,
  }));
  return rows.sort((left, right) => compareRows(left, right, settings));
}
