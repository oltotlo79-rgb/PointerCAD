/**
 * 長さを持つ部材(アルミフレーム・形材の族と鋼材)の選ぶ窓の道具: 線に沿って並べる(J-01 包み 3〜6)と、
 * 置いた部材の一括の書き換え(包み 8)。族の窓と鋼材の窓が同じ物を出す。
 */
import { FrameLayoutDetails } from './FrameLayoutDetails.js';
import type { FrameMemberChoice } from './frameMembersPlacement.js';
import { MemberBulkEditDetails } from './MemberBulkEditDetails.js';

export function FrameMemberTools({ member }: { readonly member: FrameMemberChoice }): React.JSX.Element {
  return <>
    <FrameLayoutDetails member={member} />
    <MemberBulkEditDetails member={member} />
  </>;
}
