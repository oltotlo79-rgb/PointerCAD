import { evaluateDocumentMath, type DocumentMathContext } from './evaluateDocumentMath.js';
import { configurationParameters } from './configurationExpressions.js';
import { prepareConfigurationCreation, type Configuration, type ConfigurationChange } from './configurations.js';
import type { PartDocument } from './types.js';

/** Validate the candidate in private. The UI publishes one document only after this succeeds and remains current. */
async function evaluateConfiguration(document: PartDocument, configuration: Configuration, context: DocumentMathContext): Promise<ConfigurationChange> {
  const names = new Set(document.parameters.map(parameter => parameter.name));
  if (Object.keys(configuration.values).some(name => !names.has(name))) return { ok: false, reason: 'unknownParameter' };
  if (document.parameters.some(parameter => !Object.hasOwn(configuration.values, parameter.name))) return { ok: false, reason: 'missingParameter' };
  if (Object.keys(configuration.mathDefinitions ?? {}).some(name => !names.has(name))) return { ok: false, reason: 'unknownParameter' };
  const next = { ...document, activeConfigurationId: configuration.id, parameters: configurationParameters(document.parameters, configuration) };
  const result = await evaluateDocumentMath(next, context);
  if (!result.ok) return { ok: false, reason: 'invalidExpression', parameter: result.failures[0]?.ownerId };
  return { ok: true, document: result.document };
}

export async function activateMathConfiguration(document: PartDocument, id: string, context: DocumentMathContext): Promise<ConfigurationChange> {
  const configuration = document.configurations.find(entry => entry.id === id);
  if (configuration === undefined) return { ok: false, reason: 'notFound' };
  return evaluateConfiguration(document, configuration, context);
}

export async function createMathConfiguration(document: PartDocument, name: string, context: DocumentMathContext,
  overrides: Readonly<Record<string, string>> = {}): Promise<ConfigurationChange> {
  const prepared = prepareConfigurationCreation(document, name, overrides);
  if (!prepared.ok) return prepared;
  const next = { ...document, configurations: [...document.configurations, prepared.configuration] };
  const checked = await evaluateConfiguration(next, prepared.configuration, context);
  if (!checked.ok) return checked;
  return document.activeConfigurationId === null ? checked : { ok: true, document: next };
}

export async function deleteMathConfiguration(document: PartDocument, id: string, context: DocumentMathContext): Promise<ConfigurationChange> {
  if (!document.configurations.some(entry => entry.id === id)) return { ok: false, reason: 'notFound' };
  const configurations = document.configurations.filter(entry => entry.id !== id), next = { ...document, configurations };
  if (document.activeConfigurationId !== id) return { ok: true, document: next };
  if (configurations.length === 0) return { ok: true, document: { ...next, activeConfigurationId: null } };
  return evaluateConfiguration(next, configurations[0], context);
}
