import type { AssemblyComponent, JointOccurrenceConnection } from '@pointercad/model';
import {
  checkRecord, fieldProblem, indexPath, isUnknownArray, joinPath, readArray, readLiteral,
  type Checked,
} from '../guards.js';

const KINDS: readonly JointOccurrenceConnection['kind'][] = ['bolt', 'weld'];

function readPath(value: unknown, path: string): Checked<readonly [string, ...string[]]> {
  if (!isUnknownArray(value)) return fieldProblem(path, 'type');
  const first = value[0];
  if (typeof first !== 'string' || first.length === 0) return fieldProblem(path, 'type');
  const rest: string[] = [];
  for (const item of value.slice(1)) {
    if (typeof item !== 'string' || item.length === 0) return fieldProblem(path, 'type');
    rest.push(item);
  }
  return { ok: true, value: [first, ...rest] };
}

/** Paths are arrays of exact IDs; punctuation is never interpreted as a delimiter.
 * Nested bodies are not embedded in document.json, so deeper resolution belongs
 * to the model resolver. This admission checks ownership available in this file.
 */
export function readJointOccurrenceConnections(
  value: unknown, components: readonly AssemblyComponent[], path: string,
): Checked<readonly JointOccurrenceConnection[]> {
  if (!isUnknownArray(value)) return fieldProblem(path, 'type');
  const connections: JointOccurrenceConnection[] = [];
  const seenConnections = new Set<string>();
  const seenGenerated = new Set<string>();
  for (const [index, item] of value.entries()) {
    const itemPath = indexPath(path, index);
    const record = checkRecord(item, itemPath);
    if (!record.ok) return record;
    const kind = readLiteral(record.value, 'kind', itemPath, KINDS);
    if (!kind.ok) return kind;
    const first = readPath(record.value['firstPath'], joinPath(itemPath, 'firstPath'));
    if (!first.ok) return first;
    const second = readPath(record.value['secondPath'], joinPath(itemPath, 'secondPath'));
    if (!second.ok) return second;
    for (const endpoint of [first.value, second.value]) {
      const owners = components.filter(component => component.id === endpoint[0]);
      const owner = owners[0];
      if (owners.length !== 1 || owner === undefined
          || (endpoint.length > 1 && owner.source.kind !== 'subAssembly')) {
        return fieldProblem(itemPath, 'type');
      }
    }
    const firstKey = JSON.stringify(first.value), secondKey = JSON.stringify(second.value);
    if (firstKey === secondKey) return fieldProblem(itemPath, 'type');
    const generated = readArray(record.value, 'componentIds', itemPath);
    if (!generated.ok) return generated;
    if (generated.value.length === 0) return fieldProblem(joinPath(itemPath, 'componentIds'), 'type');
    const componentIds: string[] = [];
    for (const id of generated.value) {
      if (typeof id !== 'string' || id.length === 0 || seenGenerated.has(id)
          || id === first.value[0] || id === second.value[0]) return fieldProblem(itemPath, 'type');
      const matches = components.filter(component => component.id === id);
      if (matches.length !== 1 || matches[0]?.source.kind !== 'standardPart') {
        return fieldProblem(itemPath, 'type');
      }
      seenGenerated.add(id);
      componentIds.push(id);
    }
    const key = JSON.stringify([kind.value, ...[firstKey, secondKey].sort(), [...componentIds].sort()]);
    if (seenConnections.has(key)) return fieldProblem(itemPath, 'type');
    seenConnections.add(key);
    connections.push({ kind: kind.value, firstPath: first.value, secondPath: second.value, componentIds });
  }
  return { ok: true, value: connections };
}

export function serializeJointOccurrenceConnections(
  connections: readonly JointOccurrenceConnection[], components: readonly AssemblyComponent[],
): readonly JointOccurrenceConnection[] {
  const checked = readJointOccurrenceConnections(connections, components, 'document.jointOccurrenceConnections');
  if (!checked.ok) throw new RangeError(`Invalid joint occurrence provenance: ${checked.problem.path}`);
  // Reconstruct only durable fields, excluding transient selection/geometry references.
  return checked.value.map((connection): JointOccurrenceConnection => ({ kind: connection.kind,
    firstPath: [...connection.firstPath], secondPath: [...connection.secondPath],
    componentIds: [...connection.componentIds] }));
}
