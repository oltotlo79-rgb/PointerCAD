/** FR-1111: 隔離した自動作図処理の公開形式と資源上限。 */
export const SCRIPT_API_VERSION = 1;

export const SCRIPT_LIMITS = Object.freeze({
  sourceBytes: 1024 * 1024,
  heapBytes: 64 * 1024 * 1024,
  stackBytes: 128 * 1024,
  javascriptMs: 5000,
  totalMs: 30000,
  commands: 1000,
  commandBytes: 8 * 1024 * 1024,
  consoleLines: 1000,
  consoleBytes: 1024 * 1024,
  modules: 32,
  tools: 100,
  expressionCharacters: 4096,
  identifierCharacters: 256,
  stackCharacters: 16384,
  // floor((2^64 - 1) / 1,000,000): WASI stores the fixed clock in uint64 nanoseconds.
  maximumTimeMs: 18446744073709,
});

export interface ScriptLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number | null;
}
export type ScriptFailureKind = 'source' | 'syntax' | 'runtime' | 'memory' | 'stack'
  | 'timeout' | 'cancelled' | 'module' | 'command' | 'console' | 'cad' | 'stale' | 'worker';
export interface ScriptFailure {
  readonly kind: ScriptFailureKind;
  readonly message: string;
  readonly location: ScriptLocation | null;
}
export interface ScriptModule {
  readonly name: string;
  readonly source: string;
  readonly sha256: string;
}
export interface ScriptProgram {
  readonly apiVersion: typeof SCRIPT_API_VERSION;
  readonly source: string;
  readonly sha256: string;
  readonly modules: readonly ScriptModule[];
}
export type ScriptAxis = 'x' | 'y' | 'z';
export type ScriptPlane = 'xy' | 'xz' | 'yz';
export type ScriptCoordinate = readonly [string, string, string];

interface LocatedCommand {
  readonly callStack: string;
}
interface CreatedCommand extends LocatedCommand {
  readonly resultId: string;
}
interface PrimitiveFields {
  readonly origin: ScriptCoordinate;
  readonly axis: ScriptAxis;
}
export type ScriptCommand =
  | (LocatedCommand & { readonly kind: 'parameter.set'; readonly resultId: null;
      readonly fields: { readonly name: string; readonly source: string; readonly unit: 'mm' | 'degree' | 'none' | null } })
  | (CreatedCommand & { readonly kind: 'sketch.create'; readonly fields: { readonly name: string; readonly plane: ScriptPlane } })
  | (CreatedCommand & { readonly kind: 'sketch.point'; readonly fields: { readonly sketch: string; readonly coordinates: ScriptCoordinate } })
  | (CreatedCommand & { readonly kind: 'sketch.line'; readonly fields: { readonly sketch: string; readonly start: string; readonly end: string } })
  | (CreatedCommand & { readonly kind: 'sketch.face'; readonly fields: { readonly sketch: string; readonly edges: readonly string[] } })
  | (CreatedCommand & { readonly kind: 'solid.box'; readonly fields: PrimitiveFields & { readonly x: string; readonly y: string; readonly z: string } })
  | (CreatedCommand & { readonly kind: 'solid.sphere'; readonly fields: PrimitiveFields & { readonly radius: string } })
  | (CreatedCommand & { readonly kind: 'solid.cylinder'; readonly fields: PrimitiveFields & { readonly radius: string; readonly height: string } })
  | (CreatedCommand & { readonly kind: 'solid.cone'; readonly fields: PrimitiveFields & {
      readonly bottomRadius: string; readonly topRadius: string; readonly height: string } })
  | (CreatedCommand & { readonly kind: 'solid.torus'; readonly fields: PrimitiveFields & { readonly majorRadius: string; readonly minorRadius: string } })
  | (CreatedCommand & { readonly kind: 'solid.extrude'; readonly fields: { readonly face: string; readonly distance: string } })
  | (CreatedCommand & { readonly kind: 'solid.hole'; readonly fields: { readonly target: string;
      readonly origin: ScriptCoordinate; readonly axis: ScriptAxis; readonly diameter: string; readonly depth: string } });

export interface ScriptConsoleLine {
  readonly level: 'info' | 'warning' | 'error';
  readonly text: string;
}
export type ScriptExecutionOutcome =
  | { readonly ok: true; readonly commands: readonly ScriptCommand[]; readonly console: readonly ScriptConsoleLine[];
      readonly javascriptMs: number; readonly initializationMs: number }
  | { readonly ok: false; readonly error: ScriptFailure; readonly console: readonly ScriptConsoleLine[] };

export interface ScriptExecutionInput {
  readonly executionId: string;
  /** Stable digest namespace from snapshot/program/seed/time, distinct from request identity. */
  readonly commandNamespace: string;
  readonly program: ScriptProgram;
  /** JSON authored by the host from the captured document. Never a live model reference. */
  readonly snapshot: string;
  readonly seed: number;
  readonly timeMs: number;
}
