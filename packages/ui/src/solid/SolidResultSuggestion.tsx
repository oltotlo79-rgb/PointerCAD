import { useMemo } from 'react';
import { t } from '../i18n/t.js';
import { numericChoiceOptionLabel, type NumericInputState } from '../sketch/numericInput.js';
import { addVec3, crossVec3, lengthVec3, normalizeVec3, ORIGIN, scaleVec3, subVec3, type Vec3 } from '@pointercad/model';
import { suggestExtrudeOperations, type SuggestionBody } from './extrudeSuggestion.js';

// 予告の三角形から最大12か所を取る。大きな網でも入力を止めないよう、調べる三角形の組数を制限する。
const MAX_SAMPLES = 12;
const MAX_TRIANGLE_PAIRS = 24_000;

function localVertex(body: SuggestionBody, at: number): Vec3 {
  const { positions, indices } = body.mesh;
  const index = 3 * indices[at];
  return [positions[index], positions[index + 1], positions[index + 2]];
}

/** 確かめた形の表面の内外を標本にして提案する。相手・結果の選択や文書を変えない。 */
function suggestPreviewOperation(tool: SuggestionBody, target: SuggestionBody): 'join' | 'cut' | null {
  const triangles = Math.floor(tool.mesh.indices.length / 3);
  const targetTriangles = Math.floor(target.mesh.indices.length / 3);
  if (!(tool.volume > 0 && target.volume > 0) || targetTriangles === 0) return null;
  const samples = Math.min(MAX_SAMPLES, triangles, Math.floor(MAX_TRIANGLE_PAIRS / targetTriangles));
  if (samples < 4) return null;
  let inside = 0, outside = 0, boundary = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    const at = 3 * Math.floor((sample + 0.5) * triangles / samples);
    const a = localVertex(tool, at), b = localVertex(tool, at + 1), c = localVertex(tool, at + 2);
    const normal = normalizeVec3(crossVec3(subVec3(b, a), subVec3(c, a)));
    if (!(lengthVec3(normal) > 0)) continue;
    const center = addVec3(tool.coordinateFrame?.origin ?? ORIGIN, scaleVec3(addVec3(a, addVec3(b, c)), 1 / 3));
    const side = suggestExtrudeOperations(center, normal, [target], [target.featureId]).symmetric.operation;
    if (side === 'cut') inside += 1;
    else if (side === 'join') boundary += 1;
    else outside += 1;
  }
  if (inside > 0 && outside === 0 && tool.volume < target.volume) return 'cut';
  if (outside > 0 && (inside > 0 || boundary > 0)) return 'join';
  return null;
}

interface SuggestionProps {
  readonly input: NumericInputState;
  readonly bodies: readonly SuggestionBody[];
  readonly toolId: string;
}

export function SolidResultSuggestion({ input, bodies, toolId }: SuggestionProps): React.JSX.Element | null {
  const targets = input.choices.find(choice => choice.key === 'extrudeTarget');
  const candidates = targets?.options.filter(option => option.value !== '') ?? [];
  const selected = candidates.find(option => option.value === targets?.value)
    ?? (targets?.value === '' && candidates.length === 1 ? candidates[0] : undefined);
  const tool = bodies.find(body => body.featureId === toolId);
  const target = bodies.find(body => body.featureId === selected?.value);
  const suggestion = useMemo(() => tool === undefined || target === undefined ? null : suggestPreviewOperation(tool, target),
    [tool, target]);
  if (suggestion === null || selected === undefined) return null;
  const key = suggestion === 'join' ? 'numericInput.solidSuggestion.join' : 'numericInput.solidSuggestion.cut';
  return <p className="pcad-field__message" role="status">{t(key).replace('{name}', () => numericChoiceOptionLabel(selected))}</p>;
}
