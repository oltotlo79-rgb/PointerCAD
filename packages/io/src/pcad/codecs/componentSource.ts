import { STANDARD_CATALOG_IDS, type ComponentSource } from '@pointercad/model';
import { joinPath, readRecord, readLiteral, readString, type Checked } from '../guards.js';

const COMPONENT_SOURCE_KINDS: readonly ComponentSource['kind'][] = [
  'part',
  'subAssembly',
  'standardPart',
];

/** 規格部品の追加の指定(§0.a-0.34)。値が文字列でない欄が 1 つでもあれば断る。 */
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
      return {
        ok: true,
        value: {
          kind: 'standardPart',
          catalog: catalog.value,
          size: size.value,
          options: options.value,
          catalogRevision: catalogRevision.value,
          generatorRevision: generatorRevision.value,
        },
      };
    }
  }
}

