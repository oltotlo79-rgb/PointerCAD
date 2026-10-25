import { t } from '../i18n/t.js';
import type { SolidModeDisplay, SolidModePhase, SolidModePreview, SolidModeResult } from './solidModeView.js';

/** Display amplitude typed by the user: a finite number >= 0 (mm), or null. */
export function parseSolidModeAmplitude(text: string): number | null {
  if (text.trim() === '') return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export interface SolidModePanelProps {
  /** The completed modal result, or null when there is none. */
  readonly result: SolidModeResult | null;
  /** True when the last modal solve failed: no mode is offered, nothing is shown as a success. */
  readonly failed: boolean;
  readonly display: SolidModeDisplay;
  /** Text of the amplitude field (kept by the owner so an invalid draft is not lost). */
  readonly amplitudeText: string;
  /** projectSolidMode(result, current source, display); the owner sends a `preview` to the viewport and clears it otherwise. */
  readonly preview: SolidModePreview | null;
  readonly onDisplayChange: (display: SolidModeDisplay) => void;
  readonly onAmplitudeTextChange: (text: string) => void;
}

const PHASES: readonly { readonly phase: SolidModePhase; readonly label: 'solidAnalysis.modalPhasePositive' | 'solidAnalysis.modalPhaseNegative' }[] = [
  { phase: 1, label: 'solidAnalysis.modalPhasePositive' },
  { phase: -1, label: 'solidAnalysis.modalPhaseNegative' },
];

/** Accessible modal result section: frequencies, mode choice, display amplitude and phase. Display only. */
export function SolidModePanel(props: SolidModePanelProps) {
  const { result, failed, display, amplitudeText, preview, onDisplayChange, onAmplitudeTextChange } = props;
  if (failed) return <section role="alert" data-testid="solid-modal-failed"><p>{t('solidAnalysis.modalFailed')}</p></section>;
  if (result === null) return <p data-testid="solid-modal-empty">{t('solidAnalysis.modalEmpty')}</p>;
  const amplitudeValid = parseSolidModeAmplitude(amplitudeText) !== null;
  return <section aria-label={t('solidAnalysis.modalResults')} data-testid="solid-modal-results">
    <h4>{t('solidAnalysis.modalResults')}</h4>
    <p id="solid-modal-meaning">{t('solidAnalysis.modalMeaning')}</p>
    <fieldset>
      <legend>{t('solidAnalysis.modalModes')} ({t('solidAnalysis.modalFrequency')})</legend>
      {result.modes.map(mode => <label key={mode.number}>
        <input type="radio" name="solid-modal-mode" value={mode.number} checked={display.modeNumber === mode.number}
          data-testid={`solid-modal-mode-${String(mode.number)}`}
          onChange={() => { onDisplayChange({ ...display, modeNumber: mode.number }); }} title={t('solidAnalysis.guide.modalModeChoice')} />
        {`${t('solidAnalysis.modalMode')} ${String(mode.number)}: ${String(mode.frequencyHz)} Hz`}
      </label>)}
    </fieldset>
    <label>{t('solidAnalysis.modalAmplitude')}
      <input type="text" inputMode="decimal" value={amplitudeText} aria-invalid={!amplitudeValid} aria-describedby="solid-modal-meaning"
        data-testid="solid-modal-amplitude"
        onChange={event => {
          const text = event.currentTarget.value;
          onAmplitudeTextChange(text);
          // An invalid draft becomes NaN, which projectSolidMode refuses, so the old preview is cleared, not kept.
          onDisplayChange({ ...display, amplitudeMm: parseSolidModeAmplitude(text) ?? Number.NaN });
        }} title={t('solidAnalysis.guide.modeAmplitude')} />
    </label>
    {amplitudeValid ? null : <p role="alert">{t('solidAnalysis.modalAmplitudeInvalid')}</p>}
    <fieldset>
      <legend>{t('solidAnalysis.modalPhase')}</legend>
      {PHASES.map(({ phase, label }) => <label key={phase}>
        <input type="radio" name="solid-modal-phase" value={phase} checked={display.phase === phase}
          data-testid={`solid-modal-phase-${phase === 1 ? 'positive' : 'negative'}`}
          onChange={() => { onDisplayChange({ ...display, phase }); }} title={t(phase === 1 ? 'solidAnalysis.guide.phasePositive' : 'solidAnalysis.guide.phaseNegative')} />
        {t(label)}
      </label>)}
    </fieldset>
    {preview !== null && preview.kind === 'none'
      ? <p role="status" data-testid="solid-modal-no-preview">
        {t(preview.reason === 'stale' ? 'solidAnalysis.modalStale' : 'solidAnalysis.modalUnavailable')}</p>
      : null}
  </section>;
}
