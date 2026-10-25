/**
 * Dragging the section view handle (FR-111, P6 task 35, §0.42; R07).
 *
 * Responsibility: only the display offset of the section view. The document and Undo never change;
 * the offset is written to the display state while moving. The grab is bound to the document it
 * started on, and a replaced document ends it. Pointer capture belongs to the caller.
 */
import { addVec3, scaleVec3, type Vec3 } from '@pointercad/model';
import type { ProjectToScreen } from '../sketch/snapMath.js';
import { closestParameterToRay } from '../sketch/trackMath.js';
import { resolveCutPlane } from '../solid/cutCommands.js';
import { useAppStore } from '../store/useAppStore.js';
import type { ViewportScene } from './createViewportScene.js';

/**
 * Screen radius (px) around the arrow root (the centre of the cut plane) that grabs the handle.
 * Wider than the 6 px sub-shape pick because the handle overlaps solid faces (NFR-UX-7).
 */
const SECTION_HANDLE_PICK_RADIUS_PIXELS = 18;

export interface SectionHandleDrag {
  readonly active: () => boolean;
  readonly ownsDocument: (document: object) => boolean;
  /** Grabs the handle under the pointer; false leaves the press to the other inputs. */
  readonly begin: (pointer: readonly [number, number]) => boolean;
  /** Moves the offset to the point of the normal axis closest to the pointer ray. */
  readonly move: (pointer: readonly [number, number]) => void;
  /** Forgets the grab. The offset already shown stays; nothing else changes. */
  readonly end: () => void;
}

export function createSectionHandleDrag(
  scene: Pick<ViewportScene, 'pointerRay'>,
  project: ProjectToScreen,
): SectionHandleDrag {
  /**
   * The plane at the moment of the grab, so the handle keeps moving along the grabbed axis; `delta`
   * keeps the handle from jumping under the pointer.
   */
  let grab: { readonly origin: Vec3; readonly normal: Vec3; readonly delta: number } | null = null;
  let grabDocument: object | null = null;

  return {
    active: () => grab !== null,
    ownsDocument: (document) => document === grabDocument,
    begin: (pointer) => {
      const state = useAppStore.getState();
      const section = state.sectionView;
      if (section === null) {
        return false;
      }
      const plane = resolveCutPlane(section.plane);
      if (plane === null) {
        return false;
      }
      // The handle is drawn at the offset position (the same formula as ViewportCanvas).
      const handleOrigin = addVec3(plane.origin, scaleVec3(plane.normal, section.offsetMm));
      const screen = project(handleOrigin);
      if (screen === null) {
        return false;
      }
      const distance = Math.hypot(screen[0] - pointer[0], screen[1] - pointer[1]);
      if (distance > SECTION_HANDLE_PICK_RADIUS_PIXELS) {
        return false;
      }
      const ray = scene.pointerRay(pointer[0], pointer[1]);
      const grabbed = ray === null ? null : closestParameterToRay({ origin: plane.origin, direction: plane.normal }, ray);
      grab = {
        origin: plane.origin,
        normal: plane.normal,
        // Without a ray (nothing drawn yet) the grab starts without an offset.
        delta: grabbed === null ? 0 : section.offsetMm - grabbed,
      };
      grabDocument = state.document;
      return true;
    },
    /**
     * Uses the same projection onto an axis as tracking (`closestParameterToRay`). The normal is a
     * unit vector, so the parameter is in mm. When the view is parallel to the normal the parameter
     * is undefined and the handle does not move (NFR-UX-7).
     */
    move: (pointer) => {
      if (grab === null) {
        return;
      }
      const ray = scene.pointerRay(pointer[0], pointer[1]);
      if (ray === null) {
        return;
      }
      const parameter = closestParameterToRay({ origin: grab.origin, direction: grab.normal }, ray);
      if (parameter === null) {
        return;
      }
      useAppStore.getState().setSectionOffset(parameter + grab.delta);
    },
    end: () => {
      grab = null;
      grabDocument = null;
    },
  };
}
