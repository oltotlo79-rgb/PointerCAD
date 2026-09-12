import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from '../i18n/t.js';

/** Keep the document, save controls and kernel alive when the 3D view fails. */
export class ViewportBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('PointerCAD 3D view failed', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <div className="pcad-viewport__overlay">
      <div className="pcad-card pcad-viewport__failure" role="alert">
        <p>{t('viewport.failed')}</p>
        <p>{t('viewport.failedAdvice')}</p>
        <button className="pcad-button" type="button" onClick={() => { this.setState({ failed: false }); }}>
          {t('viewport.retry')}
        </button>
      </div>
    </div>;
  }
}
