import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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
  const [pendingDelete, setPendingDelete] = useState<DiagramId | null>(null);
  // Spelled as a shape rather than `DiagramId | 'add'`: ids are strings, so
  // that union collapses to `string` and a diagram whose id really were "add"
  // would steer the focus at the button instead of at itself.
  const [focusAfterDelete, setFocusAfterDelete] = useState<
    { kind: 'tab'; id: DiagramId } | { kind: 'add' } | null
  >(null);
  const tabs = useRef(new Map<DiagramId, HTMLButtonElement>());
  const addButton = useRef<HTMLButtonElement | null>(null);
  const deleteButton = useRef<HTMLButtonElement | null>(null);
  const cancelButton = useRef<HTMLButtonElement | null>(null);
  const confirmButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!focusAfterDelete) return;
    const target =
      focusAfterDelete.kind === 'add' ? addButton.current : tabs.current.get(focusAfterDelete.id);
    if (!target) return;
    target.focus();
    setFocusAfterDelete(null);
  }, [diagrams, focusAfterDelete]);

  useEffect(() => {
    if (!pendingDelete) return;
    cancelButton.current?.focus();
  }, [pendingDelete]);

  function startRename(diagram: Diagram) {
    setRenaming(diagram.id);
    setDraft(diagram.name);
  }

  function commitRename() {
    if (renaming && draft.trim()) onRename(renaming, draft.trim());
    setRenaming(null);
  }

  function cancelDelete() {
    setPendingDelete(null);
    deleteButton.current?.focus();
  }

  function deleteDiagram() {
    const index = diagrams.findIndex((diagram) => diagram.id === pendingDelete);
    if (index < 0) {
      setPendingDelete(null);
      return;
    }
    // Pick the following diagram first, then the preceding one. Deleting the
    // final diagram creates a fresh id in the document layer, so the Add button
    // is the only stable, reachable target in that case.
    const neighbour = diagrams[index + 1]?.id ?? diagrams[index - 1]?.id;
    setFocusAfterDelete(neighbour ? { kind: 'tab', id: neighbour } : { kind: 'add' });
    setPendingDelete(null);
    onDelete(diagrams[index].id);
  }

  const deleteTarget = diagrams.find((diagram) => diagram.id === pendingDelete);

  return (
    <>
      <nav className={styles.bar} aria-label="Diagrams">
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
                className={styles.name}
                aria-current={isActive ? 'page' : undefined}
                ref={(element) => {
                  if (element) tabs.current.set(diagram.id, element);
                  else tabs.current.delete(diagram.id);
                }}
                title={isActive ? `Rename ${diagram.name}` : `Switch to ${diagram.name}`}
                onClick={() => {
                  if (isActive) startRename(diagram);
                  else onSelect(diagram.id);
                }}
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
                    ref={deleteButton}
                    onClick={() => setPendingDelete(diagram.id)}
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
      {deleteTarget
        ? createPortal(
            <div className={styles.overlay}>
              <div
                className={styles.dialog}
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="finance-delete-dialog-title"
                aria-describedby="finance-delete-dialog-description"
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelDelete();
                  }
                  if (event.key === 'Tab') {
                    if (event.shiftKey && document.activeElement === cancelButton.current) {
                      event.preventDefault();
                      confirmButton.current?.focus();
                    } else if (
                      !event.shiftKey &&
                      document.activeElement === confirmButton.current
                    ) {
                      event.preventDefault();
                      cancelButton.current?.focus();
                    }
                  }
                }}
              >
                <h2 id="finance-delete-dialog-title">Delete diagram?</h2>
                <p id="finance-delete-dialog-description">
                  Delete <strong>{deleteTarget.name}</strong> and everything in it? This cannot be
                  undone.
                </p>
                <div className={styles.dialogActions}>
                  <button
                    ref={cancelButton}
                    type="button"
                    className={styles.cancelButton}
                    onClick={cancelDelete}
                  >
                    Cancel
                  </button>
                  <button
                    ref={confirmButton}
                    type="button"
                    className={styles.deleteButton}
                    onClick={deleteDiagram}
                  >
                    Delete diagram
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
