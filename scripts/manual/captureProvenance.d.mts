import type { CaptureChapter, CaptureFolder } from './captureRegistry.mjs';

/** Files Playwright leaves in a failed test's output folder; captures next to them are refused. */
export const CAPTURE_FAILURE_ARTIFACT: RegExp;

export class CaptureAdoptionError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]);
}

/** A file of a Playwright output folder: its path relative to that folder (with `/`) and its bytes. */
export interface CaptureRunFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}
/** One `<name>-capture.json` of a run with its files; `problems` is empty when it may be adopted. */
export interface CaptureRunCapture {
  readonly path: string;
  readonly name: string;
  readonly project: string | null;
  readonly capture: unknown;
  readonly fixture: Uint8Array | null;
  readonly screen: Uint8Array | null;
  readonly detail: Uint8Array | null;
  readonly problems: readonly string[];
}
export interface CaptureAdoptionPlan {
  readonly bundle: { readonly name: string; readonly bytes: Uint8Array };
  readonly images: readonly { readonly name: string; readonly bytes: Uint8Array; readonly replaced: boolean }[];
  /** Older capture records without the adopted images; `bytes` is null when the record file is removed. */
  readonly rewrites: readonly { readonly name: string; readonly bytes: Uint8Array | null; readonly removed: readonly string[] }[];
  readonly registry: { readonly name: string; readonly bytes: Uint8Array; readonly previous: Uint8Array | null };
  readonly summary: {
    readonly bundle: string;
    readonly applicationBuildId: string;
    readonly adopted: readonly string[];
    readonly scripts: readonly string[];
    readonly rewritten: readonly string[];
    readonly removedRecords: readonly string[];
  };
}

export function collectCaptureRun(files: readonly CaptureRunFile[]): CaptureRunCapture[];
export function referencedSelections(captures: readonly CaptureRunCapture[], project: string, chapters: readonly CaptureChapter[]): {
  readonly selections: string[];
  readonly skipped: string[];
};
export function planCaptureAdoption(input: {
  readonly captures: readonly CaptureRunCapture[];
  /** `name` adopts the detail image, `name:screen` the whole screen. */
  readonly selections: readonly string[];
  readonly bundle: string;
  readonly project?: string;
  readonly applicationBuildId: string;
  readonly scripts: ReadonlyMap<string, Uint8Array>;
  readonly folder: CaptureFolder;
  readonly adoptedAt: string;
}): CaptureAdoptionPlan;
export function readCaptureRun(folder: string): Promise<CaptureRunFile[]>;
export function writeCaptureAdoption(root: string, plan: CaptureAdoptionPlan, folder: CaptureFolder): Promise<void>;
