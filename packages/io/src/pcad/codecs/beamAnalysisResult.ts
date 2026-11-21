import type {
  AnalysisSource, BeamAnalysisResult, BeamElementResult, BeamFrame, BeamNodeResult, Vector6,
} from '@pointercad/model/beam-analysis';
import {
  checkRecord, fieldProblem, indexPath, isFiniteNumber, isUnknownArray, joinPath, readBoolean,
  readLiteral, readNumber, readVec3, type Checked,
} from '../guards.js';
import { readList, readStringItem } from './fields.js';

// These are the static beam model's collection limits, checked before copying any rows.
const NODE_LIMIT = 256;
const ELEMENT_LIMIT = 512;
const OCCURRENCE_LIMIT = 32;

function exactRecord(value: unknown, path: string, keys: readonly string[]): Checked<Record<string, unknown>> {
  const record = checkRecord(value, path);
  if (!record.ok) return record;
  for (const key of keys) {
    if (!Object.hasOwn(record.value, key)) return fieldProblem(joinPath(path, key), 'missing');
  }
  for (const key of Object.keys(record.value)) {
    if (!keys.includes(key)) return fieldProblem(joinPath(path, key), 'type');
  }
  return record;
}

function readId(value: unknown, path: string): Checked<string> {
  const id = readStringItem(value, path);
  if (!id.ok) return id;
  const text = id.value;
  if (text.length === 0 || text.length > 256 || text.trim() !== text) return fieldProblem(path, 'type');
  for (const char of text) {
    if (char.charCodeAt(0) < 32) return fieldProblem(path, 'type');
  }
  return id;
}

function readIndex(record: Record<string, unknown>, key: string, path: string, minimum: number): Checked<number> {
  const found = readNumber(record, key, path);
  if (!found.ok) return found;
  return Number.isSafeInteger(found.value) && found.value >= minimum ? found : fieldProblem(joinPath(path, key), 'type');
}

function readSource(value: unknown, path: string): Checked<AnalysisSource> {
  const record = exactRecord(value, path, ['documentId', 'documentRevision', 'geometryRevision']);
  if (!record.ok) return record;
  const documentId = readId(record.value.documentId, joinPath(path, 'documentId'));
  if (!documentId.ok) return documentId;
  const documentRevision = readIndex(record.value, 'documentRevision', path, 0);
  if (!documentRevision.ok) return documentRevision;
  const geometryRevision = readId(record.value.geometryRevision, joinPath(path, 'geometryRevision'));
  if (!geometryRevision.ok) return geometryRevision;
  return { ok: true, value: {
    documentId: documentId.value, documentRevision: documentRevision.value, geometryRevision: geometryRevision.value,
  } };
}

function readNode(value: unknown, path: string): Checked<BeamNodeResult> {
  const record = exactRecord(value, path, ['nodeId', 'solverNode', 'displacementM', 'rotationRad', 'reactionN', 'reactionNm', 'constrained']);
  if (!record.ok) return record;
  const nodeId = readId(record.value.nodeId, joinPath(path, 'nodeId'));
  if (!nodeId.ok) return nodeId;
  const solverNode = readIndex(record.value, 'solverNode', path, 1);
  if (!solverNode.ok) return solverNode;
  const displacementM = readVec3(record.value, 'displacementM', path);
  if (!displacementM.ok) return displacementM;
  const rotationRad = readVec3(record.value, 'rotationRad', path);
  if (!rotationRad.ok) return rotationRad;
  const reactionN = readVec3(record.value, 'reactionN', path);
  if (!reactionN.ok) return reactionN;
  const reactionNm = readVec3(record.value, 'reactionNm', path);
  if (!reactionNm.ok) return reactionNm;
  const constrained = readBoolean(record.value, 'constrained', path);
  if (!constrained.ok) return constrained;
  return { ok: true, value: {
    nodeId: nodeId.value, solverNode: solverNode.value, displacementM: displacementM.value, rotationRad: rotationRad.value,
    reactionN: reactionN.value, reactionNm: reactionNm.value, constrained: constrained.value,
  } };
}

function readFrame(value: unknown, path: string): Checked<BeamFrame> {
  const record = exactRecord(value, path, ['x', 'y', 'z', 'lengthM']);
  if (!record.ok) return record;
  const x = readVec3(record.value, 'x', path);
  if (!x.ok) return x;
  const y = readVec3(record.value, 'y', path);
  if (!y.ok) return y;
  const z = readVec3(record.value, 'z', path);
  if (!z.ok) return z;
  const lengthM = readNumber(record.value, 'lengthM', path);
  if (!lengthM.ok) return lengthM;
  if (lengthM.value <= 0) return fieldProblem(joinPath(path, 'lengthM'), 'type');
  return { ok: true, value: { x: x.value, y: y.value, z: z.value, lengthM: lengthM.value } };
}

