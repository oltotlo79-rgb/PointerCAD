import { Component, lazy, Suspense, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import { t } from '../i18n/t.js';

/**
 * Load one named export of a module on first use. Keeping the wait here means panels that also
 * edit the document (PropertyPanel) contain no await of their own, so `store/documentRequest.test.ts`
 * still watches them for document writes after a wait.
 */
export function deferredExport<K extends string, M extends Readonly<Record<K, ComponentType>>>(
  load: () => Promise<M>, name: K, floating = false,
): ComponentType {
  return deferredShell(async () => ({ default: (await load())[name] }), floating);
}

/** Load a workspace panel on first use; a failed chunk must not discard the editor/document. */
export function deferredShell(load: () => Promise<{ readonly default: ComponentType }>, floating = false): ComponentType {
  const first = lazy(load);
  return class DeferredShell extends Component {
    override state = { failed: false, View: first };

    static getDerivedStateFromError(): { readonly failed: boolean } { return { failed: true }; }

    override componentDidCatch(error: Error, info: ErrorInfo): void {
      console.error('PointerCAD panel loading failed', error, info.componentStack);
    }

    override render(): ReactNode {
      // A help-loading notice must not become a sixth row in the editor's fixed layout.
      const style = floating ? { position: 'fixed' as const, right: 24, bottom: 40, zIndex: 50 } : undefined;
      if (this.state.failed) return <div className="pcad-card" style={style} role="alert">
        <p>{t('bootstrap.failed')}</p>
        <button type="button" className="pcad-button" title={t('viewport.retry')}
          onClick={() => { this.setState({ failed: false, View: lazy(load) }); }}>{t('viewport.retry')}</button>
      </div>;
      const View = this.state.View;
      return <Suspense fallback={<div className="pcad-card" style={style} role="status">{t('bootstrap.loading')}</div>}>
        <View />
      </Suspense>;
    }
  };
}
