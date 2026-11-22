import {
  createPaperFrame, DEFAULT_TITLE_BLOCK_HEIGHT_MM, paperSizeOf, THIRD_ANGLE_DIRECTIONS, thirdAngleLayout,
  type DimensionTarget, type DrawingDocument, type DrawingView, type Vector3,
} from '@pointercad/drawing';
import { emptyEmbeddedPartAttachments } from '../assembly/partLibrary.js';
import {
  appendDrawingView, createDrawingDocument, nextDrawingDimensionId, nextDrawingTableId, nextDrawingViewId,
} from '../drawing/createDrawingDocument.js';
import { drawingModelPointToPaper } from '../drawing/dimensionTarget.js';
import { embedDrawingSource, emptyDrawingSourceLibrary } from '../drawing/sourceLibrary.js';
import { addParameter } from '../parameters/parameterTable.js';
import { synchronizeConfigurations } from '../part/configurations.js';
import { findSolid, replaceSolid } from '../part/createPartDocument.js';
import type { PartDocument } from '../part/types.js';
import type { DrawingExample } from './drawingExample.js';
import { flangeExample } from './flange.js';

function flangeWithParameters(): PartDocument {
  const part = flangeExample.create();
  const pattern = part.solids.find(feature => feature.kind === 'pattern');
  if (pattern?.placement.kind !== 'circular') throw new Error('Missing circular hole pattern');
  const hole = findSolid(part, pattern.sourceFeatureId);
  if (hole?.kind !== 'hole') throw new Error('Missing pattern seed hole');

  const diameter = { name: 'boltDia', value: hole.diameter, unit: 'mm', description: '' } as const;
  const count = { name: 'boltCount', value: pattern.placement.count, unit: 'none', description: '' } as const;
  const parameters = addParameter(addParameter(part.parameters, diameter), count);
  const drilled = replaceSolid(part, hole.id, { ...hole, diameter: { ...diameter.value, source: diameter.name } });
  const patterned = replaceSolid(drilled, pattern.id, { ...pattern, placement: { ...pattern.placement,
    count: { ...count.value, source: count.name } } });
  return synchronizeConfigurations({ ...patterned, parameters });
}

/** The original lathe profile gives the model points for the envelope dimensions. */
function flangeEnvelope(part: PartDocument) {
  const rectangle = part.sketches[0].features.find(feature => feature.kind === 'rectangle');
  const chamfer = part.solids.find(feature => feature.kind === 'chamfer');
  if (rectangle?.corner2.mode !== 'absolute' || chamfer?.size.kind !== 'equal') throw new Error('Missing flange profile');
  return { radius: rectangle.corner2.x.value, height: rectangle.corner2.z.value, chamfer: chamfer.size.distance.value };
}

function addEnvelopeDimension(document: DrawingDocument, front: DrawingView, center: Vector3,
  measurement: 'horizontal' | 'vertical', points: readonly [Vector3, Vector3], normalCoordinate: number): DrawingDocument {
  const targets = points.map((modelPoint): DimensionTarget => {
    const paperPoint = drawingModelPointToPaper(modelPoint, front, document.sheet.scale, { modelCenter: center, instances: [] });
    if (paperPoint === null) throw new Error('Invalid front view');
    return { kind: 'point', viewId: front.id, modelPoint, paperPoint };
  });
  return { ...document, dimensions: [...document.dimensions, {
    id: nextDrawingDimensionId(document), kind: 'length', measurement, targets,
    placement: { commonNormalCoordinate: normalCoordinate, textPosition: null },
    origin: 'manual', reference: false, layerId: 'layer-4',
  }] };
}

async function createFlangeDrawing() {
  const part = flangeWithParameters();
  const { radius, height, chamfer } = flangeEnvelope(part);
  const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(),
    { sourceKind: 'part', document: part, attachments: emptyEmbeddedPartAttachments() }, `${flangeExample.id}.pcad`, '');
  let document = createDrawingDocument(part.name, embedded.source);
  const paper = paperSizeOf(document.sheet.paperSizeId);
  if (paper === undefined) throw new Error('Missing drawing paper');
  const frame = createPaperFrame(paper).inner;
  const layout = thirdAngleLayout({ extents: [2 * radius, 2 * radius, height], scale: document.sheet.scale, gap: 30,
    sheet: { ...frame, bottom: frame.bottom + DEFAULT_TITLE_BLOCK_HEIGHT_MM, frontCenter: [110, 105] } });
  for (const kind of ['front', 'top', 'right'] as const) {
    const direction = THIRD_ANGLE_DIRECTIONS[kind];
    const named = part.namedViews.find(view => view.id === `namedView-${kind}`);
    document = appendDrawingView(document, { id: nextDrawingViewId(document), kind, name: named?.name ?? kind,
      direction: direction.normal, xDir: direction.xDir, position: layout[kind], scale: null,
      showHidden: true, showCenterLines: true, layerId: 'layer-1' });
  }

  const front = document.views[0];
  const center: Vector3 = [0, 0, height / 2];
  document = addEnvelopeDimension(document, front, center, 'horizontal',
    [[-radius, 0, height], [radius, 0, height]], front.position[1] + height / 2 + 10);
  document = addEnvelopeDimension(document, front, center, 'vertical',
    [[-radius + chamfer, 0, 0], [-radius, 0, height]], -(front.position[0] - radius - 12));
  // Parameter tables are a v24 drawing feature. Their rows come from the embedded part at display time.
  document = { ...document, schemaVersion: Math.max(document.schemaVersion, 24), tables: [{
    id: nextDrawingTableId(document), kind: 'parameter', columns: ['name', 'value', 'unit', 'description'],
    options: { scope: 'all' }, position: [230, 240], layerId: 'layer-7',
  }] };
  return { document, library: embedded.library };
}

export const flangeDrawingExample: DrawingExample = { id: 'flangeDrawing', create: createFlangeDrawing };
