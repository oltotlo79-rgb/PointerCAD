/**
 * 押し出しの「提案して見せる」(M-01 の M01-4、計画 §3 の案 1)。
 *
 * 押し出す領域の位置と押す向きから、結果(新しい立体・結合・切り抜き)と相手を提案し、押し出しの欄の選択肢へ
 * 入れる。提案は確定の前に見せるだけで、確定するのは利用者(欄で変えられる。手で選んだ後は上書きしない)。
 * 選択の順番では決めない(`extrudeOperation.ts` の決まりの趣旨)。
 *
 * - 決め方: 押した点から押す向きの先と後ろへ少しずらした 2 点を、画面に出ている立体の三角形の網で中か外か調べる。
 *   先が立体 X の中 → 切り抜き・相手 X。後ろが立体 X の中で先が外 → 結合・相手 X。どちらでもない → 新しい立体。
 *   両側へ押す時は、2 点とも同じ立体の中 → 切り抜き、片方だけ中 → 結合。
 * - 網の近似は提案にだけ使う。確定の形は今の厳密な計算(段階計算)で作るので、計算部は変えない。
 * - 相手にするのは、相手の候補(使われていない立体。`extrudeTargetCandidates`)にある立体だけ。
 */
import { belowMagnitude, type SolidBodyMeshData, type Vec3 } from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';
import type { NumericChoice, NumericInputEvent, NumericInputState } from '../sketch/numericInput.js';

type ExtrudeSuggestedOperation = 'new' | 'join' | 'cut';

/** 1 つの向きの提案。新しい立体の時の相手は空。 */
interface ExtrudeSuggestion {
  readonly operation: ExtrudeSuggestedOperation;
  readonly target: string;
}

/** 押す向きごとの提案。反転・両側のつまみに合わせて欄へ入れ直すので、3 つとも先に決めておく。 */
export interface ExtrudeSuggestions {
  readonly forward: ExtrudeSuggestion;
  readonly reverse: ExtrudeSuggestion;
  readonly symmetric: ExtrudeSuggestion;
}

/** 提案に使う立体(ストアの `bodies` の 1 件と同じ形の部分)。 */
export interface SuggestionBody {
  readonly featureId: string;
  readonly volume: number;
  readonly mesh: Pick<SolidBodyMeshData, 'positions' | 'indices'>;
  /** 局所の座標で持つ時の原点と、float32 の丸めの最大の誤差(mm)。 */
  readonly coordinateFrame?: { readonly origin: Vec3; readonly maximumFloat32ErrorMm: number };
}

/** 押した点から先と後ろへずらす量(mm)。平らな面の上にかいた領域で、面の三角形の丸めより十分大きい。 */
const SUGGESTION_OFFSET_MM = 0.01;
/** 中か外かを決める光線の向き(辺や頂点をかすめにくい、軸に沿わない向き。多数決で決める)。 */
const RAY_DIRECTIONS: readonly Vec3[] = [[0.5773, 0.5774, 0.5775], [-0.6123, 0.3536, 0.7071], [0.2673, -0.8018, 0.5345]];
const RAY_EPSILON = 1e-12;
const FRESH: ExtrudeSuggestion = { operation: 'new', target: '' };

function hitsTriangle(origin: Vec3, direction: Vec3, a: Vec3, b: Vec3, c: Vec3): boolean {
  const e1: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p: Vec3 = [direction[1] * e2[2] - direction[2] * e2[1], direction[2] * e2[0] - direction[0] * e2[2],
    direction[0] * e2[1] - direction[1] * e2[0]];
  const determinant = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (belowMagnitude(determinant, RAY_EPSILON)) return false;
  const s: Vec3 = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
  const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / determinant;
  if (u < 0 || u > 1) return false;
  const q: Vec3 = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const v = (direction[0] * q[0] + direction[1] * q[1] + direction[2] * q[2]) / determinant;
  if (v < 0 || u + v > 1) return false;
  return (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / determinant > RAY_EPSILON;
}

/** 点が立体の網の中か(光線が網を横切る回数の偶奇を 3 本の光線の多数決で決める)。体積の無い開いた面は中を持たない。 */
function pointInsideBody(point: Vec3, body: SuggestionBody): boolean {
  if (!(body.volume > 0)) return false;
  const origin = body.coordinateFrame?.origin ?? [0, 0, 0];
  const local: Vec3 = [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]];
  const { positions, indices } = body.mesh;
  const vertex = (index: number): Vec3 => [positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]];
  let votes = 0;
  for (const direction of RAY_DIRECTIONS) {
    let crossings = 0;
    for (let at = 0; at + 2 < indices.length; at += 3) {
      if (hitsTriangle(local, direction, vertex(indices[at]), vertex(indices[at + 1]), vertex(indices[at + 2]))) crossings += 1;
    }
    if (crossings % 2 === 1) votes += 1;
  }
  return votes * 2 > RAY_DIRECTIONS.length;
}

function containing(point: Vec3, bodies: readonly SuggestionBody[]): string | null {
  return bodies.find(body => pointInsideBody(point, body))?.featureId ?? null;
}

function offset(point: Vec3, direction: Vec3, distance: number): Vec3 {
  return [point[0] + direction[0] * distance, point[1] + direction[1] * distance, point[2] + direction[2] * distance];
}

/**
 * 押した点(領域の内側、作図面の上)と、反転しない時の押す向き(領域の `normal`)から、向きごとの提案を決める。
 * `candidateIds` は相手の候補(履歴の順)。立体はこの順に調べ、最初に当たった立体を相手にする。
 */
