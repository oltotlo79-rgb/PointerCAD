import type {
  AssemblyComponent, BoltedJointRecord, BoltedJointRecordedPick, BoltedJointUserChoices, FastenerDimensionSeries,
  FasteningWasherKind, ThreadSeries,
} from '@pointercad/model';
import {
  checkRecord, fieldProblem, indexPath, isUnknownArray, joinPath, readArray, readLiteral, readNumber, readString,
  type Checked,
} from '../guards.js';
import { readSubShapeRef, serializeSubShapeRef } from './shapeReferences.js';

/*
 * Flat bolted-joint records (EX-06 edit): the user's picks and choices and the generated part ids. Inputs only; the
 * planner recomputes sizes, lengths and placements from the current parts and catalogue. Readers that do not know this
 * field ignore it (the joint still exists; only editing is unavailable), so no schema bump is needed.
 */

const DIMENSION_SERIES: readonly FastenerDimensionSeries[] = ['main', 'annexJA'];
const THREAD_SERIES: readonly ThreadSeries[] = ['coarse', 'fine'];
const WASHERS: readonly FasteningWasherKind[] = ['plainWasher', 'springWasher'];

function readPick(value: unknown, path: string): Checked<BoltedJointRecordedPick> {
  const record = checkRecord(value, path);
  if (!record.ok) return record;
  const componentId = readString(record.value, 'componentId', path);
  if (!componentId.ok) return componentId;
  const holeFeatureId = readString(record.value, 'holeFeatureId', path);
  if (!holeFeatureId.ok) return holeFeatureId;
  const holeFace = readSubShapeRef(record.value['holeFace'], joinPath(path, 'holeFace'));
  if (!holeFace.ok) return holeFace;
  const matingFace = readSubShapeRef(record.value['matingFace'], joinPath(path, 'matingFace'));
  if (!matingFace.ok) return matingFace;
  if (componentId.value === '' || holeFeatureId.value === '') return fieldProblem(path, 'type');
  return { ok: true, value: { componentId: componentId.value, holeFeatureId: holeFeatureId.value,
    holeFace: holeFace.value, matingFace: matingFace.value } };
}

function readWashers(source: Record<string, unknown>, key: string, path: string): Checked<readonly FasteningWasherKind[]> {
  const list = readArray(source, key, path);
  if (!list.ok) return list;
  const out: FasteningWasherKind[] = [];
  for (const item of list.value) {
    const found = WASHERS.find((kind) => kind === item);
    if (found === undefined) return fieldProblem(joinPath(path, key), 'type');
    out.push(found);
  }
  return { ok: true, value: out };
}

/** Optional finite number: absent means "not given" (the planner then asks for it with its own reason). */
function readOptionalMeasure(source: Record<string, unknown>, key: string, path: string): Checked<number | undefined> {
  if (!Object.hasOwn(source, key)) return { ok: true, value: undefined };
  const value = readNumber(source, key, path);
  if (!value.ok) return value;
  return value.value < 0 ? fieldProblem(joinPath(path, key), 'type') : value;
}

function readChoices(value: unknown, path: string): Checked<BoltedJointUserChoices> {
  const record = checkRecord(value, path);
  if (!record.ok) return record;
  const dimensionSeries = readLiteral(record.value, 'dimensionSeries', path, DIMENSION_SERIES);
  if (!dimensionSeries.ok) return dimensionSeries;
  let explicitBolt: BoltedJointUserChoices['explicitBolt'];
  if (Object.hasOwn(record.value, 'explicitBolt')) {
    const bolt = checkRecord(record.value['explicitBolt'], joinPath(path, 'explicitBolt'));
    if (!bolt.ok) return bolt;
    const nominal = readString(bolt.value, 'nominal', joinPath(path, 'explicitBolt'));
    if (!nominal.ok) return nominal;
    const threadSeries = readLiteral(bolt.value, 'threadSeries', joinPath(path, 'explicitBolt'), THREAD_SERIES);
    if (!threadSeries.ok) return threadSeries;
    explicitBolt = { nominal: nominal.value, threadSeries: threadSeries.value };
  }
  const engagement = readOptionalMeasure(record.value, 'engagement', path);
  if (!engagement.ok) return engagement;
  const blindBottomClearance = readOptionalMeasure(record.value, 'blindBottomClearance', path);
  if (!blindBottomClearance.ok) return blindBottomClearance;
  const minimumProtrusion = readOptionalMeasure(record.value, 'minimumProtrusion', path);
  if (!minimumProtrusion.ok) return minimumProtrusion;
  const headWashers = readWashers(record.value, 'headWashers', path);
  if (!headWashers.ok) return headWashers;
  const nutWashers = readWashers(record.value, 'nutWashers', path);
  if (!nutWashers.ok) return nutWashers;
  return { ok: true, value: {
    dimensionSeries: dimensionSeries.value,
    ...(explicitBolt === undefined ? {} : { explicitBolt }),
    ...(engagement.value === undefined ? {} : { engagement: engagement.value }),
    ...(blindBottomClearance.value === undefined ? {} : { blindBottomClearance: blindBottomClearance.value }),
    ...(minimumProtrusion.value === undefined ? {} : { minimumProtrusion: minimumProtrusion.value }),
    headWashers: headWashers.value, nutWashers: nutWashers.value,
  } };
}

