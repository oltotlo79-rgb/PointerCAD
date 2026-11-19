import { STANDARD_CATALOG_IDS, type ComponentSource } from '@pointercad/model';
import { joinPath, readRecord, readLiteral, readString, type Checked } from '../guards.js';

const COMPONENT_SOURCE_KINDS: readonly ComponentSource['kind'][] = [
  'part',
  'subAssembly',
  'standardPart',
];

const legacySteelLabels = [
  ['flatBar', 'productStandard', String.fromCharCode(29579, 23376, 35069, 37444, 32, 20844, 34920, 26029, 38754, 23544, 27861), '公表平鋼寸法'],
  ['roundBar', 'productStandard', String.fromCharCode(22823, 38442, 35069, 37941, 32, 20844, 34920, 20024, 37628, 23544, 27861), '公表丸鋼寸法'],
  ['equalAngle', 'evidence', String.fromCharCode(111, 115, 97, 107, 97), 'rolledSections'],
  ['channel', 'evidence', String.fromCharCode(111, 115, 97, 107, 97), 'rolledSections'],
  ['hBeam', 'evidence', String.fromCharCode(121, 97, 109, 97, 116, 111), 'wideFlange'],
] as const;
const LEGACY_STEEL_REVISION = 'jp-steel-2026-10-10-r1';
const SOURCE_KEY_PREFIX = 'standard:';
const CIRCULAR_WELD_OPTION = 'weldCircular';

/** 欄と値の組の JSON(`[["欄","値"],…]`)。形が違えば null。 */
function optionPairs(text: string): (readonly [string, string])[] | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(value)) return null;
  const pairs = value.flatMap((pair: unknown): (readonly [string, string])[] => (Array.isArray(pair) && pair.length === 2
    && typeof pair[0] === 'string' && typeof pair[1] === 'string' ? [[pair[0], pair[1]]] : []));
  return pairs.length === value.length && new Set(pairs.map(([name]) => name)).size === pairs.length ? pairs : null;
}

/** 物の欄を名前の順に並べた JSON(model の円周の溶接の保存と同じ書き方)。 */
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key: string, row: unknown): unknown => (typeof row !== 'object' || row === null || Array.isArray(row) ? row
    : Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))));
}

/**
 * 部品の出どころの鍵(`componentSourceKey` の形 `standard:<catalog>:<呼び>:<表の版>:<台本の版>:<欄と値の JSON>`)の、旧版の鋼材の古い表記を直す。
 * 円周の溶接が保存する親の鍵に使う。旧版の鋼材の鍵でない・古い表記を持たない鍵は、そのまま返す。
 */
function canonicalSteelSourceKey(key: string): string {
  const anchor = `:${LEGACY_STEEL_REVISION}:`;
  const at = key.indexOf(anchor);
  const head = at < 0 ? '' : key.slice(SOURCE_KEY_PREFIX.length, at);
  const colon = head.indexOf(':');
  const catalog = STANDARD_CATALOG_IDS.find((id) => id === head.slice(0, colon) && id !== 'filletWeld');
  const rest = key.slice(at + anchor.length);
  const split = rest.indexOf(':');
  const pairs = !key.startsWith(SOURCE_KEY_PREFIX) || catalog === undefined || split < 0 ? null : optionPairs(rest.slice(split + 1));
  if (pairs === null || catalog === undefined) return key;
  const options = Object.fromEntries(pairs);
  const canonical = canonicalSteelOptions({ kind: 'standardPart', catalog, size: head.slice(colon + 1), options,
    catalogRevision: LEGACY_STEEL_REVISION, generatorRevision: rest.slice(0, split) });
  return canonical === options ? key
    : key.slice(0, at + anchor.length + split + 1) + JSON.stringify(Object.keys(canonical).sort().map((name) => [name, canonical[name]]));
}

/** 円周の溶接のビードの options(`weldCircular` の 1 欄だけ)の中の、親の部品の鍵(`sourceKey`)の古い表記を直す。直す物が無ければ元の options。 */
function canonicalCircularWeldOptions(options: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const text = options[CIRCULAR_WELD_OPTION];
  if (text === undefined || Object.keys(options).length !== 1) return options;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return options; }
  let changed = false;
  const walk = (item: unknown, name: string | null): unknown => {
    if (typeof item === 'string') {
      const next = name === 'sourceKey' ? canonicalSteelSourceKey(item) : item;
      changed ||= next !== item;
      return next;
    }
    if (Array.isArray(item)) return item.map((entry: unknown) => walk(entry, null));
    return typeof item === 'object' && item !== null ? Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, walk(entry, key)])) : item;
  };
  const next = walk(value, null);
  return changed ? { [CIRCULAR_WELD_OPTION]: sortedJson(next) } : options;
}

