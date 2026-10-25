/** Saved origin-v1 only. Current addresses and native history never enter this codec. */
import type { ProfileLineAnchor, ProfileRegionAnchor, SubShapeOrigin, PointProducerAnchor, PointPlacementSourceAnchor, CopyPointPlacementRole, HolePlacementRole } from '@pointercad/model';
import { checkRecord, fieldProblem, indexPath, isUnknownArray, joinPath, readLiteral, readString, readBoolean,
  type Checked } from '../guards.js';

type Face = Extract<SubShapeOrigin, { readonly shapeKind: 'face' }>['identity'];
type Edge = Extract<SubShapeOrigin, { readonly shapeKind: 'edge' }>['identity'];
type Vertex = Extract<SubShapeOrigin, { readonly shapeKind: 'vertex' }>['identity'];
const FACE_ROLES = ['bottom', 'top', 'front', 'back', 'left', 'right'] as const;
const EDGE_ROLES = ['bottom-front', 'bottom-back', 'bottom-left', 'bottom-right',
  'top-front', 'top-back', 'top-left', 'top-right', 'front-left', 'front-right',
  'back-left', 'back-right'] as const;
const VERTEX_ROLES = ['bottom-front-left', 'bottom-front-right', 'bottom-back-left',
  'bottom-back-right', 'top-front-left', 'top-front-right', 'top-back-left',
  'top-back-right'] as const;
const CYLINDER_FACE_ROLES = ['side', 'start', 'end'] as const;
const CYLINDER_EDGE_ROLES = ['start-ring', 'end-ring', 'seam'] as const;
const CYLINDER_VERTEX_ROLES = ['seam-start', 'seam-end'] as const;

function bounded(value: unknown): boolean {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const walk = (item: unknown, depth: number): boolean => {
    if (depth > 16 || ++nodes > 128) return false;
    if (typeof item === 'string') return item.length <= 256;
    if (typeof item === 'number') return Number.isFinite(item);
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item !== 'object' || seen.has(item)) return false;
    seen.add(item);
    const entries = isUnknownArray(item) ? item : Object.values(item);
    if (isUnknownArray(item) && item.length > 32) return false;
    for (const entry of entries) if (!walk(entry, depth + 1)) return false;
    seen.delete(item);
    return true;
  };
  try {
    return walk(value, 1) && new TextEncoder().encode(JSON.stringify(value)).length <= 64 * 1024;
  } catch {
    return false;
  }
}

