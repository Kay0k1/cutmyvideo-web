import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useLanguage } from './Language';
import { Icon } from './Icons';

/** Optional tools live above the workspace without resizing the video. */
export function WorkspaceDialog({ open, onClose, title, children, className = '', modal = true }: {
  open: boolean; onClose(): void; title: string; children: ReactNode; className?: string; modal?: boolean;
}) {
  const { t } = useLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (modal) node.showModal(); else node.show();
    } else if (!open && node.open) {
      const restoreFocus = modal || node.contains(document.activeElement);
      node.close();
      if (restoreFocus) trigger.current?.focus({ preventScroll: true });
    }
  }, [open, modal]);
  useEffect(() => {
    if (!open || modal) return;
    // Export is an inspector: outside actions dismiss it, while its nested
    // settings dialog still owns modal focus and Escape handling.
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !dialog.current?.contains(event.target)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('dialog:modal')) { event.preventDefault(); onClose(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open, modal, onClose]);
  return <dialog ref={dialog} className={`workspace-dialog editor-dialog ${className}`} aria-label={title}
    onCancel={event => { event.preventDefault(); onClose(); }} onClose={() => { if (open) onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}>
    <div className="dialog-header"><h2>{title}</h2><button type="button" className="icon-button" aria-label={t('Закрыть')} onClick={onClose}><Icon name="close" size={20} /></button></div>
    <div className="editor-dialog-content">{children}</div>
  </dialog>;
}
