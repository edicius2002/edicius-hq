import { useEffect, useRef, useState } from 'react';

import type { Diagram, DiagramId } from '@/features/finance/model/types';

import styles from './DiagramTabs.module.css';

type DiagramTabsProps = {
  diagrams: Diagram[];
  activeId: DiagramId;
  onSelect: (id: DiagramId) => void;
  onAdd: () => void;
  onDuplicate: (id: DiagramId) => void;
  onRename: (id: DiagramId, name: string) => void;
  onDelete: (id: DiagramId) => void;
};

export function DiagramTabs({
  diagrams,
  activeId,
  onSelect,
  onAdd,
  onDuplicate,
  onRename,
  onDelete,
}: DiagramTabsProps) {
  const [renaming, setRenaming] = useState<DiagramId | null>(null);
  const [draft, setDraft] = useState('');
  // Spelled as a shape rather than `DiagramId | 'add'`: ids are strings, so
  // that union collapses to `string` and a diagram whose id really were "add"
  // would steer the focus at the button instead of at itself.
  const [focusAfterDelete, setFocusAfterDelete] = useState<
    { kind: 'tab'; id: DiagramId } | { kind: 'add' } | null
  >(null);
  const tabs = useRef(new Map<DiagramId, HTMLButtonElement>());
  const addButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!focusAfterDelete) return;
    const target =
      focusAfterDelete.kind === 'add' ? addButton.current : tabs.current.get(focusAfterDelete.id);
    if (!target) return;
    target.focus();
    setFocusAfterDelete(null);
  }, [diagrams, focusAfterDelete]);

  function startRename(diagram: Diagram) {
    setRenaming(diagram.id);
    setDraft(diagram.name);
  }

  function commitRename() {
    if (renaming && draft.trim()) onRename(renaming, draft.trim());
    setRenaming(null);
  }

  function deleteDiagram(diagram: Diagram, index: number) {
    // Pick the following diagram first, then the preceding one. Deleting the
    // final diagram creates a fresh id in the document layer, so the Add button
    // is the only stable, reachable target in that case.
    const neighbour = diagrams[index + 1]?.id ?? diagrams[index - 1]?.id;
    setFocusAfterDelete(neighbour ? { kind: 'tab', id: neighbour } : { kind: 'add' });
    onDelete(diagram.id);
  }

  return (
    <nav className={styles.bar} aria-label="Diagrams">
      {diagrams.map((diagram, index) => {
        const isActive = diagram.id === activeId;

        if (renaming === diagram.id) {
          return (
            <input
              key={diagram.id}
              className={styles.rename}
              value={draft}
              autoFocus
              aria-label={`Rename ${diagram.name}`}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitRename();
                // Escape abandons the edit rather than saving a half-typed name.
                if (event.key === 'Escape') setRenaming(null);
              }}
            />
          );
        }

        return (
          <div key={diagram.id} className={`${styles.tab} ${isActive ? styles.active : ''}`}>
            <button
              type="button"
              className={styles.name}
              aria-current={isActive ? 'page' : undefined}
              ref={(element) => {
                if (element) tabs.current.set(diagram.id, element);
                else tabs.current.delete(diagram.id);
              }}
              title={`Switch to ${diagram.name}`}
              onClick={() => onSelect(diagram.id)}
            >
              {diagram.name}
            </button>

            {/* Actions belong to the diagram you are on, so the bar stays quiet. */}
            {isActive ? (
              <>
                <button
                  type="button"
                  className={styles.action}
                  title={`Rename ${diagram.name}`}
                  aria-label={`Rename ${diagram.name}`}
                  onClick={() => startRename(diagram)}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className={styles.action}
                  title={`Duplicate ${diagram.name}`}
                  aria-label={`Duplicate ${diagram.name}`}
                  onClick={() => onDuplicate(diagram.id)}
                >
                  ⧉
                </button>
                <button
                  type="button"
                  className={`${styles.action} ${styles.danger}`}
                  title={`Delete ${diagram.name}`}
                  aria-label={`Delete ${diagram.name}`}
                  onClick={() => deleteDiagram(diagram, index)}
                >
                  ✕
                </button>
              </>
            ) : null}
          </div>
        );
      })}

      <button ref={addButton} type="button" className={styles.add} onClick={onAdd}>
        + Diagram
      </button>
    </nav>
  );
}
