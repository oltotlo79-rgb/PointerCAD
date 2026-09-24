import { useId, useState } from 'react';
import { removeUnresolvedMathProblem, setUnresolvedMathProblem,
  UNRESOLVED_MATH_PROBLEM_LIMIT, type PartDocument, type UnresolvedMathProblem } from '@pointercad/model';
import { MathExpressionDialog } from '../math/MathExpressionDialog.js';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';

interface ProblemTarget {
  readonly document: PartDocument;
  readonly documentVersion: number;
  readonly existing?: UnresolvedMathProblem;
  readonly id: string;
  readonly name: string;
}

/** Uses the existing parameter tab and document history, with no numeric placeholder. */
export function UnresolvedMathPanel(): React.JSX.Element {
  const id = useId();
  const document = useAppStore(state => state.document), documentVersion = useAppStore(state => state.documentVersion);
  const [target, setTarget] = useState<ProblemTarget | null>(null);
  const problems = document.unresolvedMathProblems ?? [];
  const open = (existing?: UnresolvedMathProblem) => {
    let serial = 1;
    while (problems.some(problem => problem.name === `${t('math.problem.defaultName')}${serial}`)) serial++;
    setTarget({ document, documentVersion, ...(existing === undefined ? {} : { existing }),
      id: existing?.id ?? `math-problem:${crypto.randomUUID()}`,
      name: existing?.name ?? `${t('math.problem.defaultName')}${serial}` });
  };
  return <section aria-labelledby={`${id}-title`} data-help-topic="math-input" className="pcad-section pcad-unresolved-problems">
    <h3 id={`${id}-title`}>{t('math.problem.title')}</h3>
    <p>{t('math.problem.hint')}</p>
    <ul>{problems.map(problem => <li key={problem.id}>
      <strong>{problem.name}</strong><p>{problem.definition.source}</p>
      {problem.definition.declarations?.map(declaration => <p key={declaration.id}>
        {t('math.declaration.summary').replace(/\{(?:label|meaning|type)\}/gu, token => token === '{label}'
          ? declaration.label : token === '{meaning}' ? declaration.meaning : t(`math.declaration.type.${declaration.type}`))}
      </p>)}
      <p>{t('math.problem.unresolved')}</p>
      <button type="button" className="pcad-button" title={t('math.problem.edit')} onClick={() => open(problem)}>{t('math.problem.edit')}</button>
      <button type="button" className="pcad-button" title={t('math.problem.delete')} onClick={() => {
        useAppStore.getState().applyDocument(removeUnresolvedMathProblem(document, problem.id));
      }}>{t('math.problem.delete')}</button>
    </li>)}</ul>
    <button type="button" className="pcad-button" title={t('math.problem.add')}
      disabled={problems.length >= UNRESOLVED_MATH_PROBLEM_LIMIT} onClick={() => open()}>{t('math.problem.add')}</button>
    {target === null ? null : <MathExpressionDialog kind="problem" document={target.document}
      documentVersion={target.documentVersion} initialProblem={target.existing?.definition} unitLabel=""
      isCurrent={() => useAppStore.getState().document === target.document && useAppStore.getState().documentVersion === target.documentVersion}
      onClose={() => setTarget(null)} onApply={(definition, prepared, signal) => {
        if (signal.aborted || useAppStore.getState().document !== target.document
          || useAppStore.getState().documentVersion !== target.documentVersion) {
          return Promise.resolve({ ok: false, message: t('math.operation.cancelled') });
        }
        useAppStore.getState().applyDocument(setUnresolvedMathProblem(prepared,
          { id: target.id, name: target.name, status: 'unresolved', definition }));
        return Promise.resolve({ ok: true });
      }} />}
  </section>;
}
