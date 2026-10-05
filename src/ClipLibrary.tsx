import { useEffect, useRef, useState } from 'react';
import { useLanguage } from './Language';
import { Icon } from './Icons';
import { countLabel } from './locales';
import { maxClips } from './clipCollection';
import { displayTimecode, durationLabel } from './timecode';
import type { ClipRange } from './types';

function ClipCheckbox({ checked, mixed, label, onChange, disabled }: { checked: boolean; mixed?: boolean; label: string; onChange(): void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (input.current) input.current.indeterminate = !!mixed; }, [mixed]);
  return <label className="clip-checkbox"><input ref={input} type="checkbox" checked={checked} aria-label={label} onChange={onChange} disabled={disabled} /><span aria-hidden="true">{mixed ? '−' : checked && <Icon name="check" size={15} />}</span></label>;
}

export type ClipSnapshot = { ranges: ClipRange[]; selectedIds: string[]; editedId: string };

export function ClipLibrary({ ranges, selectedIds, editedId, revealId, onSelect, onSelectAll, onEdit, onAdd, onLabel, onDuplicate, onDelete, onDeleteOne, onRestore, onExport }: {
  ranges: ClipRange[]; selectedIds: string[]; editedId: string; revealId: string;
  onSelect(id: string): void; onSelectAll(): void; onEdit(range: ClipRange): void; onAdd(): void;
  onLabel(id: string, label: string): void; onDuplicate(): void; onDelete(): void; onDeleteOne(id: string): void; onRestore(snapshot: ClipSnapshot): void; onExport(): void;
}) {
  const { locale, t } = useLanguage();
  const section = useRef<HTMLElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const [deleted, setDeleted] = useState<ClipSnapshot | null>(null);
  const selected = new Set(selectedIds);
  const included = ranges.filter(range => selected.has(range.id));
  const duplicateLimit = included.length > 0 && ranges.length + included.length > maxClips;
  const mutate = (action: () => void) => { setDeleted(null); action(); };
  const rememberDeletion = () => setDeleted({ ranges, selectedIds, editedId });
  useEffect(() => {
    const node = list.current;
    if (!node) return;
    const reveal = () => {
      const row = [...node.children].find(element => (element as HTMLElement).dataset.rangeId === revealId) as HTMLElement | undefined;
      if (!row) return;
      const top = row.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop;
      if (top < node.scrollTop) node.scrollTop = top;
      else if (top + row.offsetHeight > node.scrollTop + node.clientHeight) node.scrollTop = top + row.offsetHeight - node.clientHeight;
    };
    reveal();
    const observer = new ResizeObserver(reveal); observer.observe(node);
    return () => observer.disconnect();
  }, [revealId, ranges.length]);
  const deleteOne = (id: string, index: number) => {
    rememberDeletion();
    onDeleteOne(id);
    const nextId = ranges[index + 1]?.id ?? ranges[index - 1]?.id;
    window.requestAnimationFrame(() => {
      const row = [...(list.current?.children ?? [])].find(element => (element as HTMLElement).dataset.rangeId === nextId);
      (row?.querySelector('input[type="checkbox"]') as HTMLElement | null ?? section.current?.querySelector<HTMLButtonElement>('.clip-empty .button'))?.focus({ preventScroll: true });
    });
  };
  const deleteIncluded = () => {
    rememberDeletion();
    onDelete();
    window.requestAnimationFrame(() => section.current?.querySelector<HTMLElement>('.clip-empty .button, .clip-select-all input')?.focus({ preventScroll: true }));
  };
  const undoDeletion = () => {
    if (!deleted) return;
    onRestore(deleted);
    setDeleted(null);
    window.requestAnimationFrame(() => section.current?.querySelector<HTMLInputElement>('.clip-select-all input')?.focus({ preventScroll: true }));
  };
  return <section ref={section} className="clip-library" aria-label={t('Фрагменты')}>
    <div className="clip-library-heading"><div><h2>{countLabel(ranges.length, 'clip', locale)}</h2><p>{t('Отметьте фрагменты для экспорта. Остальные останутся в списке.')}</p></div>{ranges.length > 0 && <button className="button secondary" type="button" onClick={onAdd} disabled={ranges.length >= maxClips}><Icon name="plus" size={17} />{t('Добавить фрагмент')}</button>}</div>
    {ranges.length > 0 ? <>
      <div className="clip-bulkbar"><div className="clip-select-all"><ClipCheckbox checked={included.length === ranges.length} mixed={included.length > 0 && included.length < ranges.length} label={t('Выбрать все фрагменты')} onChange={() => mutate(onSelectAll)} /><span>{t('Выбрать все')}</span></div><span className="clip-selected-count" role="status">{t('Выбрано: {count} из {total}', { count: included.length, total: ranges.length })}</span><div className="clip-bulk-actions"><button className="text-button" type="button" onClick={() => mutate(onDuplicate)} disabled={!included.length || duplicateLimit} aria-describedby={duplicateLimit ? 'clip-limit-hint' : undefined}><Icon name="duplicate" size={17} />{t('Дублировать выбранные')}</button><button className="text-button danger-button" type="button" onClick={deleteIncluded} disabled={!included.length}><Icon name="trash" size={17} />{t('Удалить выбранные')}</button></div></div>
      <ol ref={list} className="range-list clip-list">{ranges.map((range, index) => <li key={range.id} data-range-id={range.id} className={range.id === editedId ? 'editing' : ''}>
        <ClipCheckbox checked={selected.has(range.id)} label={t('Выбрать фрагмент {index}', { index: index + 1 })} onChange={() => mutate(() => onSelect(range.id))} />
        <div className="clip-row-body"><input className="clip-row-name" type="text" value={range.label} maxLength={50} placeholder={`${t('Фрагмент')} ${index + 1}`} aria-label={t('Название фрагмента {index}', { index: index + 1 })} onChange={event => mutate(() => onLabel(range.id, event.target.value))} /><div className="clip-row-times"><span>{displayTimecode(range.start_ms)} — {displayTimecode(range.end_ms)}</span><span>{durationLabel(range.end_ms - range.start_ms, locale)}</span></div></div>
        <button className="button secondary clip-edit" type="button" aria-label={t('Редактировать фрагмент {index}', { index: index + 1 })} onClick={() => onEdit(range)}><Icon name="edit" size={16} /><span>{t('Редактировать')}</span></button>
        <button className="icon-button delete-range" type="button" aria-label={t('Удалить фрагмент {index}', { index: index + 1 })} onClick={() => deleteOne(range.id, index)}><Icon name="trash" size={17} /></button>
      </li>)}</ol>
    </> : <div className="clip-empty"><Icon name="cut" size={27} /><h3>{t('Пока нет фрагментов')}</h3><p>{t('Добавьте момент, который хотите сохранить.')}</p><button className="button primary" type="button" onClick={onAdd}><Icon name="plus" size={17} />{t('Добавить первый фрагмент')}</button></div>}
    {deleted && <div className="clip-undo"><p role="status">{t('Фрагменты удалены. Можно восстановить последнее удаление.')}</p><button className="button secondary" type="button" onClick={undoDeletion}>{t('Восстановить фрагменты')}</button></div>}
    <div className="clip-library-footer"><p id="clip-limit-hint">{duplicateLimit && ranges.length < maxClips ? t('Для копий не хватает места. Выберите меньше фрагментов: в списке может быть до 12.') : ranges.length >= maxClips ? t('В одном задании — до 12 фрагментов.') : !included.length && ranges.length ? t('Выберите хотя бы один фрагмент для экспорта.') : t('Каждый выбранный фрагмент будет отдельным файлом.')}</p><button className="button primary" type="button" disabled={!included.length} onClick={onExport}>{t('К настройкам экспорта')}<Icon name="chevron" size={17} /></button></div>
  </section>;
}
