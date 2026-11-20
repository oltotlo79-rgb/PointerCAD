/**
 * 締結部品の自動判別(E-07)の窓(モーダルにしない。確定だけが文書を変える)。接続ごとに、合う板の候補を並べて利用者に 1 つ選ばせる
 * (自動で確定しない)。合う板が無い接続は、合わない理由の数を出す。ボルトの呼び・溝用のナットの入れ方と材質は、フレームの溝への締結と同じ欄。
 * 入れ替え(E-13)の時は、題と確定の文を替え、今の板の候補に「今」の印を付ける(色だけに頼らず文字で示す)。
 * 同じ形の接続の組(安全柵などが渡す)は、組の全部の接続に 1 つずつ通る候補の形があれば組で 1 つ選ぶ。無い組の接続は、接続ごとに選ぶ。
 */
import { frameSlotBoltNominals, type JointBracketChoice } from '@pointercad/model';
import { useMemo, useRef } from 'react';

import { isCompositionKey } from '../commands/compositionKey.js';
import { t } from '../i18n/t.js';
import { useDialogFocus } from '../shell/dialogFocus.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  frameJointBracketReady, jointBracketChoiceKey, type FrameJointBracketData, type FrameJointBracketGroupRow, type FrameJointBracketRow,
} from './frameJointBracketDraft.js';
import { FRAME_SLOT_NUT_ENTRIES, FRAME_SLOT_NUT_MATERIALS } from './frameSlotFasteningDraft.js';
import { frameSlotReasonText } from './frameSlotReasons.js';

/** 板の名前(族の行の呼び名)。 */
function bracketName(data: FrameJointBracketData | null, choice: JointBracketChoice): string {
  const family = choice.bracket.familyId === data?.families.angle.id ? data.families.angle : data?.families.plate;
  const row = family?.rows.find((candidate) => candidate.key === choice.bracket.key);
  return family === undefined || row === undefined ? choice.bracket.key : family.partName(row, {});
}

/** 候補の断りの文(板の側の理由か、溝のナットとボルトの計画の理由)。 */
function reasonText(choice: JointBracketChoice): string {
  const result = choice.result;
  if (result.ok) return '';
  if ('reason' in result) return t(`assembly.jointBracket.reason.${result.reason}`);
  const failure = result.failures[0];
  return failure === undefined ? t('assembly.jointBracket.reason.noPlan') : frameSlotReasonText(failure, undefined);
}

function JointRow({ row, names, data }: { readonly row: FrameJointBracketRow; readonly names: ReadonlyMap<string, string>;
  readonly data: FrameJointBracketData | null }): React.JSX.Element {
  const passing = row.choices.filter((choice) => choice.result.ok);
  const title = `${t(`assembly.jointCheck.kind.${row.joint.kind}`)}: ${row.joint.members.map((member) => names.get(member.componentId) ?? member.componentId).join(' × ')}`;
  const reasons = new Map<string, number>();
  if (passing.length === 0) for (const choice of row.choices) reasons.set(reasonText(choice), (reasons.get(reasonText(choice)) ?? 0) + 1);
  return (
    <fieldset className="pcad-field" data-testid="frame-joint-bracket-joint">
      <legend className="pcad-field__label">{title}</legend>
      {passing.length === 0 ? (
        <p role="alert" data-testid="frame-joint-bracket-none">{t('assembly.jointBracket.noPassing')
          .replace('{reasons}', [...reasons].map(([text, count]) => `${text}(${String(count)})`).join(t('display.listSeparator')))}</p>
      ) : passing.map((choice) => {
        const key = jointBracketChoiceKey(choice);
        const count = choice.result.ok ? choice.result.entries.length : 0;
        return (
          <label key={key} className="pcad-field">
            <input type="radio" name={row.joint.id} checked={row.selectedKey === key} title={t('assembly.jointBracket.choiceGuide')}
              onChange={() => { useAppStore.getState().chooseJointBracket(row.joint.id, key); }} />
            <span>{`${bracketName(data, choice)} ${t(`assembly.jointBracket.orientation.${choice.bracket.orientation}`)}`}</span>
            <span>{t('assembly.jointBracket.bolts').replace('{nominal}', choice.nominal ?? '').replace('{count}', String(count))}</span>
            {row.currentKey === key ? <strong data-testid="frame-joint-bracket-current">{t('assembly.jointBracket.current')}</strong> : null}
          </label>
        );
      })}
    </fieldset>
  );
}

