/**
 * 長さを持つ部材(アルミフレーム・形材の族と鋼材)の選ぶ窓の道具: 線に沿って並べる(J-01 包み 3〜6)と、
 * 置いた部材の一括の書き換え(包み 8)と、分ける・まとめる(E-11)と、ケガキの位置(E-14)と、安全柵を作る(E-12)と、選んだ枠にパネルをはめる・扉を付ける(E-10)。族の窓と鋼材の窓が同じ物を出す。
 */
import { FrameDoorDetails } from './FrameDoorDetails.js';
import { FrameLayoutDetails } from './FrameLayoutDetails.js';
import { FramePanelDetails } from './FramePanelDetails.js';
import { FrameScribeMarksDetails } from './FrameScribeMarksDetails.js';
import type { FrameMemberChoice } from './frameMembersPlacement.js';
import { MemberBulkEditDetails } from './MemberBulkEditDetails.js';
import { MemberSplitMergeDetails } from './MemberSplitMergeDetails.js';
import { SafetyFenceDetails } from './SafetyFenceDetails.js';

export function FrameMemberTools({ member }: { readonly member: FrameMemberChoice }): React.JSX.Element {
  return <>
    <FrameLayoutDetails member={member} />
    <MemberBulkEditDetails member={member} />
    <MemberSplitMergeDetails />
    <FrameScribeMarksDetails />
    <SafetyFenceDetails member={member} />
    <FramePanelDetails />
    <FrameDoorDetails />
  </>;
}