export function suggestExtrudeOperations(point: Vec3, normal: Vec3, bodies: readonly SuggestionBody[],
  candidateIds: readonly string[]): ExtrudeSuggestions {
  const ordered = candidateIds.flatMap(id => bodies.filter(body => body.featureId === id));
  const roundOff = Math.max(0, ...ordered.map(body => body.coordinateFrame?.maximumFloat32ErrorMm ?? 0));
  const distance = Math.max(SUGGESTION_OFFSET_MM, 4 * roundOff);
  const ahead = containing(offset(point, normal, distance), ordered);
  const behind = containing(offset(point, normal, -distance), ordered);
  const directional = (front: string | null, back: string | null): ExtrudeSuggestion => {
    if (front !== null) return { operation: 'cut', target: front };
    return back === null ? FRESH : { operation: 'join', target: back };
  };
  const symmetric: ExtrudeSuggestion = ahead !== null && ahead === behind ? { operation: 'cut', target: ahead }
    : ahead !== null || behind !== null ? { operation: 'join', target: ahead ?? behind ?? '' } : FRESH;
  return { forward: directional(ahead, behind), reverse: directional(behind, ahead), symmetric };
}

const REASON_KEYS: Readonly<Record<'join' | 'cut', MessageKey>> = {
  join: 'numericInput.extrudeSuggestion.join',
  cut: 'numericInput.extrudeSuggestion.cut',
};

function toggleOn(state: NumericInputState, key: 'reversed' | 'symmetric'): boolean {
  return state.toggles.find(toggle => toggle.key === key)?.value === true;
}

function currentSuggestion(state: NumericInputState, suggestions: ExtrudeSuggestions): ExtrudeSuggestion {
  if (toggleOn(state, 'symmetric')) return suggestions.symmetric;
  return toggleOn(state, 'reversed') ? suggestions.reverse : suggestions.forward;
}

function withoutMark(choice: NumericChoice): NumericChoice {
  return choice.suggestion === undefined ? choice : { ...choice, suggestion: undefined };
}

/** 欄に提案を入れる。選択肢に無い結果・相手(相手の候補が変わった時)は、新しい立体に戻す。 */
function applySuggestion(state: NumericInputState, suggestion: ExtrudeSuggestion): NumericInputState {
  const operationChoice = state.choices.find(choice => choice.key === 'extrudeOperation');
  const targetChoice = state.choices.find(choice => choice.key === 'extrudeTarget');
  const targetOption = targetChoice?.options.find(option => option.value === suggestion.target);
  const usable = suggestion.operation !== 'new' && targetOption !== undefined
    && operationChoice?.options.some(option => option.value === suggestion.operation) === true;
  const operation = usable ? suggestion.operation : 'new';
  const target = usable ? suggestion.target : '';
  const name = targetOption?.label ?? suggestion.target;
  const choices = state.choices.map((choice): NumericChoice => {
    if (choice.key === 'extrudeOperation') {
      const reasonKey = operation === 'new' ? null : REASON_KEYS[operation];
      return reasonKey === null ? withoutMark({ ...choice, value: operation }) : { ...choice, value: operation, suggestion: { reasonKey, name } };
    }
    if (choice.key === 'extrudeTarget') {
      return operation === 'new' ? withoutMark({ ...choice, value: target }) : { ...choice, value: target, suggestion: {} };
    }
    return choice;
  });
  return { ...state, choices };
}

/**
 * 領域を選んだ時の提案を欄へ入れる。結果か相手を手で選んだ後は、提案を覚えるだけで欄は変えない
 * (向きを変えても、領域を選び直しても、手で選んだ物のまま)。
 */
export function withExtrudeSuggestions(state: NumericInputState, suggestions: ExtrudeSuggestions): NumericInputState {
  const remembered = { ...state, extrudeSuggestions: suggestions };
  return state.extrudeChoiceManual === true ? remembered : applySuggestion(remembered, currentSuggestion(remembered, suggestions));
}

function choiceValue(state: NumericInputState, key: 'extrudeOperation' | 'extrudeTarget'): string | undefined {
  return state.choices.find(choice => choice.key === key)?.value;
}

/**
 * 欄の操作 1 つの後に、提案の決まりを当てる(`reduceNumericInput` が呼ぶ)。
 * - 反転・両側のつまみを切り替えたら、手で選んでいなければ、押す向きに合わせて提案を入れ直す。
 * - 結果か相手を手で選んだら、手で選んだ印を立て、「提案」の印を消す(以後は上書きしない)。
 */
export function followExtrudeSuggestion(previous: NumericInputState, event: NumericInputEvent,
  next: NumericInputState): NumericInputState {
  const suggestions = next.extrudeSuggestions;
  if (next.toolId !== 'extrude' || suggestions === undefined) return next;
  if (event.type === 'toggle') {
    return next.extrudeChoiceManual === true ? next : applySuggestion(next, currentSuggestion(next, suggestions));
  }
  const changed = choiceValue(previous, 'extrudeOperation') !== choiceValue(next, 'extrudeOperation')
    || choiceValue(previous, 'extrudeTarget') !== choiceValue(next, 'extrudeTarget');
  if ((event.type !== 'choose' && event.type !== 'moveChoice') || !changed) return next;
  return { ...next, extrudeChoiceManual: true, choices: next.choices.map(withoutMark) };
}
