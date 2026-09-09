import type { Parameter } from '../parameters/types.js';
import type { Configuration } from './configurations.js';

/** 旧形式も空のパラメータ表も、式を保った既定の構成1つへ移行する。 */
export function createDefaultConfigurationsFromSources(values: Readonly<Record<string, string>>): readonly Configuration[] {
  return [{ id: 'configuration-1', name: '既定', values: { ...values } }];
}

export function createDefaultConfigurations(parameters: readonly Parameter[]): readonly Configuration[] {
  return createDefaultConfigurationsFromSources(Object.fromEntries(parameters.map((parameter) => [parameter.name, parameter.value.source])));
}
