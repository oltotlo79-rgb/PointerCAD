import { useRef, useState } from 'react';
import { SCRIPT_ICONS, SCRIPT_LIMITS, isScriptModuleName } from '@pointercad/model/scripting';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { openScriptPanel, runScript } from './scriptActions.js';
import { openScriptFile, saveScriptFile, registerScript, deleteScriptTool, restoreScriptTool } from './scriptFileActions.js';
import { SCRIPT_EXAMPLES } from './scriptExamples.js';
import { SCRIPT_ICON_COMPONENTS } from './ScriptIcons.js';
import './scripting.css';

/** In the existing property region; no modal, no extra workspace section. */
export function ScriptPanel(): React.JSX.Element {
  const draft = useAppStore(state => state.scriptDraft), phase = useAppStore(state => state.scriptPhase);
  const error = useAppStore(state => state.scriptError), logs = useAppStore(state => state.scriptConsole);
  const runLog = useAppStore(state => state.scriptRunLog), message = useAppStore(state => state.scriptMessage);
  const tools = useAppStore(state => state.scriptLibrary), deleted = useAppStore(state => state.scriptDeletedTool);
  const libraryBusy = useAppStore(state => state.scriptLibraryBusy), running = useAppStore(state => state.scriptRequestId !== null);
  const [activeFile, setActiveFile] = useState('user-script.js'), [newModuleName, setNewModuleName] = useState('');
  const editor = useRef<HTMLTextAreaElement>(null);
  if (draft === null) return <p>{t('script.empty')}</p>;
  const module = draft.modules.find(item => item.name === activeFile);
  const source = module?.source ?? draft.source, fileName = module?.name ?? 'user-script.js';
  const update = (patch: Partial<typeof draft>): void => { useAppStore.getState().setScriptDraft({ ...draft, ...patch }); };
  const updateSource = (value: string): void => update(module === undefined ? { source: value } : { modules: draft.modules.map(item => item === module ? { ...item, source: value } : item) });
  const jumpToError = (): void => {
    const location = error?.location; if (location === undefined || location === null) return;
    const targetSource = location.file === 'user-script.js' ? draft.source : draft.modules.find(item => item.name === location.file)?.source;
    if (targetSource === undefined) return;
    setActiveFile(location.file);
    requestAnimationFrame(() => {
      const target = editor.current; if (target === null) return;
      const lines = targetSource.split('\n'), start = lines.slice(0, location.line - 1).reduce((total, line) => total + line.length + 1, 0);
      const position = start + Math.max(0, (location.column ?? 1) - 1);
      target.focus(); target.setSelectionRange(position, start + (lines[location.line - 1]?.length ?? 0));
      target.scrollTop = Math.max(0, (location.line - 3) * parseFloat(getComputedStyle(target).lineHeight));
    });
  };
  return <section className="pcad-script" data-help-topic="scripts" aria-label={t('script.title')} onKeyDown={event => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); useAppStore.getState().closeScriptPanel(); }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); if (!running) void runScript(); }
  }}>
    <div className="pcad-script__heading"><h2>{t('script.title')}</h2><button type="button" onClick={() => useAppStore.getState().closeScriptPanel()}>{t('script.close')}</button></div>
    <label>{t('script.name')}<input value={draft.name} maxLength={80} placeholder={t('script.namePlaceholder')} onChange={event => update({ name: event.target.value })} /></label>
    <label>{t('script.icon')}<select aria-label={t('script.icon')} value={draft.icon} onChange={event => { const icon = SCRIPT_ICONS.find(item => item === event.target.value); if (icon !== undefined) update({ icon }); }}>
      {SCRIPT_ICONS.map(icon => <option key={icon} value={icon}>{t(`script.icon.${icon}`)}</option>)}
    </select></label>
    <label>{t('script.example')}<select aria-label={t('script.example')} value="" onChange={event => {
      const example = SCRIPT_EXAMPLES.find(item => item.id === event.target.value); if (example === undefined) return;
      update({ name: t(example.label), source: example.source, modules: [], scriptId: crypto.randomUUID() }); setActiveFile('user-script.js');
    }}><option value="">{t('script.example')}</option>{SCRIPT_EXAMPLES.map(example => <option key={example.id} value={example.id}>{t(example.label)}</option>)}</select></label>
    <label>{t('script.source')}<select aria-label={t('script.modules')} value={fileName} onChange={event => setActiveFile(event.target.value)}>
      <option value="user-script.js">user-script.js</option>{draft.modules.map(item => <option key={item.name}>{item.name}</option>)}
    </select></label>
    <textarea ref={editor} className="pcad-script__source" aria-label={`${t('script.source')} ${fileName}`} value={source} spellCheck={false}
      placeholder={t('script.empty')} onChange={event => updateSource(event.target.value)} />
    <div className="pcad-script__actions"><button type="button" title={t('script.runTooltip')} disabled={running} onClick={() => { void runScript(); }}>{t('script.run')}</button>
      <button type="button" disabled={!running} onClick={() => useAppStore.getState().cancelScript()}>{t('script.cancel')}</button></div>
    <p role="status">{t(`script.phase.${phase}`)}</p>
    {error === null ? null : <div className="pcad-script__error" role="alert"><p>{error.message}</p>{error.location === null ? null : <button type="button" onClick={jumpToError}>
      {t('script.errorLine')} {error.location.file}:{error.location.line}{error.location.column === null ? '' : `:${error.location.column}`}</button>}</div>}
    {message === null ? null : <p role="status">{message}</p>}
    <div className="pcad-script__actions"><button type="button" onClick={() => { void openScriptFile(); }}>{t('script.open')}</button>
      <button type="button" onClick={() => { void saveScriptFile(); }}>{t('script.save')}</button>
      <button type="button" title={t('script.registerTooltip')} disabled={libraryBusy} onClick={() => { void registerScript(); }}>{t('script.register')}</button></div>
    <details><summary>{t('script.inputSettings')}</summary><p>{t('script.inputHint')}</p>
      <label>{t('script.seed')}<input inputMode="numeric" value={draft.seed} onChange={event => update({ seed: event.target.value })} /></label>
      <label>{t('script.time')}<input value={draft.time} onChange={event => update({ time: event.target.value })} /></label>
      <button type="button" onClick={() => update({ time: new Date().toISOString() })}>{t('script.timeNow')}</button>
    </details>
    <details><summary>{t('script.modules')}</summary><label>{t('script.moduleName')}<input maxLength={128} value={newModuleName} onChange={event => setNewModuleName(event.target.value)} /></label>
      <div className="pcad-script__actions"><button type="button" onClick={() => {
        if (!isScriptModuleName(newModuleName) || draft.modules.some(item => item.name === newModuleName) || draft.modules.length >= SCRIPT_LIMITS.modules) {
          useAppStore.setState({ scriptMessage: t('script.moduleInvalid') }); return;
        }
        update({ modules: [...draft.modules, { name: newModuleName, source: '' }] }); setActiveFile(newModuleName); setNewModuleName('');
      }}>{t('script.moduleAdd')}</button>{module === undefined ? null : <button type="button" onClick={() => {
        update({ modules: draft.modules.filter(item => item !== module) }); setActiveFile('user-script.js');
      }}>{t('script.moduleDelete')}</button>}</div>
    </details>
    <details open><summary>{t('script.console')}</summary>{logs.map((line, index) => <pre key={index} data-level={line.level}>{line.text}</pre>)}
      {runLog === null ? null : <dl className="pcad-script__metrics"><dt>{t('script.logInput')}</dt><dd>API {runLog.apiVersion} / seed {runLog.seed}<br />{new Date(runLog.timeMs).toISOString()}<br />SHA-256 {runLog.sha256}</dd>
        <dt>CAD</dt><dd>{runLog.commandCount} / {runLog.cadMs.toFixed(1)} ms</dd><dt>JavaScript</dt><dd>{runLog.javascriptMs.toFixed(1)} ms</dd><dt>VM</dt><dd>{runLog.initializationMs.toFixed(1)} ms</dd></dl>}
    </details>
    <details open data-help-topic="script-tools"><summary>{t('script.tools')}</summary>{tools.length === 0 ? <p>{t('script.toolsEmpty')}</p> : tools.map(tool => {
      const Icon = SCRIPT_ICON_COMPONENTS[tool.icon];
      return <div key={tool.scriptId} className="pcad-script__tool"><span><Icon />{tool.name}</span><div className="pcad-script__actions">
        <button type="button" disabled={running} title={`${tool.name}: ${t('script.runTooltip')}`} onClick={() => { void runScript(tool); }}>{t('script.run')}</button>
        <button type="button" onClick={() => { openScriptPanel(tool); setActiveFile('user-script.js'); }}>{t('script.edit')}</button>
        <button type="button" disabled={libraryBusy} onClick={() => { void deleteScriptTool(tool.scriptId); }}>{t('script.delete')}</button></div></div>;
    })}{deleted === null ? null : <button type="button" disabled={libraryBusy} onClick={() => { void restoreScriptTool(); }}>{t('script.restore')}</button>}</details>
    <div className="pcad-script__actions">{[['scripts', 'script.help'], ['script-api', 'script.apiHelp'], ['script-tools', 'script.toolsHelp']].map(([topic, key]) =>
      <button key={topic} type="button" onClick={() => useAppStore.getState().openHelpTopic(topic)}>{key === 'script.help' ? t('script.help') : key === 'script.apiHelp' ? t('script.apiHelp') : t('script.toolsHelp')}</button>)}</div>
  </section>;
}