/** 同じ形の接続の組の行: 組の全部の接続に 1 つずつ通る候補の形から 1 つを選ぶ(選ぶと組の接続ごとの候補が決まる)。 */
function GroupRow({ group, data }: { readonly group: FrameJointBracketGroupRow; readonly data: FrameJointBracketData | null }): React.JSX.Element {
  return (
    <fieldset className="pcad-field" data-testid="frame-joint-bracket-group">
      <legend className="pcad-field__label">{t('assembly.jointBracket.groupTitle').replace('{count}', String(group.jointIds.length))}</legend>
      {group.shapes.map((shape) => (
        <label key={shape.shapeKey} className="pcad-field">
          <input type="radio" name={`group:${group.key}`} checked={group.selectedShape === shape.shapeKey}
            title={t('assembly.jointBracket.groupChoiceGuide')} onChange={() => { useAppStore.getState().chooseJointBracketGroup(group.key, shape.shapeKey); }} />
          <span>{`${bracketName(data, shape.sample)} ${t(`assembly.jointBracket.orientation.${shape.sample.bracket.orientation}`)}`}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function FrameJointBracketPopover(): React.JSX.Element | null {
  const draft = useAppStore((state) => state.assemblyJointBracketDraft);
  const preview = useAppStore((state) => state.assemblyJointBracketPreview);
  const data = useAppStore((state) => state.assemblyJointBracketData);
  const document = useAppStore((state) => state.assembly);
  const names = useMemo(() => new Map(document?.components.map((component): readonly [string, string] => [component.id, component.name]) ?? []),
    [document]);
  const root = useRef<HTMLFormElement>(null);
  const first = useRef<HTMLSelectElement>(null);
  // 開いた時は最初の欄へ、閉じた時は開いた元(接合チェックの「留める」・「組む」のメニューの釦)へ焦点を戻す(C-03)。
  useDialogFocus(() => root.current, draft !== null, { initial: () => first.current });
  if (draft === null) return null;
  const swapping = draft.swapRecordId !== null;
  const title = t(swapping ? 'assembly.jointBracket.swapTitle' : 'assembly.jointBracket.title');
  const ready = frameJointBracketReady(preview);
  return (
    <form ref={root} className="pcad-popover pcad-popover--frame-slot" role="dialog" aria-label={title} data-testid="frame-joint-bracket"
      onSubmit={(event) => { event.preventDefault(); useAppStore.getState().commitJointBracket(); }}
      onKeyDown={(event) => {
        // Esc で閉じる(ほかの組立の窓と同じ。字の変換を確定する Esc では閉じない)。
        if (event.key !== 'Escape' || isCompositionKey(event.nativeEvent)) return;
        event.preventDefault(); event.stopPropagation(); useAppStore.getState().cancelJointBracket();
      }}>
      <strong className="pcad-popover__title">{title}</strong>
      <p role="status">{t(swapping ? 'assembly.jointBracket.swapPrompt' : 'assembly.jointBracket.prompt')}</p>
      <div className="pcad-popover__fields">
        <label className="pcad-field">
          <span className="pcad-field__label">{t('assembly.jointBracket.nominal')}</span>
          <select ref={first} className="pcad-field__input" value={draft.choices.nominal ?? ''} title={t('assembly.jointBracket.nominalGuide')}
            onChange={(event) => { useAppStore.getState().updateJointBracketDraft({ choices: { ...draft.choices,
              nominal: event.currentTarget.value === '' ? null : event.currentTarget.value } }); }}>
            <option value="">{t('assembly.jointBracket.nominalDefault')}</option>
            {frameSlotBoltNominals().map((nominal) => <option key={nominal} value={nominal}>{nominal}</option>)}
          </select>
        </label>
        <label className="pcad-field">
          <span className="pcad-field__label">{t('assembly.frameSlot.nutEntry')}</span>
          <select className="pcad-field__input" value={draft.choices.nutEntry} title={t('assembly.frameSlot.nutEntryGuide')}
            onChange={(event) => { useAppStore.getState().updateJointBracketDraft({ choices: { ...draft.choices, nutEntry: event.currentTarget.value } }); }}>
            {FRAME_SLOT_NUT_ENTRIES.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
          </select>
        </label>
        <label className="pcad-field">
          <span className="pcad-field__label">{t('assembly.frameSlot.nutMaterial')}</span>
          <select className="pcad-field__input" value={draft.choices.nutMaterial} title={t('assembly.frameSlot.nutMaterialGuide')}
            onChange={(event) => { useAppStore.getState().updateJointBracketDraft({ choices: { ...draft.choices, nutMaterial: event.currentTarget.value } }); }}>
            {FRAME_SLOT_NUT_MATERIALS.map((material) => <option key={material} value={material}>{t(`assembly.frameSlot.material.${material}`)}</option>)}
          </select>
        </label>
      </div>
      {preview === null || preview.kind === 'issue'
        ? <p role="status" data-testid="frame-joint-bracket-issue">{t(`assembly.jointBracket.issue.${preview?.issue ?? 'loading'}`)}</p>
        : <>
          {preview.groups.map((group) => <GroupRow key={group.key} group={group} data={data} />)}
          {preview.rows.filter((row) => !preview.groups.some((group) => group.jointIds.includes(row.joint.id)))
            .map((row) => <JointRow key={row.joint.id} row={row} names={names} data={data} />)}
        </>}
      <div className="pcad-popover__actions">
        <button type="submit" className="pcad-button" disabled={!ready} data-testid="frame-joint-bracket-commit"
          title={t(swapping ? 'assembly.jointBracket.swapCommitTooltip' : 'assembly.jointBracket.commitTooltip')}>
          {t(swapping ? 'assembly.jointBracket.swapCommit' : 'assembly.jointBracket.commit')}</button>
        <button type="button" className="pcad-button" title={t('assembly.jointBracket.cancelTooltip')}
          onClick={() => { useAppStore.getState().cancelJointBracket(); }}>
          {t('assembly.jointBracket.cancel')}</button>
      </div>
    </form>
  );
}
