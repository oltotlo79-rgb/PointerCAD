import {
  collectParameterUsages,
  expressionParameterNames,
  type PartDocument,
} from '@pointercad/model';

import type { ParameterRow } from './parameterCommands.js';

export type ParameterFilter = 'all' | 'unused' | 'circular' | 'referenced';

/** One distinct owner, even when several of its fields use the same parameter. */
export interface ParameterUsageSite {
  readonly kind: 'parameter' | 'sketchFeature' | 'constraint' | 'reference' | 'solid' | 'mathProblem' | 'configuration';
  readonly sketchId?: string;
  readonly sketchName?: string;
  readonly ownerId: string;
  readonly ownerName: string;
  readonly configurationId?: string;
  readonly configurationName?: string;
}

/** References are resolved by the expression AST, including stored math definitions. */
export function parameterUsageSites(document: PartDocument): ReadonlyMap<string, readonly ParameterUsageSite[]> {
  const result = new Map<string, ParameterUsageSite[]>();
  const seen = new Map<string, Set<string>>();
  for (const parameter of document.parameters) {
    result.set(parameter.name, []);
    seen.set(parameter.name, new Set());
  }
  const add = (names: readonly string[], site: ParameterUsageSite, key: string, self?: string): void => {
    for (const name of new Set(names)) {
      if (name === self || seen.get(name)?.has(key)) continue;
      const sites = result.get(name);
      if (sites === undefined) continue;
      sites.push(site);
      seen.get(name)?.add(key);
    }
  };
  for (const parameter of document.parameters) {
    const key = `parameter:${parameter.mathId ?? parameter.name}`;
    add(expressionParameterNames(parameter.value, document.parameters),
      { kind: 'parameter', ownerId: parameter.mathId ?? parameter.name, ownerName: parameter.name },
      key, parameter.name);
  }
  for (const owner of collectParameterUsages(document)) {
    const sketch = owner.sketchId === undefined ? undefined
      : document.sketches.find(item => item.id === owner.sketchId);
    add(expressionParameterNames(owner, document.parameters),
      { kind: owner.kind, ownerId: owner.ownerId, ownerName: owner.ownerName,
        ...(owner.sketchId === undefined ? {} : { sketchId: owner.sketchId }),
        ...(sketch === undefined ? {} : { sketchName: sketch.name }) },
      `${owner.kind}:${owner.sketchId ?? ''}:${owner.ownerId}`);
  }
  for (const configuration of document.configurations) {
    if (configuration.id === document.activeConfigurationId) continue;
    for (const [ownerName, source] of Object.entries(configuration.values)) {
      const mathDefinition = configuration.mathDefinitions?.[ownerName];
      add(expressionParameterNames({ source, ...(mathDefinition === undefined ? {} : { mathDefinition }) },
        document.parameters),
      { kind: 'configuration', ownerId: ownerName, ownerName,
        configurationId: configuration.id, configurationName: configuration.name },
      `configuration:${configuration.id}:${ownerName}`, ownerName);
    }
  }
  return result;
}

/** The query matches either original field. Query and status filter are combined with AND. */
export function filterParameterRows(
  rows: readonly ParameterRow[],
  query: string,
  filter: ParameterFilter,
  usages: ReadonlyMap<string, readonly ParameterUsageSite[]>,
): readonly ParameterRow[] {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter(row => {
    if (needle !== '' && !row.name.toLocaleLowerCase().includes(needle)
      && !row.description.toLocaleLowerCase().includes(needle)) return false;
    switch (filter) {
      case 'all': return true;
      case 'unused': return row.unused;
      case 'circular': return row.circular;
      case 'referenced': return (usages.get(row.name)?.length ?? 0) > 0;
    }
  });
}

/** React row keys follow immutable document snapshots through rename, Undo and configuration changes. */
export class ParameterRowIdentity {
  private documentId: string | null = null;
  private snapshots = new WeakMap<PartDocument, ReadonlyMap<string, string>>();
  private latest = new Map<string, string>();
  private byMathId = new Map<string, string>();
  private serial = 0;
  private rename: { readonly from: string; readonly to: string; readonly token: string } | null = null;

  token(document: PartDocument, name: string): string {
    if (this.documentId !== document.id) {
      this.documentId = document.id;
      this.snapshots = new WeakMap();
      this.latest = new Map();
      this.byMathId = new Map();
      this.rename = null;
      this.serial = 0;
    }
    let byName = this.snapshots.get(document);
    if (byName === undefined) {
      const next = new Map<string, string>();
      for (const parameter of document.parameters) {
        const pending = this.rename;
        const renamed = pending !== null && pending.to === parameter.name
          && !document.parameters.some(current => current.name === pending.from)
          ? pending.token : undefined;
        const reused = this.latest.get(parameter.name);
        const token = renamed ?? reused ?? (parameter.mathId === undefined ? undefined : this.byMathId.get(parameter.mathId))
          ?? (parameter.mathId === undefined
            ? `row:${document.id}:${++this.serial}` : `math:${document.id}:${parameter.mathId}`);
        next.set(parameter.name, token);
        if (parameter.mathId !== undefined) this.byMathId.set(parameter.mathId, token);
      }
      byName = next;
      this.snapshots.set(document, byName);
      this.latest = next;
      if (this.rename !== null && next.get(this.rename.to) === this.rename.token) this.rename = null;
    }
    this.latest = new Map(byName);
    return byName.get(name) ?? `missing:${name}`;
  }

  beginRename(document: PartDocument, from: string, to: string): void {
    const token = this.token(document, from);
    this.rename = document.parameters.some(parameter => parameter.name === to) ? null : { from, to, token };
  }

  cancelRename(): void { this.rename = null; }
}
