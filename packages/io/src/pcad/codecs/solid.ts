/** 部品 JSON: 立体フィーチャーの振り分け。documentJson.ts への逆向きの依存を持たない。 */
import { readSheetBaseFeature, readSheetFlangeFeature, readSheetBendFeature, readSheetReliefFeature, serializeSheetMetalFeature } from './sheetMetal.js';

import {
  type Checked,
  checkRecord,
  readLiteral,
} from '../guards.js';
import {
  readSolidFeatureBase,
} from './solidBase.js';
import {
  readBooleanFeature,
  readExtrudeFeature,
  readRevolveFeature,
  readSewFeature,
  serializeBooleanFeature,
  serializeExtrudeFeature,
  serializeRevolveFeature,
  serializeSewFeature,
} from './solidBasic.js';
import {
  readHoleFeature,
  readThreadHoleFeature,
  readThreadShaftFeature,
  serializeHoleFeature,
  serializeThreadHoleFeature,
  serializeThreadShaftFeature,
} from './solidHoles.js';
import {
  readImportedMeshFeature,
  readImportedSolidFeature,
  serializeImportedMeshFeature,
  serializeImportedSolidFeature,
} from './solidImported.js';
import {
  readChamferFeature,
  readCutFeature,
  readDraftFeature,
  readFilletFeature,
  readShellFeature,
  serializeChamferFeature,
  serializeCutFeature,
  serializeDraftFeature,
  serializeFilletFeature,
  serializeShellFeature,
} from './solidModify.js';
import {
  readPrimitiveFeature,
  readSpringFeature,
  serializePrimitiveFeature,
  serializeSpringFeature,
} from './solidPrimitives.js';
import {
  readEmbossFeature,
  readLoftFeature,
  readRibFeature,
  readRuledFeature,
  readSweepFeature,
  serializeEmbossFeature,
  serializeLoftFeature,
  serializeRibFeature,
  serializeRuledFeature,
  serializeSweepFeature,
} from './solidProfiles.js';
import {
  readSurfaceFeature,
  serializeSurfaceFeature,
} from './solidSurface.js';
import {
  readMirrorFeature,
  readPatternFeature,
  readScaleFeature,
  readTransformFeature,
  serializeMirrorFeature,
  serializePatternFeature,
  serializeScaleFeature,
  serializeTransformFeature,
} from './solidTransforms.js';
import {
  SOLID_FEATURE_KINDS,
  type SolidFeature,
} from '@pointercad/model';

export function serializeSolidFeature(feature: SolidFeature): SolidFeature {
  switch (feature.kind) {
    case 'sheetBase': case 'sheetFlange': case 'sheetBend': case 'sheetRelief': return serializeSheetMetalFeature(feature);
    case 'extrude': return serializeExtrudeFeature(feature);
    case 'revolve': return serializeRevolveFeature(feature);
    case 'sew': return serializeSewFeature(feature);
    case 'boolean': return serializeBooleanFeature(feature);
    case 'hole': return serializeHoleFeature(feature);
    case 'threadHole': return serializeThreadHoleFeature(feature);
    case 'fillet': return serializeFilletFeature(feature);
    case 'chamfer': return serializeChamferFeature(feature);
    case 'pattern': return serializePatternFeature(feature);
    case 'spring': return serializeSpringFeature(feature);
    case 'primitive': return serializePrimitiveFeature(feature);
    case 'ruled': return serializeRuledFeature(feature);
    case 'loft': return serializeLoftFeature(feature);
    case 'draft': return serializeDraftFeature(feature);
    case 'mirror': return serializeMirrorFeature(feature);
    case 'transform': return serializeTransformFeature(feature);
    case 'scale': return serializeScaleFeature(feature);
    case 'sweep': return serializeSweepFeature(feature);
    case 'rib': return serializeRibFeature(feature);
    case 'emboss': return serializeEmbossFeature(feature);
    case 'threadShaft': return serializeThreadShaftFeature(feature);
    case 'surface': return serializeSurfaceFeature(feature);
    case 'shell': return serializeShellFeature(feature);
    case 'cut': return serializeCutFeature(feature);
    case 'importedSolid': return serializeImportedSolidFeature(feature);
    case 'importedMesh': return serializeImportedMeshFeature(feature);
  }
}

export function readSolidFeature(value: unknown, path: string): Checked<SolidFeature> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const kind = readLiteral(record.value, 'kind', path, SOLID_FEATURE_KINDS);
  if (!kind.ok) {
    return kind;
  }
  const base = readSolidFeatureBase(record.value, path);
  if (!base.ok) {
    return base;
  }
  switch (kind.value) {
    case 'sheetBase': return readSheetBaseFeature(record.value, path, base.value);
    case 'sheetFlange': return readSheetFlangeFeature(record.value, path, base.value);
    case 'sheetBend': return readSheetBendFeature(record.value, path, base.value);
    case 'sheetRelief': return readSheetReliefFeature(record.value, path, base.value);
    case 'extrude':
      return readExtrudeFeature(record.value, path, base.value);
    case 'revolve':
      return readRevolveFeature(record.value, path, base.value);
    case 'sew':
      return readSewFeature(record.value, path, base.value);
    case 'boolean':
      return readBooleanFeature(record.value, path, base.value);
    case 'hole':
      return readHoleFeature(record.value, path, base.value);
    case 'threadHole':
      return readThreadHoleFeature(record.value, path, base.value);
    case 'fillet':
      return readFilletFeature(record.value, path, base.value);
    case 'chamfer':
      return readChamferFeature(record.value, path, base.value);
    case 'pattern':
      return readPatternFeature(record.value, path, base.value);
    case 'spring':
      return readSpringFeature(record.value, path, base.value);
    case 'primitive':
      return readPrimitiveFeature(record.value, path, base.value);
    case 'ruled':
      return readRuledFeature(record.value, path, base.value);
    case 'loft':
      return readLoftFeature(record.value, path, base.value);
    // P5 の Should 群 9 種(§2.11、タスク43)。
    case 'draft':
      return readDraftFeature(record.value, path, base.value);
    case 'mirror':
      return readMirrorFeature(record.value, path, base.value);
    case 'transform':
      return readTransformFeature(record.value, path, base.value);
    case 'scale':
      return readScaleFeature(record.value, path, base.value);
    case 'sweep':
      return readSweepFeature(record.value, path, base.value);
    case 'rib':
      return readRibFeature(record.value, path, base.value);
    case 'emboss':
      return readEmbossFeature(record.value, path, base.value);
    case 'threadShaft':
      return readThreadShaftFeature(record.value, path, base.value);
    case 'surface':
      return readSurfaceFeature(record.value, path, base.value);
    // P5 の Could 群のうちタスク46 が前倒しした 1 種(FR-418)。
    case 'shell':
      return readShellFeature(record.value, path, base.value);
    // 平面による切断(FR-432、§2.9b、タスク27c)。
    case 'cut':
      return readCutFeature(record.value, path, base.value);
    // 読み込んだ形のベースボディ 2 種(FR-802、P6 §2.8、タスク20)。
    case 'importedSolid':
      return readImportedSolidFeature(record.value, path, base.value);
    case 'importedMesh':
      return readImportedMeshFeature(record.value, path, base.value);
  }
}
