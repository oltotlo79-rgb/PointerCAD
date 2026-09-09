/** 名前付き視点と構成の保存境界。式は読み込み後に修正できるよう文字列のまま保つ。 */
import { isValidNamedViewCamera, type Configuration, type NamedView, type Parameter } from '@pointercad/model';

import {
  checkRecord, fieldProblem, indexPath, joinPath, readArray, readLiteral, readNumber,
  readRecord, readString, readValue, readVec3, type Checked,
} from './guards.js';

export function serializeNamedViews(views: readonly NamedView[]): readonly NamedView[] {
  return views.map((view) => ({ id: view.id, name: view.name,
    position: [...view.position], target: [...view.target], up: [...view.up],
    projection: view.projection, zoom: view.zoom }));
}

export function serializeConfigurations(configurations: readonly Configuration[]): readonly Configuration[] {
  return configurations.map((configuration) => ({ id: configuration.id, name: configuration.name,
    values: Object.fromEntries(Object.entries(configuration.values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
  }));
}

function readNamedView(value: unknown, path: string): Checked<NamedView> {
  const record = checkRecord(value, path);
  if (!record.ok) return record;
  const id = readString(record.value, 'id', path);
  if (!id.ok) return id;
  const name = readString(record.value, 'name', path);
  if (!name.ok) return name;
  if (id.value.trim().length === 0) return fieldProblem(joinPath(path, 'id'), 'type');
  if (name.value.trim().length === 0) return fieldProblem(joinPath(path, 'name'), 'type');
  const position = readVec3(record.value, 'position', path);
  if (!position.ok) return position;
  const target = readVec3(record.value, 'target', path);
  if (!target.ok) return target;
  const up = readVec3(record.value, 'up', path);
  if (!up.ok) return up;
  const projection = readLiteral(record.value, 'projection', path, ['perspective', 'orthographic']);
  if (!projection.ok) return projection;
  const zoom = readNumber(record.value, 'zoom', path);
  if (!zoom.ok) return zoom;
  const view: NamedView = { id: id.value, name: name.value, position: position.value,
    target: target.value, up: up.value, projection: projection.value, zoom: zoom.value };
  return isValidNamedViewCamera(view) ? { ok: true, value: view } : fieldProblem(path, 'type');
}

export function readNamedViews(record: Record<string, unknown>, path: string): Checked<readonly NamedView[]> {
  const entries = readArray(record, 'namedViews', path);
  if (!entries.ok) return entries;
  const result: NamedView[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const [index, entry] of entries.value.entries()) {
    const entryPath = indexPath(joinPath(path, 'namedViews'), index);
    const view = readNamedView(entry, entryPath);
    if (!view.ok) return view;
    if (ids.has(view.value.id) || names.has(view.value.name.trim())) return fieldProblem(entryPath, 'type');
    ids.add(view.value.id);
    names.add(view.value.name.trim());
    result.push(view.value);
  }
  return { ok: true, value: result };
}

export interface ConfigurationData {
  readonly configurations: readonly Configuration[];
  readonly activeConfigurationId: string | null;
}

export function readConfigurationData(
  record: Record<string, unknown>, path: string, parameters: readonly Parameter[],
): Checked<ConfigurationData> {
  const entries = readArray(record, 'configurations', path);
  if (!entries.ok) return entries;
  const configurations: Configuration[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  const parameterNames = new Set(parameters.map((parameter) => parameter.name));
  for (const [index, entry] of entries.value.entries()) {
    const entryPath = indexPath(joinPath(path, 'configurations'), index);
    const configuration = checkRecord(entry, entryPath);
    if (!configuration.ok) return configuration;
    const id = readString(configuration.value, 'id', entryPath);
    if (!id.ok) return id;
    const name = readString(configuration.value, 'name', entryPath);
    if (!name.ok) return name;
    if (id.value.trim().length === 0 || ids.has(id.value)) return fieldProblem(joinPath(entryPath, 'id'), 'type');
    if (name.value.trim().length === 0 || names.has(name.value.trim())) return fieldProblem(joinPath(entryPath, 'name'), 'type');
    const rawValues = readRecord(configuration.value, 'values', entryPath);
    if (!rawValues.ok) return rawValues;
    const values: [string, string][] = [];
    for (const [key, source] of Object.entries(rawValues.value)) {
      if (!parameterNames.has(key) || typeof source !== 'string') return fieldProblem(joinPath(entryPath, `values.${key}`), 'type');
      values.push([key, source]);
    }
    if (values.length !== parameterNames.size) return fieldProblem(joinPath(entryPath, 'values'), 'type');
    ids.add(id.value);
    names.add(name.value.trim());
    configurations.push({ id: id.value, name: name.value, values: Object.fromEntries(values) });
  }
  const active = readValue(record, 'activeConfigurationId', path);
  if (!active.ok) return active;
  if ((active.value === null && configurations.length !== 0)
    || (active.value !== null && (typeof active.value !== 'string' || !ids.has(active.value)))) {
    return fieldProblem(joinPath(path, 'activeConfigurationId'), 'type');
  }
  if (typeof active.value !== 'string' && active.value !== null) return fieldProblem(joinPath(path, 'activeConfigurationId'), 'type');
  return { ok: true, value: { configurations, activeConfigurationId: active.value } };
}
