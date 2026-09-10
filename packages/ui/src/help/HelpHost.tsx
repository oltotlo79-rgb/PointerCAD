import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/useAppStore.js';
import { HelpDialog } from './HelpDialog.js';
import './help.css';

export function HelpHost(): React.JSX.Element | null {
  const topicId = useAppStore((state) => state.helpTopicId);
  const documentId = useAppStore((state) => state.activeDocumentId);
  const previousDocument = useRef(documentId);
  useEffect(() => {
    if (previousDocument.current !== documentId) { previousDocument.current = documentId; useAppStore.getState().closeHelp(); }
  }, [documentId]);
  if (topicId === null) return null;
  return <HelpDialog topicId={topicId} />;
}