/**
 * Each record must name two different existing plates and at least one existing standard part that no other record
 * (and neither plate) claims. Record ids are unique.
 */
export function readBoltedJointRecords(
  value: unknown, components: readonly AssemblyComponent[], path: string,
): Checked<readonly BoltedJointRecord[]> {
  if (!isUnknownArray(value)) return fieldProblem(path, 'type');
  const records: BoltedJointRecord[] = [];
  const seenIds = new Set<string>();
  const seenGenerated = new Set<string>();
  const one = (id: string) => components.filter((component) => component.id === id);
  for (const [index, item] of value.entries()) {
    const itemPath = indexPath(path, index);
    const record = checkRecord(item, itemPath);
    if (!record.ok) return record;
    const id = readString(record.value, 'id', itemPath);
    if (!id.ok) return id;
    if (id.value === '' || seenIds.has(id.value)) return fieldProblem(joinPath(itemPath, 'id'), 'type');
    const first = readPick(record.value['first'], joinPath(itemPath, 'first'));
    if (!first.ok) return first;
    const second = readPick(record.value['second'], joinPath(itemPath, 'second'));
    if (!second.ok) return second;
    if (first.value.componentId === second.value.componentId
        || one(first.value.componentId).length !== 1 || one(second.value.componentId).length !== 1) {
      return fieldProblem(itemPath, 'type');
    }
    const choices = readChoices(record.value['choices'], joinPath(itemPath, 'choices'));
    if (!choices.ok) return choices;
    const generated = readArray(record.value, 'componentIds', itemPath);
    if (!generated.ok) return generated;
    if (generated.value.length === 0) return fieldProblem(joinPath(itemPath, 'componentIds'), 'type');
    const componentIds: string[] = [];
    for (const part of generated.value) {
      if (typeof part !== 'string' || part === '' || seenGenerated.has(part)
          || part === first.value.componentId || part === second.value.componentId) return fieldProblem(itemPath, 'type');
      const matches = one(part);
      if (matches.length !== 1 || matches[0]?.source.kind !== 'standardPart') return fieldProblem(itemPath, 'type');
      seenGenerated.add(part);
      componentIds.push(part);
    }
    seenIds.add(id.value);
    records.push({ id: id.value, first: first.value, second: second.value, choices: choices.value, componentIds });
  }
  return { ok: true, value: records };
}

function serializePick(pick: BoltedJointRecordedPick): BoltedJointRecordedPick {
  return { componentId: pick.componentId, holeFeatureId: pick.holeFeatureId,
    holeFace: serializeSubShapeRef(pick.holeFace), matingFace: serializeSubShapeRef(pick.matingFace) };
}

export function serializeBoltedJointRecords(
  records: readonly BoltedJointRecord[], components: readonly AssemblyComponent[],
): readonly BoltedJointRecord[] {
  const checked = readBoltedJointRecords(records, components, 'document.boltedJoints');
  if (!checked.ok) throw new RangeError(`Invalid bolted joint record: ${checked.problem.path}`);
  return checked.value.map((record): BoltedJointRecord => ({ id: record.id, first: serializePick(record.first),
    second: serializePick(record.second), choices: {
      dimensionSeries: record.choices.dimensionSeries,
      ...(record.choices.explicitBolt === undefined ? {} : { explicitBolt: { ...record.choices.explicitBolt } }),
      ...(record.choices.engagement === undefined ? {} : { engagement: record.choices.engagement }),
      ...(record.choices.blindBottomClearance === undefined ? {} : { blindBottomClearance: record.choices.blindBottomClearance }),
      ...(record.choices.minimumProtrusion === undefined ? {} : { minimumProtrusion: record.choices.minimumProtrusion }),
      headWashers: [...record.choices.headWashers], nutWashers: [...record.choices.nutWashers],
    }, componentIds: [...record.componentIds] }));
}
