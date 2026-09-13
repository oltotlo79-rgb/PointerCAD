/** 名前付きの設計表。保存するのは式だけで、切替時にパラメータと形状を再評価する。 */
import { renameVariable, type StoredMathExpression } from '@pointercad/expression';

import { analyzeParameters } from '../parameters/parameterTable.js';
import type { Parameter } from '../parameters/types.js';

import { applyParameters } from './reevaluatePart.js';
import type { PartDocument } from './types.js';
import { configurationDefinitions, configurationParameters, sameConfigurationDefinitions } from './configurationExpressions.js';

export interface Configuration {
  readonly mathDefinitions?: Readonly<Record<string, StoredMathExpression>>;
  readonly id: string;
  readonly name: string;
  readonly values: Readonly<Record<string, string>>;
}

export type ConfigurationRefusal = 'emptyName' | 'duplicateName' | 'notFound'
  | 'unknownParameter' | 'missingParameter' | 'invalidExpression';
export type ConfigurationChange =
  | { readonly ok: true; readonly document: PartDocument }
  | { readonly ok: false; readonly reason: ConfigurationRefusal; readonly parameter?: string };

function sources(parameters: readonly Parameter[]): Readonly<Record<string, string>> {
  return Object.fromEntries(parameters.map((parameter) => [parameter.name, parameter.value.source]));
}


function validateValues(document: PartDocument, values: Readonly<Record<string, string>>): ConfigurationRefusal | null {
  const names = new Set(document.parameters.map((parameter) => parameter.name));
  if (Object.keys(values).some((name) => !names.has(name))) return 'unknownParameter';
  if (document.parameters.some((parameter) => !Object.hasOwn(values, parameter.name))) return 'missingParameter';
  if (Object.values(values).some((value) => typeof value !== 'string' || value.trim().length === 0)) return 'invalidExpression';
  const analysis = analyzeParameters(withSources(document.parameters, values), []);
  return analysis.circular.length > 0 || analysis.failures.length > 0 ? 'invalidExpression' : null;
}

function withSources(parameters: readonly Parameter[], values: Readonly<Record<string, string>>): readonly Parameter[] {
  return configurationParameters(parameters, { values });
}

export function createConfiguration(
  document: PartDocument, name: string, overrides: Readonly<Record<string, string>> = {},
): ConfigurationChange {
  const prepared = prepareConfigurationCreation(document, name, overrides);
  if (!prepared.ok) return prepared;
  const configuration = prepared.configuration;
  if (configuration.mathDefinitions !== undefined) return { ok: false, reason: 'invalidExpression' };
  const reason = validateValues(document, configuration.values);
  if (reason !== null) return { ok: false, reason };
  const next = { ...document, configurations: [...document.configurations, configuration] };
  return document.activeConfigurationId === null ? activateConfiguration(next, configuration.id) : { ok: true, document: next };
}

/** Common structural preparation. Mathematical values still require the asynchronous evaluation boundary. */
export function prepareConfigurationCreation(
  document: PartDocument, name: string, overrides: Readonly<Record<string, string>> = {},
): { readonly ok: true; readonly configuration: Configuration } | Extract<ConfigurationChange, { ok: false }> {
  const trimmed = name.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'emptyName' };
  if (document.configurations.some((configuration) => configuration.name === trimmed)) return { ok: false, reason: 'duplicateName' };
  const values = { ...sources(document.parameters), ...overrides };
  const names = new Set(document.parameters.map(parameter => parameter.name));
  if (Object.keys(values).some(key => !names.has(key))) return { ok: false, reason: 'unknownParameter' };
  if (Object.values(values).some(value => typeof value !== 'string' || value.trim().length === 0)) return { ok: false, reason: 'invalidExpression' };
  let serial = 1;
  for (const entry of document.configurations) {
    const match = /^configuration-(\d+)$/.exec(entry.id);
    if (match !== null && Number.isSafeInteger(Number(match[1]))) serial = Math.max(serial, Number(match[1]) + 1);
  }
  const mathDefinitions = configurationDefinitions(document.parameters, values);
  return { ok: true, configuration: { id: `configuration-${String(serial)}`, name: trimmed, values,
    ...(mathDefinitions === undefined ? {} : { mathDefinitions }) } };
}