function exact(value: Record<string, unknown>, path: string, keys: readonly string[]): Checked<void> {
  const extra = Object.keys(value).find(key => !keys.includes(key));
  return extra === undefined ? { ok: true, value: undefined } : fieldProblem(joinPath(path, extra), 'type');
}
function id(value: Record<string, unknown>, key: string, path: string): Checked<string> {
  const result = readString(value, key, path);
  if (!result.ok) return result;
  return result.value.length > 0 && result.value.length <= 256
    && [...result.value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    ? result : fieldProblem(joinPath(path, key), 'type');
}
function list<T>(value: unknown, path: string, min: number,
  read: (item: unknown, location: string) => Checked<T>): Checked<readonly T[]> {
  if (!isUnknownArray(value) || value.length < min || value.length > 32) return fieldProblem(path, 'type');
  const result: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = read(value[index], indexPath(path, index));
    if (!item.ok) return item;
    result.push(item.value);
  }
  return { ok: true, value: result };
}
function lineAnchor(value: unknown, path: string): Checked<ProfileLineAnchor> {
  const record = checkRecord(value, path);
  if (!record.ok) return record;
  const fields = exact(record.value, path, ['sketchId', 'faceFeatureId', 'lineFeatureId', 'role']);
  if (!fields.ok) return fields;
  const sketchId = id(record.value, 'sketchId', path), faceFeatureId = id(record.value, 'faceFeatureId', path);
  const lineFeatureId = id(record.value, 'lineFeatureId', path);
  const role = readLiteral(record.value, 'role', path, ['whole-line']);
  if (!sketchId.ok) return sketchId;
  if (!faceFeatureId.ok) return faceFeatureId;
  if (!lineFeatureId.ok) return lineFeatureId;
  if (!role.ok) return role;
  return { ok: true, value: { sketchId: sketchId.value, faceFeatureId: faceFeatureId.value,
    lineFeatureId: lineFeatureId.value, role: role.value } };
}
function regionAnchor(value: unknown, path: string): Checked<ProfileRegionAnchor> {
  const record = checkRecord(value, path);
  if (!record.ok) return record;
  const fields = exact(record.value, path, ['sketchId', 'faceFeatureId', 'lineFeatureIds']);
  if (!fields.ok) return fields;
  const sketchId = id(record.value, 'sketchId', path), faceFeatureId = id(record.value, 'faceFeatureId', path);
  const lines = list(record.value['lineFeatureIds'], joinPath(path, 'lineFeatureIds'), 3,
    (item, location) => id({ value: item }, 'value', location));
  if (!sketchId.ok) return sketchId;
  if (!faceFeatureId.ok) return faceFeatureId;
  if (!lines.ok) return lines;
  const [first, second, third, ...rest] = lines.value;
  if (first === undefined || second === undefined || third === undefined
    || new Set(lines.value).size !== lines.value.length) return fieldProblem(joinPath(path, 'lineFeatureIds'), 'type');
  return { ok: true, value: { sketchId: sketchId.value, faceFeatureId: faceFeatureId.value,
    lineFeatureIds: [first, second, third, ...rest] } };
}
function integer(record: Record<string, unknown>, key: string, path: string, min = 0): Checked<number> {
  const value = record[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min
    ? { ok: true, value } : fieldProblem(joinPath(path, key), 'type');
}
function fraction(record: Record<string, unknown>, path: string, allowEnd: boolean): Checked<{ numerator: number; denominator: number }> {
  const numerator = integer(record, 'numerator', path), denominator = integer(record, 'denominator', path, 1);
  if (!numerator.ok) return numerator;
  if (!denominator.ok) return denominator;
  let a = numerator.value, b = denominator.value;
  while (b !== 0) { const remainder = a % b; a = b; b = remainder; }
  if (a !== 1 || (allowEnd ? numerator.value > denominator.value : numerator.value >= denominator.value)) {
    return fieldProblem(path, 'type');
  }
  return { ok: true, value: { numerator: numerator.value, denominator: denominator.value } };
}
function copyPlacement(value: unknown, path: string): Checked<CopyPointPlacementRole> {
  const checked = checkRecord(value, path);
  if (!checked.ok) return checked;
  const record = checked.value;
  const kind = readLiteral(record, 'kind', path, ['mirror', 'translate', 'linear', 'circular']);
  if (!kind.ok) return kind;
  switch (kind.value) {
    case 'mirror': case 'translate': {
      const fields = exact(record, path, ['kind']);
      return fields.ok ? { ok: true, value: { kind: kind.value } } : fields;
    }
    case 'linear': {
      const fields = exact(record, path, ['kind', 'step']);
      if (!fields.ok) return fields;
      const step = integer(record, 'step', path, 1);
      return step.ok ? { ok: true, value: { kind: 'linear', step: step.value } } : step;
    }
    case 'circular': {
      const fields = exact(record, path, ['kind', 'fullCircle', 'numerator', 'denominator']);
      if (!fields.ok) return fields;
      const fullCircle = readBoolean(record, 'fullCircle', path);
      if (!fullCircle.ok) return fullCircle;
      const ratio = fraction(record, path, !fullCircle.value);
      return ratio.ok ? { ok: true, value: { kind: 'circular', fullCircle: fullCircle.value, ...ratio.value } } : ratio;
    }
  }
}
function pointProducer(value: unknown, path: string): Checked<PointProducerAnchor> {
  const checked = checkRecord(value, path);
  if (!checked.ok) return checked;
  const record = checked.value;
  const kind = readLiteral(record, 'kind', path, ['point', 'linear-point', 'grid-point', 'circular-point', 'copied-point']);
  if (!kind.ok) return kind;
  const featureId = id(record, 'featureId', path);
  if (!featureId.ok) return featureId;
  switch (kind.value) {
    case 'point': {
      const fields = exact(record, path, ['kind', 'featureId']);
      return fields.ok ? { ok: true, value: { kind: 'point', featureId: featureId.value } } : fields;
    }
    case 'linear-point': {
      const fields = exact(record, path, ['kind', 'featureId', 'step']);
      if (!fields.ok) return fields;
      const step = integer(record, 'step', path);
      return step.ok ? { ok: true, value: { kind: 'linear-point', featureId: featureId.value, step: step.value } } : step;
    }
    case 'grid-point': {
      const fields = exact(record, path, ['kind', 'featureId', 'row', 'column']);
      if (!fields.ok) return fields;
      const row = integer(record, 'row', path), column = integer(record, 'column', path);
      if (!row.ok) return row;
      return column.ok ? { ok: true, value: { kind: 'grid-point', featureId: featureId.value, row: row.value, column: column.value } } : column;
    }
    case 'circular-point': {
      const fields = exact(record, path, ['kind', 'featureId', 'numerator', 'denominator']);
      if (!fields.ok) return fields;
      const ratio = fraction(record, path, false);
      return ratio.ok ? { ok: true, value: { kind: 'circular-point', featureId: featureId.value, ...ratio.value } } : ratio;
    }
    case 'copied-point': {
      const fields = exact(record, path, ['kind', 'featureId', 'source', 'placement']);
      if (!fields.ok) return fields;
      const source = pointProducer(record['source'], joinPath(path, 'source'));
      if (!source.ok) return source;
      const placement = copyPlacement(record['placement'], joinPath(path, 'placement'));
      return placement.ok ? { ok: true, value: { kind: 'copied-point', featureId: featureId.value, source: source.value, placement: placement.value } } : placement;
    }
  }
}
function pointPlacementSource(value: unknown, path: string): Checked<PointPlacementSourceAnchor> {
  const checked = checkRecord(value, path);
  if (!checked.ok) return checked;
  const record = checked.value;
  const kind = readLiteral(record, 'kind', path, ['origin', 'sketch-point', 'reference-point', 'curve-vertex', 'semantic-subshape', 'sphere-grid']);
  if (!kind.ok) return kind;
  switch (kind.value) {
    case 'origin': {
      const fields = exact(record, path, ['kind']);
      return fields.ok ? { ok: true, value: { kind: 'origin' } } : fields;
    }
    case 'sketch-point': {
      const fields = exact(record, path, ['kind', 'anchor']);
      if (!fields.ok) return fields;
      const anchor = checkRecord(record['anchor'], joinPath(path, 'anchor'));
      if (!anchor.ok) return anchor;
      const anchorFields = exact(anchor.value, joinPath(path, 'anchor'), ['sketchId', 'producer']);
      if (!anchorFields.ok) return anchorFields;
      const sketchId = id(anchor.value, 'sketchId', joinPath(path, 'anchor'));
      if (!sketchId.ok) return sketchId;
      const producer = pointProducer(anchor.value['producer'], joinPath(path, 'anchor.producer'));
      return producer.ok ? { ok: true, value: { kind: 'sketch-point', anchor: { sketchId: sketchId.value, producer: producer.value } } } : producer;
    }
    case 'reference-point': {
      const fields = exact(record, path, ['kind', 'featureId']);
      if (!fields.ok) return fields;
      const featureId = id(record, 'featureId', path);
      return featureId.ok ? { ok: true, value: { kind: 'reference-point', featureId: featureId.value } } : featureId;
    }
    case 'curve-vertex': {
      const fields = exact(record, path, ['kind', 'sketchId', 'featureId', 'vertex']);
      if (!fields.ok) return fields;
      const sketchId = id(record, 'sketchId', path), featureId = id(record, 'featureId', path);
      if (!sketchId.ok) return sketchId;
      if (!featureId.ok) return featureId;
      const vertex = readLiteral(record, 'vertex', path, ['start', 'end', 'center']);
      return vertex.ok ? { ok: true, value: { kind: 'curve-vertex', sketchId: sketchId.value, featureId: featureId.value, vertex: vertex.value } } : vertex;
    }
    case 'semantic-subshape': {
      const fields = exact(record, path, ['kind', 'bodyFeatureId', 'origin']);
      if (!fields.ok) return fields;
      const bodyFeatureId = id(record, 'bodyFeatureId', path);
      if (!bodyFeatureId.ok) return bodyFeatureId;
      const origin = readSubShapeOrigin(record['origin'], joinPath(path, 'origin'));
      return origin.ok ? { ok: true, value: { kind: 'semantic-subshape', bodyFeatureId: bodyFeatureId.value, origin: origin.value } } : origin;
    }
    case 'sphere-grid': {
      const fields = exact(record, path, ['kind', 'featureId', 'latitudeSource', 'longitudeSource',
        'latitudeMathDefinition', 'longitudeMathDefinition']);
      if (!fields.ok) return fields;
      const featureId = id(record, 'featureId', path);
      if (!featureId.ok) return featureId;
      const latitudeSource = readString(record, 'latitudeSource', path);
      if (!latitudeSource.ok) return latitudeSource;
      const longitudeSource = readString(record, 'longitudeSource', path);
      if (!longitudeSource.ok) return longitudeSource;
      const latitudeMathDefinition = record['latitudeMathDefinition'];
      const longitudeMathDefinition = record['longitudeMathDefinition'];
      if ((latitudeMathDefinition !== undefined && typeof latitudeMathDefinition !== 'string')
        || (longitudeMathDefinition !== undefined && typeof longitudeMathDefinition !== 'string')) return fieldProblem(path, 'type');
      return { ok: true, value: { kind: 'sphere-grid', featureId: featureId.value,
        latitudeSource: latitudeSource.value, longitudeSource: longitudeSource.value,
        ...(latitudeMathDefinition === undefined ? {} : { latitudeMathDefinition }),
        ...(longitudeMathDefinition === undefined ? {} : { longitudeMathDefinition }) } };
    }
  }
}
function holePlacement(value: unknown, path: string): Checked<HolePlacementRole> {
  const checked = checkRecord(value, path);
  if (!checked.ok) return checked;
  const record = checked.value;
  if (record['kind'] === 'original') {
    const fields = exact(record, path, ['kind']);
    return fields.ok ? { ok: true, value: { kind: 'original' } } : fields;
  }
  if (record['kind'] === 'point-slot') {
    const fields = exact(record, path, ['kind', 'slotId', 'source']);
    if (!fields.ok) return fields;
    const slotId = id(record, 'slotId', path);
    if (!slotId.ok) return slotId;
    const serial = /^slot-([1-9][0-9]*)$/.exec(slotId.value);
    if (serial === null || !Number.isSafeInteger(Number(serial[1]))) return fieldProblem(joinPath(path, 'slotId'), 'type');
    const source = pointPlacementSource(record['source'], joinPath(path, 'source'));
    return source.ok ? { ok: true, value: { kind: 'point-slot', slotId: slotId.value, source: source.value } } : source;
  }
  if (record['kind'] === 'linear') {
    const fields = exact(record, path, ['kind', 'step']);
    if (!fields.ok) return fields;
    const step = record['step'];
    return typeof step === 'number' && Number.isSafeInteger(step) && step !== 0
      ? { ok: true, value: { kind: 'linear', step } } : fieldProblem(joinPath(path, 'step'), 'type');
  }
  const placement = copyPlacement(record, path);
  if (!placement.ok) return placement;
  return placement.value.kind === 'circular' ? { ok: true, value: placement.value } : fieldProblem(path, 'type');
}
function face(value: unknown, path: string): Checked<Face> {
  const checked = checkRecord(value, path);
  if (!checked.ok) return checked;
  const record = checked.value, kind = readLiteral(record, 'kind', path,
    ['box-face', 'cylinder-face', 'sphere-face', 'cone-face', 'torus-face', 'surface-side', 'extrude-side', 'extrude-cap', 'extrude-curve-side', 'extrude-curve-cap', 'blend-face', 'merged-face', 'hole-face']);
  if (!kind.ok) return kind;
  const featureId = id(record, 'featureId', path);
  if (!featureId.ok) return featureId;
  switch (kind.value) {
    case 'hole-face': {
      const fields = exact(record, path, ['kind', 'featureId', 'center', 'placement', 'stage', 'role']);
      if (!fields.ok) return fields;
      const center = checkRecord(record['center'], joinPath(path, 'center'));
      if (!center.ok) return center;
      const centerFields = exact(center.value, joinPath(path, 'center'), ['sketchId', 'producer']);
      if (!centerFields.ok) return centerFields;
      const sketchId = id(center.value, 'sketchId', joinPath(path, 'center'));
      if (!sketchId.ok) return sketchId;
      const producer = pointProducer(center.value['producer'], joinPath(path, 'center.producer'));
      if (!producer.ok) return producer;
      const placement = holePlacement(record['placement'], joinPath(path, 'placement'));
      if (!placement.ok) return placement;
      const stage = readLiteral(record, 'stage', path, ['bore', 'counterbore', 'countersink', 'thread']);
      if (!stage.ok) return stage;
      // The thread stage is saved only with the groove role; the old stages never take it.
      if (stage.value === 'thread') {
        const groove = readLiteral(record, 'role', path, ['groove']);
        return groove.ok ? { ok: true, value: { kind: 'hole-face', featureId: featureId.value,
          center: { sketchId: sketchId.value, producer: producer.value }, placement: placement.value,
          stage: 'thread', role: groove.value } } : groove;
      }
      const role = readLiteral(record, 'role', path, ['wall', 'floor', 'entry-cap']);
      return role.ok ? { ok: true, value: { kind: 'hole-face', featureId: featureId.value,
        center: { sketchId: sketchId.value, producer: producer.value }, placement: placement.value,
        stage: stage.value, role: role.value } } : role;
    }
    case 'box-face': {
      const fields = exact(record, path, ['kind', 'featureId', 'role']);
      if (!fields.ok) return fields;
      const role = readLiteral(record, 'role', path, FACE_ROLES);
      return role.ok ? { ok: true, value: { kind: 'box-face', featureId: featureId.value, role: role.value } } : role;
    }
    case 'cylinder-face': {
      const fields = exact(record, path, ['kind', 'featureId', 'role']);
      if (!fields.ok) return fields;
      const role = readLiteral(record, 'role', path, CYLINDER_FACE_ROLES);
      return role.ok ? { ok: true, value: { kind: 'cylinder-face', featureId: featureId.value, role: role.value } } : role;
    }
    case 'sphere-face': {
      const fields = exact(record, path, ['kind', 'featureId', 'role']);
      if (!fields.ok) return fields;
      const role = readLiteral(record, 'role', path, ['surface']);
      return role.ok ? { ok: true, value: { kind: 'sphere-face', featureId: featureId.value, role: role.value } } : role;
    }
    case 'cone-face': {
      const fields = exact(record, path, ['kind', 'featureId', 'role']);
      if (!fields.ok) return fields;
      const role = readLiteral(record, 'role', path, ['side', 'start', 'end']);
      return role.ok ? { ok: true, value: { kind: 'cone-face', featureId: featureId.value, role: role.value } } : role;
    }
    case 'torus-face': {
      const fields = exact(record, path, ['kind', 'featureId', 'role']);
      if (!fields.ok) return fields;
      const role = readLiteral(record, 'role', path, ['surface']);
      return role.ok ? { ok: true, value: { kind: 'torus-face', featureId: featureId.value, role: role.value } } : role;
    }
    case 'extrude-curve-side': {
      const fields = exact(record, path, ['kind', 'featureId', 'profile']);
      if (!fields.ok) return fields;
      const location = joinPath(path, 'profile'), checkedProfile = checkRecord(record['profile'], location);
      if (!checkedProfile.ok) return checkedProfile;
      const profile = checkedProfile.value;
      const profileFields = exact(profile, location, ['sketchId', 'faceFeatureId', 'curveFeatureId', 'role']);
      if (!profileFields.ok) return profileFields;
      const sketchId = id(profile, 'sketchId', location), faceFeatureId = id(profile, 'faceFeatureId', location);
      const curveFeatureId = id(profile, 'curveFeatureId', location);
      const role = readLiteral(profile, 'role', location, ['whole-curve']);
      if (!sketchId.ok) return sketchId;
      if (!faceFeatureId.ok) return faceFeatureId;
      if (!curveFeatureId.ok) return curveFeatureId;
      if (!role.ok) return role;
      return { ok: true, value: { kind: 'extrude-curve-side', featureId: featureId.value,
        profile: { sketchId: sketchId.value, faceFeatureId: faceFeatureId.value,
          curveFeatureId: curveFeatureId.value, role: role.value } } };
    }
    case 'extrude-curve-cap': {
      const fields = exact(record, path, ['kind', 'featureId', 'end', 'profile']);
      if (!fields.ok) return fields;
      const end = readLiteral(record, 'end', path, ['start', 'end']);
      if (!end.ok) return end;
      const location = joinPath(path, 'profile'), checkedProfile = checkRecord(record['profile'], location);
      if (!checkedProfile.ok) return checkedProfile;
      const profile = checkedProfile.value;
      const profileFields = exact(profile, location, ['sketchId', 'faceFeatureId', 'curveFeatureIds']);
      if (!profileFields.ok) return profileFields;
      const sketchId = id(profile, 'sketchId', location), faceFeatureId = id(profile, 'faceFeatureId', location);
      const ids = list(profile['curveFeatureIds'], joinPath(location, 'curveFeatureIds'), 3,
        (item, at) => id({ value: item }, 'value', at));
      if (!sketchId.ok) return sketchId;
      if (!faceFeatureId.ok) return faceFeatureId;
      if (!ids.ok) return ids;
      const [first, second, third, ...rest] = ids.value;
      if (first === undefined || second === undefined || third === undefined
        || new Set(ids.value).size !== ids.value.length) return fieldProblem(location, 'type');
      return { ok: true, value: { kind: 'extrude-curve-cap', featureId: featureId.value, end: end.value,
        profile: { sketchId: sketchId.value, faceFeatureId: faceFeatureId.value,
          curveFeatureIds: [first, second, third, ...rest] } } };
    }
    case 'surface-side': {
      const fields = exact(record, path, ['kind', 'featureId', 'profile']);
      if (!fields.ok) return fields;
      const profilePath = joinPath(path, 'profile');
      const profile = checkRecord(record['profile'], profilePath);
      if (!profile.ok) return profile;
      const profileFields = exact(profile.value, profilePath, ['sketchId', 'lineFeatureId', 'role']);
      if (!profileFields.ok) return profileFields;
      const sketchId = id(profile.value, 'sketchId', profilePath);
      if (!sketchId.ok) return sketchId;
      const lineFeatureId = id(profile.value, 'lineFeatureId', profilePath);
      if (!lineFeatureId.ok) return lineFeatureId;
      const role = readLiteral(profile.value, 'role', profilePath, ['whole-line']);
      return role.ok ? { ok: true, value: { kind: 'surface-side', featureId: featureId.value,
        profile: { sketchId: sketchId.value, lineFeatureId: lineFeatureId.value, role: role.value } } } : role;
    }
    case 'extrude-side': {
      const fields = exact(record, path, ['kind', 'featureId', 'profile']);
      if (!fields.ok) return fields;
      const profile = lineAnchor(record['profile'], joinPath(path, 'profile'));
      return profile.ok ? { ok: true, value: { kind: 'extrude-side', featureId: featureId.value, profile: profile.value } } : profile;
    }
    case 'extrude-cap': {
      const fields = exact(record, path, ['kind', 'featureId', 'end', 'profile']);
      if (!fields.ok) return fields;
      const end = readLiteral(record, 'end', path, ['start', 'end']);
      if (!end.ok) return end;
      const profile = regionAnchor(record['profile'], joinPath(path, 'profile'));
      return profile.ok ? { ok: true, value: { kind: 'extrude-cap', featureId: featureId.value,
        end: end.value, profile: profile.value } } : profile;
    }
    case 'blend-face': {
      const fields = exact(record, path, ['kind', 'featureId', 'operation', 'source']);
      if (!fields.ok) return fields;
      const operation = readLiteral(record, 'operation', path, ['fillet', 'chamfer']);
      if (!operation.ok) return operation;
      const source = edge(record['source'], joinPath(path, 'source'));
      return source.ok ? { ok: true, value: { kind: 'blend-face', featureId: featureId.value,
        operation: operation.value, source: source.value } } : source;
    }
    case 'merged-face': {
      const fields = exact(record, path, ['kind', 'featureId', 'sources']);
      if (!fields.ok) return fields;
      const sources = list(record['sources'], joinPath(path, 'sources'), 2, face);
      if (!sources.ok) return sources;
      const [first, second, ...rest] = sources.value;
      return first === undefined || second === undefined ? fieldProblem(joinPath(path, 'sources'), 'type')
        : { ok: true, value: { kind: 'merged-face', featureId: featureId.value, sources: [first, second, ...rest] } };
    }
  }
}
function edge(value: unknown, path: string): Checked<Edge> {
  const checked = checkRecord(value, path);
  if (!checked.ok) return checked;
  const record = checked.value, kind = readLiteral(record, 'kind', path,
    ['box-edge', 'cylinder-edge', 'face-intersection-edge', 'merged-edge']);
  if (!kind.ok) return kind;
  const featureId = id(record, 'featureId', path);
  if (!featureId.ok) return featureId;
  switch (kind.value) {
    case 'box-edge': {
      const fields = exact(record, path, ['kind', 'featureId', 'role']);
      if (!fields.ok) return fields;
      const role = readLiteral(record, 'role', path, EDGE_ROLES);
      return role.ok ? { ok: true, value: { kind: 'box-edge', featureId: featureId.value, role: role.value } } : role;
    }
    case 'cylinder-edge': {
      const fields = exact(record, path, ['kind', 'featureId', 'role']);
      if (!fields.ok) return fields;
      const role = readLiteral(record, 'role', path, CYLINDER_EDGE_ROLES);
      return role.ok ? { ok: true, value: { kind: 'cylinder-edge', featureId: featureId.value, role: role.value } } : role;
    }
    case 'face-intersection-edge': {
      const fields = exact(record, path, ['kind', 'featureId', 'faces']);
      if (!fields.ok) return fields;
      const faces = list(record['faces'], joinPath(path, 'faces'), 2, face);
      if (!faces.ok || faces.value.length !== 2) return faces.ok ? fieldProblem(joinPath(path, 'faces'), 'type') : faces;
      const [first, second] = faces.value;
      return first === undefined || second === undefined ? fieldProblem(joinPath(path, 'faces'), 'type')
        : { ok: true, value: { kind: 'face-intersection-edge', featureId: featureId.value, faces: [first, second] } };
    }
    case 'merged-edge': {
      const fields = exact(record, path, ['kind', 'featureId', 'sources']);
      if (!fields.ok) return fields;
      const sources = list(record['sources'], joinPath(path, 'sources'), 2, edge);
      if (!sources.ok) return sources;
      const [first, second, ...rest] = sources.value;
      return first === undefined || second === undefined ? fieldProblem(joinPath(path, 'sources'), 'type')
        : { ok: true, value: { kind: 'merged-edge', featureId: featureId.value, sources: [first, second, ...rest] } };
    }
  }
}
function vertex(value: unknown, path: string): Checked<Vertex> {
  const checked = checkRecord(value, path);
  if (!checked.ok) return checked;
  const record = checked.value, kind = readLiteral(record, 'kind', path,
    ['box-vertex', 'cylinder-vertex', 'face-intersection-vertex', 'merged-vertex']);
  if (!kind.ok) return kind;
  const featureId = id(record, 'featureId', path);
  if (!featureId.ok) return featureId;
  switch (kind.value) {
    case 'box-vertex': {
      const fields = exact(record, path, ['kind', 'featureId', 'role']);
      if (!fields.ok) return fields;
      const role = readLiteral(record, 'role', path, VERTEX_ROLES);
      return role.ok ? { ok: true, value: { kind: 'box-vertex', featureId: featureId.value, role: role.value } } : role;
    }
    case 'cylinder-vertex': {
      const fields = exact(record, path, ['kind', 'featureId', 'role']);
      if (!fields.ok) return fields;
      const role = readLiteral(record, 'role', path, CYLINDER_VERTEX_ROLES);
      return role.ok ? { ok: true, value: { kind: 'cylinder-vertex', featureId: featureId.value, role: role.value } } : role;
    }
    case 'face-intersection-vertex': {
      const fields = exact(record, path, ['kind', 'featureId', 'faces']);
      if (!fields.ok) return fields;
      const faces = list(record['faces'], joinPath(path, 'faces'), 3, face);
      if (!faces.ok || faces.value.length !== 3) return faces.ok ? fieldProblem(joinPath(path, 'faces'), 'type') : faces;
      const [first, second, third] = faces.value;
      return first === undefined || second === undefined || third === undefined
        ? fieldProblem(joinPath(path, 'faces'), 'type')
        : { ok: true, value: { kind: 'face-intersection-vertex', featureId: featureId.value,
          faces: [first, second, third] } };
    }
    case 'merged-vertex': {
      const fields = exact(record, path, ['kind', 'featureId', 'sources']);
      if (!fields.ok) return fields;
      const sources = list(record['sources'], joinPath(path, 'sources'), 2, vertex);
      if (!sources.ok) return sources;
      const [first, second, ...rest] = sources.value;
      return first === undefined || second === undefined ? fieldProblem(joinPath(path, 'sources'), 'type')
        : { ok: true, value: { kind: 'merged-vertex', featureId: featureId.value, sources: [first, second, ...rest] } };
    }
  }
}

export function readSubShapeOrigin(value: unknown, path: string): Checked<SubShapeOrigin> {
  if (!bounded(value)) return fieldProblem(path, 'type');
  const checked = checkRecord(value, path);
  if (!checked.ok) return checked;
  const record = checked.value, fields = exact(record, path, ['version', 'shapeKind', 'identity']);
  if (!fields.ok) return fields;
  if (record['version'] !== 1) return fieldProblem(joinPath(path, 'version'), 'type');
  const kind = readLiteral(record, 'shapeKind', path, ['face', 'edge', 'vertex']);
  if (!kind.ok) return kind;
  const identityPath = joinPath(path, 'identity');
  switch (kind.value) {
    case 'face': {
      const identity = face(record['identity'], identityPath);
      return identity.ok ? { ok: true, value: { version: 1, shapeKind: 'face', identity: identity.value } } : identity;
    }
    case 'edge': {
      const identity = edge(record['identity'], identityPath);
      return identity.ok ? { ok: true, value: { version: 1, shapeKind: 'edge', identity: identity.value } } : identity;
    }
    case 'vertex': {
      const identity = vertex(record['identity'], identityPath);
      return identity.ok ? { ok: true, value: { version: 1, shapeKind: 'vertex', identity: identity.value } } : identity;
    }
  }
}
export function isSubShapeOrigin(value: unknown): value is SubShapeOrigin {
  return readSubShapeOrigin(value, 'origin').ok;
}
export function serializeSubShapeOrigin(value: SubShapeOrigin): SubShapeOrigin {
  const parsed = readSubShapeOrigin(value, 'origin');
  if (!parsed.ok) throw new RangeError(`Invalid subshape origin at ${parsed.problem.path}`);
  return parsed.value;
}