/** The old r1 generator stored these exact descriptions in its options. */
export function canonicalSteelOptions(source: Extract<ComponentSource, { kind: 'standardPart' }>): Readonly<Record<string, string>> {
  const { options } = source;
  if (source.catalog === 'filletWeld') return canonicalCircularWeldOptions(options);
  if (source.catalogRevision !== LEGACY_STEEL_REVISION || options.materialGrade !== 'SS400') return options;
  for (const [catalog, field, oldValue, newValue] of legacySteelLabels) {
    if (source.catalog === catalog && options[field] === oldValue) return { ...options, [field]: newValue };
  }
  return options;
}

/**
 * 部品の鍵(`partKeyOf` の形 `<catalog>@<表の版>/<台本の版>:<呼び>|<欄>=<値>…`)の文字列の中の、旧版の鋼材の古い表記を、
 * 部品の options と同じ表(`canonicalSteelOptions`)で新しい表記へ直す。古いファイルの梁の解析などが保存した鍵を、読んだ部品の今の鍵に合わせる。
 * 円周の溶接のビードの鍵(`filletWeld@…|weldCircular=<JSON>`)は、中の親の部品の鍵を同じ表で直す(ビードの options の直しと同じ結果)。
 * 鋼材の旧版の鍵でない・古い表記を持たない鍵は、そのまま返す。
 */
export function canonicalSteelPartKey(key: string): string {
  const bar = key.indexOf('|');
  const head = bar < 0 ? '' : key.slice(0, bar);
  const at = head.indexOf('@');
  const slash = head.indexOf('/', at);
  const catalog = STANDARD_CATALOG_IDS.find((id) => id === head.slice(0, at));
  if (at < 0 || slash < 0 || catalog === undefined) return key;
  // ビードの JSON は | を含みうるので、1 欄だけの鍵として分ける。
  const weld = `|${CIRCULAR_WELD_OPTION}=`;
  const pairs = catalog === 'filletWeld' ? (key.startsWith(weld, bar) ? [[CIRCULAR_WELD_OPTION, key.slice(bar + weld.length)] as const] : [])
    : key.slice(bar + 1).split('|').map((segment) => [segment.slice(0, segment.indexOf('=')), segment.slice(segment.indexOf('=') + 1)] as const);
  if (pairs.length === 0) return key;
  const options = Object.fromEntries(pairs);
  if (pairs.some(([name]) => name === '') || Object.keys(options).length !== pairs.length) return key;
  const canonical = canonicalSteelOptions({ kind: 'standardPart', catalog, size: '', options,
    catalogRevision: head.slice(at + 1, slash), generatorRevision: '' });
  return canonical === options ? key : head + pairs.map(([name]) => `|${name}=${canonical[name] ?? ''}`).join('');
}

/** 規格部品の追加の指定。値が文字列でない欄が 1 つでもあれば断る。 */
function readStandardOptions(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<Record<string, string>> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const options: Record<string, string> = {};
  for (const name of Object.keys(record.value)) {
    const value = readString(record.value, name, path);
    if (!value.ok) {
      return value;
    }
    options[name] = value.value;
  }
  return { ok: true, value: options };
}

export function readComponentSource(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<ComponentSource> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const kind = readLiteral(record.value, 'kind', path, COMPONENT_SOURCE_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'part': {
      const partRef = readString(record.value, 'partRef', path);
      if (!partRef.ok) {
        return partRef;
      }
      return { ok: true, value: { kind: 'part', partRef: partRef.value } };
    }
    case 'subAssembly': {
      const assemblyRef = readString(record.value, 'assemblyRef', path);
      if (!assemblyRef.ok) {
        return assemblyRef;
      }
      return { ok: true, value: { kind: 'subAssembly', assemblyRef: assemblyRef.value } };
    }
    case 'standardPart': {
      const catalog = readLiteral(record.value, 'catalog', path, STANDARD_CATALOG_IDS);
      if (!catalog.ok) {
        return catalog;
      }
      const size = readString(record.value, 'size', path);
      if (!size.ok) {
        return size;
      }
      const options = readStandardOptions(record.value, 'options', path);
      if (!options.ok) {
        return options;
      }
      const catalogRevision = readString(record.value, 'catalogRevision', path);
      if (!catalogRevision.ok) {
        return catalogRevision;
      }
      const generatorRevision = readString(record.value, 'generatorRevision', path);
      if (!generatorRevision.ok) {
        return generatorRevision;
      }
      const standard: Extract<ComponentSource, { kind: 'standardPart' }> = {
        kind: 'standardPart', catalog: catalog.value, size: size.value, options: options.value,
        catalogRevision: catalogRevision.value, generatorRevision: generatorRevision.value,
      };
      return { ok: true, value: { ...standard, options: canonicalSteelOptions(standard) } };
    }
  }
}

