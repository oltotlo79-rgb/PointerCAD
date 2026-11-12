/**
 * 押した瞬間に決まる編集の道具の責務: トリム・延長(FR-322)と、投影・断面(FR-325)。
 *
 * どれも**1 クリック = Undo 1 回**(`setSketch` が文書を 1 段だけ積む、FR-505)で、道具は選んだまま
 * 残るので続けて何か所でも押せる。断られたときは理由を帯へ出すだけで文書は変えない(FR-504、NFR-UX-5)。
 * トリム・延長は、乗せている区間を押す前に予告として出す(一時表示は自分が出した物だけを消す)。
 */
import { baseWorkPlane, type SketchResolveOptions, type Vec3 } from '@pointercad/model';

import { applyProjectionCommit } from '../sketch/commitToStore.js';
import { commitExtend, commitTrim } from '../sketch/editCommands.js';
import type { ClickEditToolId, PickEditToolId } from '../sketch/numericInput.js';
import { pickSketchElement, sketchForSelection } from '../sketch/pickMath.js';
import { projectionSourceOf, projectionTakesSubShape } from '../sketch/projectionCommands.js';
import type { ProjectToScreen, SnapCandidate } from '../sketch/snapMath.js';
import { extendPreviewAt, trimPreviewAt } from '../sketch/trimPreview.js';
import type { SubShapeBody } from '../solid/subShapeSelection.js';
import { useAppStore } from '../store/useAppStore.js';
import type { SolidBodyWithSubShapes } from './buildSolidGeometry.js';
import type { SketchInteractionIndicators } from './sketchInteractionIndicators.js';

type Pointer = readonly [number, number];

interface SketchEditToolContext {
  readonly project: ProjectToScreen;
  readonly indicators: SketchInteractionIndicators;
  /** 押した先の作図面の上の点(`sketchInteractionCoordinates.ts`)。 */
  readonly pointAt: (pointer: Pointer, snap: SnapCandidate | null) => Vec3 | null;
  readonly pickSubShapeAt: (pointer: Pointer) => string | null;
  readonly pickBodyAt: (pointer: Pointer) => string | null;
  readonly toSubShapeBodies: (bodies: readonly SolidBodyWithSubShapes[]) => readonly SubShapeBody[];
}

/**
 * 作図面の引き方。model の `trimCurve` / `extendCurve` は中で文書を解き直すので、
 * 任意の作業平面(FR-328)も引けるように、いま解いてある面を渡す(`shapeCommands.ts` の
 * `resolveShapePoints` と同じ渡し方)。3D スケッチ(`'free'`)は model 側が
 * 「作図面が無い」ものとして扱うので、ここへは来ない。
 */
function editResolveOptions(): SketchResolveOptions {
  const state = useAppStore.getState();
  return {
    workPlane: (planeId) =>
      planeId === state.workPlaneId ? state.workPlane : baseWorkPlane(planeId),
  };
}

/** 1 つの canvas の編集の道具。返す関数はどれも呼ばれた時点のストアを読む。 */
export function createSketchEditTools(context: SketchEditToolContext) {
  const { project, indicators, pointAt, pickSubShapeAt, pickBodyAt, toSubShapeBodies } = context;

  /**
   * トリム・延長で押した「曲線と、その上の場所」。曲線に当たっていなければ null。
   *
   * 点や面ではなく**曲線に当たったときだけ**対象にする(切る・伸ばす相手は線・円弧だけ)。
   * 場所は作図面の上の点で、吸着は使わない(吸着は端点・中点へ引き寄せるので、
   * 「いま指している区間」がずれてしまう。狙っているのは点ではなく区間)。
   */
  function editTargetAt(pointer: Pointer): { readonly elementId: string; readonly at: Vec3 } | null {
    const state = useAppStore.getState();
    const picked = pickSketchElement(
      sketchForSelection(state.resolvedSketch, state.displaySettings.selectionFilter), project, pointer,
    );
    if (picked === null || picked.kind !== 'curve') {
      return null;
    }
    const at = pointAt(pointer, null);
    return at === null ? null : { elementId: picked.elementId, at };
  }

  /**
   * トリム・延長のときのマウスの動き。乗っている区間(トリムなら消える区間、
   * 延長なら伸びる区間)を予告として出す(NFR-UX-5)。
   * 断られる場面では何も強調しない。理由はクリックしたときに帯へ出る。
   */
  function updateEditPreview(tool: ClickEditToolId, pointer: Pointer): void {
    const state = useAppStore.getState();
    const target = editTargetAt(pointer);
    const nextHovered = target === null ? null : target.elementId;
    if (nextHovered !== state.hoveredElementId) {
      state.setHovered(nextHovered);
    }
    indicators.clearSnapIndicators();
    const outcome =
      target === null
        ? null
        : tool === 'trim'
          ? trimPreviewAt(state.resolvedSketch, target.elementId, target.at)
          : extendPreviewAt(state.resolvedSketch, target.elementId, target.at);
    indicators.showEdit(outcome !== null && outcome.ok ? outcome.preview : null);
  }

  /**
   * トリム・延長のクリック(FR-322)。押した瞬間に決まる。
   * 断りは model の 6 種をそのまま帯へ出す(`editCommands.ts` が文言キーへ移し替える)。
   */
  function commitEditClick(tool: ClickEditToolId, pointer: Pointer): void {
    const state = useAppStore.getState();
    const target = editTargetAt(pointer);
    if (target === null) {
      state.setEditError('trim.error.missingElement');
      return;
    }
    const options = editResolveOptions();
    const outcome =
      tool === 'trim'
        ? commitTrim(state.sketch, target.elementId, target.at, options)
        : commitExtend(state.sketch, target.elementId, target.at, options);
    if (!outcome.ok) {
      state.setEditError(outcome.reasonKey);
      return;
    }
    // 形が変わるので、いま出している予告は用済み(次にマウスが動いたら出し直す)。
    indicators.hideEdit();
    state.setSketch(outcome.document);
  }

  /**
   * 投影・断面のクリック(FR-325)。拾う相手は道具で分かれる。投影は立体の面・辺(選ぶ種類は
   * `selectionKindForTool` が面へ切り替えてあり、`2` キーで辺へ替えられる)、断面は立体そのもの。
   * 何にも当たっていなければ「何を押せばよいか」を帯へ出すだけで、履歴は変えない。
   */
  function commitProjectionClick(tool: PickEditToolId, pointer: Pointer): void {
    const state = useAppStore.getState();
    const elementId = projectionTakesSubShape(tool)
      ? pickSubShapeAt(pointer)
      : pickBodyAt(pointer);
    const source =
      elementId === null
        ? null
        : projectionSourceOf(tool, toSubShapeBodies(state.bodies), elementId);
    applyProjectionCommit(tool, source === null ? [] : [source]);
  }

  return { updateEditPreview, commitEditClick, commitProjectionClick };
}