export function activateConfiguration(document: PartDocument, id: string): ConfigurationChange {
  const configuration = document.configurations.find((entry) => entry.id === id);
  if (configuration === undefined) return { ok: false, reason: 'notFound' };
  const reason = validateValues(document, configuration.values);
  if (reason !== null) return { ok: false, reason };
  // Mathematical configurations are applied only after asynchronous validation by activateMathConfiguration.
  if (configuration.mathDefinitions !== undefined) return { ok: false, reason: 'invalidExpression' };
  const parameters = configurationParameters(document.parameters, configuration);
  if (document.activeConfigurationId === id && parameters === document.parameters) return { ok: true, document };
  const next = { ...document, activeConfigurationId: id, parameters };
  return { ok: true, document: applyParameters(next).document };
}

export function renameConfiguration(document: PartDocument, id: string, name: string): ConfigurationChange {
  const previous = document.configurations.find((entry) => entry.id === id);
  if (previous === undefined) return { ok: false, reason: 'notFound' };
  const trimmed = name.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'emptyName' };
  if (document.configurations.some((entry) => entry.id !== id && entry.name === trimmed)) return { ok: false, reason: 'duplicateName' };
  if (previous.name === trimmed) return { ok: true, document };
  return { ok: true, document: { ...document,
    configurations: document.configurations.map((entry) => entry.id === id ? { ...entry, name: trimmed } : entry),
  } };
}

export function deleteConfiguration(document: PartDocument, id: string): ConfigurationChange {
  if (!document.configurations.some((entry) => entry.id === id)) return { ok: false, reason: 'notFound' };
  const configurations = document.configurations.filter((entry) => entry.id !== id);
  const next = { ...document, configurations };
  if (document.activeConfigurationId !== id) return { ok: true, document: next };
  if (configurations.length === 0) return { ok: true, document: { ...next, activeConfigurationId: null } };
  return activateConfiguration(next, configurations[0].id);
}

/** 表の通常編集時に、選択中の構成へ式を反映する。他の構成の独自の式は保つ。 */
export function synchronizeConfigurations(document: PartDocument): PartDocument {
  let changed = false;
  const configurations = document.configurations.map((configuration) => {
    const active = configuration.id === document.activeConfigurationId;
    const entries = document.parameters.map((parameter) => [parameter.name,
      active || !Object.hasOwn(configuration.values, parameter.name)
         ? parameter.value.source : configuration.values[parameter.name]] as const);
    const values = Object.fromEntries(entries);
    const definitions = active ? configurationDefinitions(document.parameters, values) : Object.fromEntries(
      document.parameters.flatMap(parameter => {
        const definition = Object.hasOwn(configuration.values, parameter.name)
          ? configuration.mathDefinitions?.[parameter.name] : parameter.value.mathDefinition;
        return definition === undefined ? [] : [[parameter.name, definition] as const];
      }),
    );
    const mathDefinitions = definitions !== undefined && Object.keys(definitions).length > 0 ? definitions : undefined;
    if (entries.length === Object.keys(configuration.values).length
      && entries.every(([name, value]) => configuration.values[name] === value)
      && sameConfigurationDefinitions(configuration.mathDefinitions, mathDefinitions)) return configuration;
    changed = true;
    return { id: configuration.id, name: configuration.name, values,
      ...(mathDefinitions === undefined ? {} : { mathDefinitions }) };
  });
  return changed ? { ...document, configurations } : document;
}

/** 通常のパラメータ改名と同じUndoに入れる。別の構成の式も字句単位で追従させる。 */
export function renameConfigurationParameter(document: PartDocument, from: string, to: string): PartDocument {
  let changed = false;
  const configurations = document.configurations.map((configuration) => {
    let entryChanged = false;
    const entries = Object.entries(configuration.values).map(([name, value]) => {
      const nextName = name === from ? to : name;
      const nextValue = renameVariable(value, from, to);
      entryChanged ||= nextName !== name || nextValue !== value;
      return [nextName, nextValue] as const;
    });
    if (!entryChanged) return configuration;
    changed = true;
    return { ...configuration, values: Object.fromEntries(entries) };
  });
  return changed ? { ...document, configurations } : document;
}

export { createDefaultConfigurations } from './configurationDefaults.js';
