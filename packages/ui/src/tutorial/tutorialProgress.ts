import { nextFeatureId, nextSolidId, type PartDocument } from '@pointercad/model';

export const TUTORIAL_STEPS = ['point', 'outline', 'face', 'extrude', 'hole', 'save', 'complete'] as const;
export type TutorialStep = typeof TUTORIAL_STEPS[number];
/** Only the guide's ownership is kept here. Geometry and Undo remain in the ordinary document. */
export interface TutorialSession {
  readonly documentId: string;
  readonly documentVersion: number;
  readonly sketchId: string;
  readonly pointId: string;
  readonly outlineId: string;
  readonly faceId: string;
  readonly extrudeId: string;
  readonly holeId: string;
  readonly paused: boolean;
}

export function createTutorialSession(document: PartDocument, documentVersion: number): TutorialSession | null {
  const sketch = document.sketches.find(item => item.id === document.activeSketchId);
  if (sketch === undefined || document.sketches.some(item => item.features.length > 0)
      || document.solids.length > 0 || document.references.length > 0) return null;
  return { documentId: document.id, documentVersion, sketchId: sketch.id,
    pointId: nextFeatureId(sketch, 'point'), outlineId: nextFeatureId(sketch, 'rectangle'),
    faceId: nextFeatureId(sketch, 'face'), extrudeId: nextSolidId(document, 'extrude'),
    holeId: nextSolidId(document, 'hole'), paused: false };
}

/** Every step is re-derived: Undo/deletion cannot leave a stale completion checkmark. */
export function tutorialStep(session: TutorialSession, document: PartDocument,
  documentVersion: number, saved: PartDocument | null): TutorialStep | 'differentDocument' {
  if (document.id !== session.documentId || documentVersion !== session.documentVersion
      || document.activeSketchId !== session.sketchId) return 'differentDocument';
  const sketch = document.sketches.find(item => item.id === session.sketchId);
  if (sketch === undefined) return 'differentDocument';
  if (!sketch.features.some(item => item.id === session.pointId && item.kind === 'point')) return 'point';
  if (!sketch.features.some(item => item.id === session.outlineId && item.kind === 'rectangle')) return 'outline';
  const face = sketch.features.find(item => item.id === session.faceId);
  if (face?.kind !== 'face' || face.boundary.length !== 1
      || face.boundary[0].featureId !== session.outlineId || face.boundary[0].index !== undefined) return 'face';
  const extrude = document.solids.find(item => item.id === session.extrudeId);
  if (extrude?.kind !== 'extrude' || extrude.suppressed || extrude.profile.sketchId !== session.sketchId
      || extrude.profile.faceFeatureId !== session.faceId) return 'extrude';
  const hole = document.solids.find(item => item.id === session.holeId);
  if (hole?.kind !== 'hole' || hole.suppressed || hole.targetFeatureId !== session.extrudeId
      || !hole.centers.some(item => item.sketchId === session.sketchId && item.pointFeatureId === session.pointId)) return 'hole';
  return saved === document ? 'complete' : 'save';
}
