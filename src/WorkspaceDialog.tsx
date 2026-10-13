import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useLanguage } from './Language';
import { Icon } from './Icons';

/** Optional tools live above the workspace without resizing the video. */
export function WorkspaceDialog({ open, onClose, title, children, className = '' }: {
  open: boolean; onClose(): void; title: string; children: ReactNode; className?: string;
}) {
  const { t } = useLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      node.showModal();
    } else if (!open && node.open) {
      node.close();
      trigger.current?.focus({ preventScroll: true });
    }
  }, [open]);
  return <dialog ref={dialog} className={`workspace-dialog editor-dialog ${className}`} aria-label={title}
    onCancel={event => { event.preventDefault(); onClose(); }} onClose={() => { if (open) onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}>
    <div className="dialog-header"><h2>{title}</h2><button type="button" className="icon-button" aria-label={t('Закрыть')} onClick={onClose}><Icon name="close" size={20} /></button></div>
    <div className="editor-dialog-content">{children}</div>
  </dialog>;
}
