// Keep the original Error.message for low-level callers and older reply readers.
// The model and UI use the code and parameters for the current display.
const SWEEP_FAILURE_MESSAGES = {
  'extrude-distance': '押し出す長さは 0 より大きい数にしてください。',
  'extrude-direction': '押し出す向きが決まりません。断面が平らかどうかを確かめてください。',
  'extrude-taper-range': '押し出しの傾きは 0 度以上 90 度未満にしてください。',
  'extrude-taper-build': '押し出しに傾きを付けられませんでした。角度を小さくしてください。',
  'extrude-no-material': '押し出す先にソリッドがありません。',
  'extrude-end-build': '押し出す先にソリッドがありません。',
  'extrude-next-target': '「次の面まで」の相手になるソリッドが見つかりません。相手のソリッドを選び直してください。',
  'extrude-through-target': '貫いて切る対象のソリッドが見つかりません。切るソリッドを選び直してください。',
  'extrude-build': '断面を押し出せませんでした。断面の形を見直してください。',
  'extrude-no-volume': '押し出しても厚みが出ませんでした。長さを大きくしてください。',
  'revolve-angle': '回転の角度は 0 より大きく 360 度以下にしてください。',
  'revolve-axis': '回転の軸が決まりません。軸を選び直してください。',
  'revolve-axis-overlap': '断面が回転軸と重なっているため、回せませんでした。断面を軸から離してください。',
  'revolve-no-volume': '回しても厚みが出ませんでした。軸と断面の向きを見直してください。',
  'sweep-internal': '幾何カーネルの内部で失敗しました。値を見直して、もう一度お試しください。',
};

export type SolidSweepFailureCode = keyof typeof SWEEP_FAILURE_MESSAGES;

export class SolidSweepFailure extends Error {
  constructor(
    readonly code: SolidSweepFailureCode,
    readonly parameters?: Readonly<Record<string, string>>,
    options?: ErrorOptions,
  ) {
    super(SWEEP_FAILURE_MESSAGES[code], options);
    this.name = 'SolidSweepFailure';
  }
}

export function unexpectedSolidSweepFailure(cause: unknown): SolidSweepFailure {
  return cause instanceof SolidSweepFailure ? cause : new SolidSweepFailure('sweep-internal', undefined, { cause });
}