function readVector6(value: unknown, path: string): Checked<Vector6> {
  if (!isUnknownArray(value) || value.length !== 6) return fieldProblem(path, 'type');
  const [fx, fy, fz, mx, my, mz] = value;
  if (!isFiniteNumber(fx) || !isFiniteNumber(fy) || !isFiniteNumber(fz)
    || !isFiniteNumber(mx) || !isFiniteNumber(my) || !isFiniteNumber(mz)) return fieldProblem(path, 'type');
  return { ok: true, value: [fx, fy, fz, mx, my, mz] };
}

function readBoundedList<T>(
  record: Record<string, unknown>, key: string, path: string, minimum: number, maximum: number,
  readItem: (value: unknown, itemPath: string) => Checked<T>,
): Checked<readonly T[]> {
  const array = record[key];
  if (!isUnknownArray(array) || array.length < minimum || array.length > maximum) return fieldProblem(joinPath(path, key), 'type');
  return readList(record, key, path, readItem);
}

function readNodeIds(value: unknown, path: string): Checked<BeamElementResult['nodeIds']> {
  if (!isUnknownArray(value) || value.length !== 2) return fieldProblem(path, 'type');
  const [start, end] = value;
  if (typeof start !== 'string') return fieldProblem(indexPath(path, 0), 'type');
  if (typeof end !== 'string' || start === end) return fieldProblem(indexPath(path, 1), 'type');
  return { ok: true, value: [start, end] };
}

function readElement(value: unknown, path: string): Checked<BeamElementResult> {
  const record = exactRecord(value, path, ['memberId', 'componentId', 'occurrencePath', 'solverElement', 'nodeIds', 'frame', 'start', 'end']);
  if (!record.ok) return record;
  const memberId = readId(record.value.memberId, joinPath(path, 'memberId'));
  if (!memberId.ok) return memberId;
  const componentId = readId(record.value.componentId, joinPath(path, 'componentId'));
  if (!componentId.ok) return componentId;
  const occurrencePath = readBoundedList(record.value, 'occurrencePath', path, 1, OCCURRENCE_LIMIT, readId);
  if (!occurrencePath.ok) return occurrencePath;
  if (occurrencePath.value.at(-1) !== componentId.value) return fieldProblem(joinPath(path, 'occurrencePath'), 'type');
  const solverElement = readIndex(record.value, 'solverElement', path, 1);
  if (!solverElement.ok) return solverElement;
  const nodeIds = readNodeIds(record.value.nodeIds, joinPath(path, 'nodeIds'));
  if (!nodeIds.ok) return nodeIds;
  const frame = readFrame(record.value.frame, joinPath(path, 'frame'));
  if (!frame.ok) return frame;
  const start = readVector6(record.value.start, joinPath(path, 'start'));
  if (!start.ok) return start;
  const end = readVector6(record.value.end, joinPath(path, 'end'));
  if (!end.ok) return end;
  return { ok: true, value: {
    memberId: memberId.value, componentId: componentId.value, occurrencePath: occurrencePath.value,
    solverElement: solverElement.value, nodeIds: nodeIds.value, frame: frame.value, start: start.value, end: end.value,
  } };
}

function readBalance(value: unknown, path: string): Checked<BeamAnalysisResult['balance']> {
  const record = exactRecord(value, path, ['referenceM', 'forceN', 'momentNm', 'maximumFreeResidual']);
  if (!record.ok) return record;
  const referenceM = readVec3(record.value, 'referenceM', path);
  if (!referenceM.ok) return referenceM;
  const forceN = readVec3(record.value, 'forceN', path);
  if (!forceN.ok) return forceN;
  const momentNm = readVec3(record.value, 'momentNm', path);
  if (!momentNm.ok) return momentNm;
  const maximum = readNumber(record.value, 'maximumFreeResidual', path);
  if (!maximum.ok) return maximum;
  if (maximum.value < 0) return fieldProblem(joinPath(path, 'maximumFreeResidual'), 'type');
  return { ok: true, value: {
    referenceM: referenceM.value, forceN: forceN.value, momentNm: momentNm.value, maximumFreeResidual: maximum.value,
  } };
}

