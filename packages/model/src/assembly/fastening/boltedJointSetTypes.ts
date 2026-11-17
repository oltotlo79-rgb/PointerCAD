/** Atomic multi-hole planning. Indices retain the caller's order, including every rejected pair. */
import type { AssemblyDocument } from '../types.js';
import type { FasteningHolePick } from './bindHoleSelection.js';
import type { BoltedJointChoices } from './boltedJointCommand.js';
import type { EntryBoltedJointPlan, EntryHoleSelection, FasteningExtensionRejection } from './holeEntryTypes.js';
import type { BoltedJointRejection } from './types.js';

export interface BoltedJointSetRequest {
  readonly first: readonly EntryHoleSelection[];
  readonly second: readonly EntryHoleSelection[];
  readonly choices: BoltedJointChoices;
}

export interface BoltedJointSetPicks {
  readonly first: readonly FasteningHolePick[];
  readonly second: readonly FasteningHolePick[];
  readonly choices: BoltedJointChoices;
}

export interface BoltedJointHoleFailure {
  readonly index: number;
  readonly rejections: readonly BoltedJointRejection[];
  readonly entryRejections: readonly FasteningExtensionRejection[];
}

export interface BoltedJointSetPlan {
  readonly joints: readonly EntryBoltedJointPlan[];
}

export interface BoltedJointSetFailure {
  readonly ok: false;
  readonly rejections: readonly FasteningExtensionRejection[];
  readonly holes: readonly BoltedJointHoleFailure[];
}

export type BoltedJointSetResult = { readonly ok: true; readonly plan: BoltedJointSetPlan } | BoltedJointSetFailure;
export type ApplyBoltedJointSetResult =
  | { readonly ok: true; readonly document: AssemblyDocument; readonly componentIds: readonly (readonly string[])[] }
  | (BoltedJointSetFailure & { readonly document: AssemblyDocument });
