import { useState } from 'react';

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

  function startRename(diagram: Diagram) {
    setRenaming(diagram.id);
    setDraft(diagram.name);
  }

  function commitRename() {
    if (renaming && draft.trim()) onRename(renaming, draft.trim());
    setRenaming(null);
  }

  return (
    <div className={styles.bar} role="tablist" aria-label="Diagrams">
      {diagrams.map((diagram) => {
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
              role="tab"
              aria-selected={isActive}
              className={styles.name}
              title={isActive ? 'Double-click to rename' : `Switch to ${diagram.name}`}
              onClick={() => onSelect(diagram.id)}
              onDoubleClick={() => isActive && startRename(diagram)}
            >
              {diagram.name}
            </button>

            {/* Actions belong to the diagram you are on, so the bar stays quiet. */}
            {isActive ? (
              <>
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
                  onClick={() => onDelete(diagram.id)}
                >
                  ✕
                </button>
              </>
            ) : null}
          </div>
        );
      })}

      <button type="button" className={styles.add} onClick={onAdd}>
        + Diagram
      </button>
    </div>
  );
}
