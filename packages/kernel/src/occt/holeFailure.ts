/** 穴の寸法・位置で直せる条件と計算部の内部異常。穴を使う下穴にも共通。 */
export type HoleFailureCode =
  | 'hole-not-planar'
  | 'hole-planar-conflict'
  | 'hole-planar-coordinates'
  | 'hole-planar-outside'
  | 'hole-no-center'
  | 'hole-center-not-finite'
  | 'hole-tilt-angle'
  | 'hole-tilt-azimuth'
  | 'hole-not-cylindrical'
  | 'hole-cylinder-scaled'
  | 'hole-cylinder-unsupported'
  | 'hole-cylinder-no-location'
  | 'hole-cylinder-coordinates'
  | 'hole-cylinder-outside'
  | 'hole-cylinder-bore'
  | 'hole-diameter'
  | 'hole-depth'
  | 'hole-counterbore-diameter'
  | 'hole-counterbore-depth'
  | 'hole-countersink-angle'
  | 'hole-countersink-diameter'
  | 'hole-entry-depth'
  | 'hole-no-removal'
  | 'hole-internal';

export class HoleFailure extends Error {
  readonly parameters: Readonly<Record<string, string>> | undefined;

  constructor(readonly code: HoleFailureCode, message: string,
    options?: ErrorOptions & { readonly parameters?: Readonly<Record<string, string>> }) {
    super(message, options);
    this.name = 'HoleFailure';
    this.parameters = options?.parameters;
  }
}

/** 旧呼び元の文と開発用の原因を保持し、画面へは共通の内部異常の符号を渡す。 */
export function internalHoleFailure(message: string, cause: unknown): HoleFailure {
  return new HoleFailure('hole-internal', message, { cause });
}
