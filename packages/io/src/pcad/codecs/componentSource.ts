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

/** The old r1 generator stored these exact descriptions in its options. */
export function canonicalSteelOptions(source: Extract<ComponentSource, { kind: 'standardPart' }>): Readonly<Record<string, string>> {
  const { options } = source;
  if (source.catalogRevision !== 'jp-steel-2026-10-10-r1' || options.materialGrade !== 'SS400') return options;
  for (const [catalog, field, oldValue, newValue] of legacySteelLabels) {
    if (source.catalog === catalog && options[field] === oldValue) return { ...options, [field]: newValue };
  }
  return options;
}

/**
 * 部品の鍵(`partKeyOf` の形 `<catalog>@<表の版>/<台本の版>:<呼び>|<欄>=<値>…`)の文字列の中の、旧版の鋼材の古い表記を、
 * 部品の options と同じ表(`canonicalSteelOptions`)で新しい表記へ直す。古いファイルの梁の解析などが保存した鍵を、読んだ部品の今の鍵に合わせる。
 * 鋼材の旧版の鍵でない・古い表記を持たない鍵は、そのまま返す。
 */
export function canonicalSteelPartKey(key: string): string {
  const bar = key.indexOf('|');
  const head = bar < 0 ? '' : key.slice(0, bar);
  const at = head.indexOf('@');
  const slash = head.indexOf('/', at);
  const catalog = STANDARD_CATALOG_IDS.find((id) => id === head.slice(0, at));
  if (at < 0 || slash < 0 || catalog === undefined) return key;
  const pairs = key.slice(bar + 1).split('|').map((segment) => [segment.slice(0, segment.indexOf('=')), segment.slice(segment.indexOf('=') + 1)] as const);
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

