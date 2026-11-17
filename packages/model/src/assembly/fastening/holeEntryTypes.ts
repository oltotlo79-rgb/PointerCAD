/** Derived entry geometry and extension results. None of these fields are saved in a joint record. */
import type { Placement } from '../types.js';
import type { StandardPartSource } from '../resolveAssembly.js';
import type { BoltedJointPlan, BoltedJointRejection, BoltedJointRequest, FasteningHoleSelection } from './types.js';

export type FastenerHeadKind = 'hex' | 'socket' | 'countersunk';

export type FasteningHoleEntry =
  | { readonly kind: 'counterbore'; readonly diameter: number; readonly depth: number; readonly side: 'outer' | 'mating' }
  | { readonly kind: 'countersink'; readonly diameter: number; readonly depth: number; readonly angle: number;
      readonly side: 'outer' | 'mating' };

export interface EntryHoleSelection extends FasteningHoleSelection {
  readonly entry?: FasteningHoleEntry;
}

export type FasteningExtensionCode = 'counterboreTooSmall' | 'countersinkMismatch' | 'entryOnFarSide' | 'holeCountMismatch';

export interface FasteningExtensionRejection {
  readonly code: FasteningExtensionCode;
  readonly detail: BoltedJointRejection['detail'];
}

export interface EntryBoltedJointRequest extends BoltedJointRequest {
  readonly first: EntryHoleSelection;
  readonly second: EntryHoleSelection;
}

/** The legacy plan holds washers/nut and alignment; the catalog bolt is separate from the legacy operation union. */
export interface EntryBoltedJointPlan {
  readonly joint: BoltedJointPlan;
  readonly headKind: FastenerHeadKind;
  /** Preview identity only: a changed recess must be rebound and previewed even if the same head still fits. */
  readonly entry?: FasteningHoleEntry;
  readonly bolt?: { readonly source: StandardPartSource; readonly placement: Placement };
}

export type EntryBoltedJointResult =
  | { readonly ok: true; readonly plan: EntryBoltedJointPlan }
  | { readonly ok: false; readonly rejections: readonly BoltedJointRejection[];
      readonly entryRejections: readonly FasteningExtensionRejection[] };
