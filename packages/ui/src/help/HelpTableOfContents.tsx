import { MANUAL_VOLUMES, type HelpTopic } from '@pointercad/help-content';

export function HelpTableOfContents({ topics, topicId, searching, onChoose }: {
  readonly topics: readonly HelpTopic[]; readonly topicId: string; readonly searching: boolean;
  readonly onChoose: (id: string) => void;
}): React.JSX.Element {
  const list = (entries: readonly HelpTopic[]) => <ul>{entries.map(topic => <li key={topic.id}>
    <button title={topic.title} type="button" className="pcad-help__topic" aria-current={topic.id === topicId ? 'page' : undefined}
      onClick={() => onChoose(topic.id)}>{topic.title}</button>
  </li>)}</ul>;
  if (searching) return list(topics);
  const byId = new Map(topics.map(topic => [topic.id, topic]));
  return <>{MANUAL_VOLUMES.map(volume => <section key={volume.id} className="pcad-help__volume">
    <h3>{volume.title}</h3>
    {list(volume.topics.flatMap(id => { const topic = byId.get(id); return topic ? [topic] : []; }))}
  </section>)}</>;
}