function readMesh(record: Record<string, unknown>, path: string): Checked<Pick<BeamAnalysisResult, 'nodes' | 'elements'>> {
  const nodes = readBoundedList(record, 'nodes', path, 2, NODE_LIMIT, readNode);
  if (!nodes.ok) return nodes;
  const nodeIds = new Set<string>();
  const solverNodes = new Set<number>();
  for (const [i, node] of nodes.value.entries()) {
    const row = indexPath(joinPath(path, 'nodes'), i);
    if (nodeIds.has(node.nodeId)) return fieldProblem(joinPath(row, 'nodeId'), 'type');
    if (solverNodes.has(node.solverNode)) return fieldProblem(joinPath(row, 'solverNode'), 'type');
    nodeIds.add(node.nodeId);
    solverNodes.add(node.solverNode);
  }
  const elements = readBoundedList(record, 'elements', path, 1, ELEMENT_LIMIT, readElement);
  if (!elements.ok) return elements;
  const memberIds = new Set<string>();
  const solverElements = new Set<number>();
  for (const [i, element] of elements.value.entries()) {
    const row = indexPath(joinPath(path, 'elements'), i);
    if (memberIds.has(element.memberId)) return fieldProblem(joinPath(row, 'memberId'), 'type');
    if (solverElements.has(element.solverElement)) return fieldProblem(joinPath(row, 'solverElement'), 'type');
    memberIds.add(element.memberId);
    solverElements.add(element.solverElement);
    for (const [end, id] of element.nodeIds.entries()) {
      if (!nodeIds.has(id)) return fieldProblem(indexPath(joinPath(row, 'nodeIds'), end), 'type');
    }
  }
  return { ok: true, value: { nodes: nodes.value, elements: elements.value } };
}

function readResult(value: unknown, path: string): Checked<BeamAnalysisResult> {
  const record = exactRecord(value, path, [
    'kind', 'model', 'analysisId', 'analysisRevision', 'source', 'inputSha256', 'nodes', 'elements', 'balance', 'structuralCertification',
  ]);
  if (!record.ok) return record;
  const kind = readLiteral(record.value, 'kind', path, ['oofem-linear-beam-3d'] as const);
  if (!kind.ok) return kind;
  const model = readLiteral(record.value, 'model', path, ['linear-timoshenko-isotropic'] as const);
  if (!model.ok) return model;
  const analysisId = readId(record.value.analysisId, joinPath(path, 'analysisId'));
  if (!analysisId.ok) return analysisId;
  const analysisRevision = readIndex(record.value, 'analysisRevision', path, 0);
  if (!analysisRevision.ok) return analysisRevision;
  const source = readSource(record.value.source, joinPath(path, 'source'));
  if (!source.ok) return source;
  const digest = record.value.inputSha256;
  if (typeof digest !== 'string' || digest.length !== 64 || !/^[0-9a-f]{64}$/u.test(digest)) {
    return fieldProblem(joinPath(path, 'inputSha256'), 'type');
  }
  if (record.value.structuralCertification !== false) return fieldProblem(joinPath(path, 'structuralCertification'), 'type');
  const mesh = readMesh(record.value, path);
  if (!mesh.ok) return mesh;
  const balance = readBalance(record.value.balance, joinPath(path, 'balance'));
  if (!balance.ok) return balance;
  return { ok: true, value: {
    kind: kind.value, model: model.value, analysisId: analysisId.value, analysisRevision: analysisRevision.value,
    source: source.value, inputSha256: digest, nodes: mesh.value.nodes, elements: mesh.value.elements,
    balance: balance.value, structuralCertification: false,
  } };
}

export function readBeamAnalysisResult(value: unknown, path: string): Checked<BeamAnalysisResult> {
  try {
    return readResult(value, path);
  } catch {
    // A non-JSON object can throw even when reading its own keys or array entries.
    return fieldProblem(path, 'type');
  }
}

export function serializeBeamAnalysisResult(result: BeamAnalysisResult): BeamAnalysisResult {
  const { kind, model, analysisId, analysisRevision, source, inputSha256, nodes, elements, balance, structuralCertification } = result;
  return {
    kind, model, analysisId, analysisRevision,
    source: { documentId: source.documentId, documentRevision: source.documentRevision, geometryRevision: source.geometryRevision },
    inputSha256,
    nodes: nodes.map((node): BeamNodeResult => ({
      nodeId: node.nodeId, solverNode: node.solverNode, displacementM: [...node.displacementM], rotationRad: [...node.rotationRad],
      reactionN: [...node.reactionN], reactionNm: [...node.reactionNm], constrained: node.constrained,
    })),
    elements: elements.map(({ memberId, componentId, occurrencePath, solverElement, nodeIds, frame, start, end }): BeamElementResult => ({
      memberId, componentId, occurrencePath: [...occurrencePath], solverElement, nodeIds: [...nodeIds],
      frame: { x: [...frame.x], y: [...frame.y], z: [...frame.z], lengthM: frame.lengthM }, start: [...start], end: [...end],
    })),
    balance: { referenceM: [...balance.referenceM], forceN: [...balance.forceN], momentNm: [...balance.momentNm],
      maximumFreeResidual: balance.maximumFreeResidual },
    structuralCertification,
  };
}
