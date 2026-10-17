import { useEffect, useId, useRef } from 'react';
import { useLanguage } from './Language';
import { Icon } from './Icons';
import { countLabel } from './locales';
import { displayTimecode, durationLabel } from './timecode';
import type { ClipRange } from './types';
import './ClipLibrary.css';

function ClipCheckbox({ id, checked, mixed, label, onChange, disabled }: { id?: string; checked: boolean; mixed?: boolean; label: string; onChange(): void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (input.current) input.current.indeterminate = !!mixed; }, [mixed]);
  return <label className="clip-checkbox"><input ref={input} id={id} type="checkbox" checked={checked} aria-label={label} onChange={onChange} disabled={disabled} /><span aria-hidden="true">{mixed ? '−' : checked && <Icon name="check" size={15} />}</span></label>;
}

export function ClipLibrary({ limit, ranges, selectedIds, editedId, revealId, onSelect, onSelectAll, onEdit, onAdd, onLabel, onDuplicate, onDelete, onDeleteOne, onExport, onPreview, canPreview, onMove, onBeginChange, onEndChange, compact = false, disabled = false }: {
  limit: number; ranges: ClipRange[]; selectedIds: string[]; editedId: string; revealId: string;
  onMove?(id: string, direction: -1 | 1): void; onBeginChange?(): void; onEndChange?(): void;
  onSelect(id: string): void; onSelectAll(): void; onEdit(range: ClipRange): void; onAdd(): void;
  onLabel(id: string, label: string): void; onDuplicate(): void; onDelete(): void; onDeleteOne(id: string): void; onExport(): void;
  onPreview?(): void; canPreview?: boolean;
  compact?: boolean; disabled?: boolean;
}) {
  const { locale, t } = useLanguage();
  const section = useRef<HTMLElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const selectAllID = useId();
  const selected = new Set(selectedIds);
  const included = ranges.filter(range => selected.has(range.id));
  const duplicateLimit = included.length > 0 && ranges.length + included.length > limit;
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
    onDeleteOne(id);
    const nextId = ranges[index + 1]?.id ?? ranges[index - 1]?.id;
    window.requestAnimationFrame(() => {
      const row = [...(list.current?.children ?? [])].find(element => (element as HTMLElement).dataset.rangeId === nextId);
      (row?.querySelector('input[type="checkbox"]') as HTMLElement | null ?? section.current?.querySelector<HTMLButtonElement>('.clip-empty .button'))?.focus({ preventScroll: true });
    });
  };
  const deleteIncluded = () => {
    onDelete();
    window.requestAnimationFrame(() => section.current?.querySelector<HTMLElement>('.clip-empty .button, .clip-select-all input')?.focus({ preventScroll: true }));
  };
  if (compact) {
    const hintID = `${selectAllID}-limit`;
    return <section ref={section} className="clip-library compact" data-at-limit={ranges.length >= limit || undefined} aria-label={t('Фрагменты')}>
      <div className="clip-library-heading"><h2>{t('Фрагменты')}<span className="clip-total">{ranges.length}</span></h2><button className="button secondary clip-add-button" type="button" onClick={onAdd} disabled={disabled || ranges.length >= limit} aria-label={t('Добавить фрагмент')} title={ranges.length >= limit ? t('В одном задании — до {limit} фрагментов.', { limit }) : t('Добавить фрагмент')} aria-describedby={ranges.length >= limit ? hintID : undefined}><Icon name="plus" size={17} /><span>{t('Добавить')}</span></button></div>
      {ranges.length > 0 ? <>
        <div className="clip-bulkbar"><div className="clip-select-all"><ClipCheckbox id={selectAllID} checked={included.length === ranges.length} mixed={included.length > 0 && included.length < ranges.length} label={t('Выбрать все фрагменты')} onChange={onSelectAll} disabled={disabled} /><label htmlFor={selectAllID}>{t('Выбрать все')}</label></div><span className="clip-selected-count" role="status" aria-label={t('Выбрано: {count} из {total}', { count: included.length, total: ranges.length })}>{included.length}/{ranges.length}</span><details className="clip-bulk-menu"><summary className="icon-button" aria-label={t('Действия с выбранными')} aria-disabled={disabled} tabIndex={disabled ? -1 : 0} onClick={event => { if (disabled) event.preventDefault(); }}><span aria-hidden="true">···</span></summary><div className="clip-bulk-actions"><button className="text-button" type="button" onClick={onDuplicate} disabled={disabled || !included.length || duplicateLimit} aria-describedby={duplicateLimit ? hintID : undefined}><Icon name="duplicate" size={17} />{t('Дублировать выбранные')}</button><button className="text-button danger-button" type="button" onClick={deleteIncluded} disabled={disabled || !included.length}><Icon name="trash" size={17} />{t('Удалить выбранные')}</button></div></details></div>
        <ol ref={list} className="range-list clip-list">{ranges.map((range, index) => <li key={range.id} data-range-id={range.id} className={range.id === editedId ? 'editing' : ''}>
          <ClipCheckbox checked={selected.has(range.id)} label={t('Выбрать фрагмент {index}', { index: index + 1 })} onChange={() => onSelect(range.id)} disabled={disabled} />
          <div className="clip-row-body"><label className="clip-row-title"><input className="clip-row-name" type="text" value={range.label} maxLength={50} placeholder={`${t('Фрагмент')} ${index + 1}`} aria-label={t('Название фрагмента {index}', { index: index + 1 })} disabled={disabled} onFocus={() => onBeginChange?.()} onBlur={() => onEndChange?.()} onChange={event => onLabel(range.id, event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} /></label></div>
          <button className="clip-edit clip-compact-edit" type="button" aria-label={t('Редактировать фрагмент {index}', { index: index + 1 })} aria-pressed={range.id === editedId} disabled={disabled} onClick={() => onEdit(range)}><span className="clip-row-times"><span>{displayTimecode(range.start_ms)} — {displayTimecode(range.end_ms)}</span><span>{durationLabel(range.end_ms - range.start_ms, locale)}</span></span><span className="clip-edit-label"><Icon name="edit" size={14} />{t('Редактировать')}</span></button>
          <details className="clip-row-menu"><summary className="icon-button" aria-label={t('Действия с фрагментом {index}', { index: index + 1 })} aria-disabled={disabled} tabIndex={disabled ? -1 : 0} onClick={event => { if (disabled) event.preventDefault(); }}><span aria-hidden="true">···</span></summary><div className="clip-row-actions">{onMove && <><button type="button" className="icon-button" disabled={disabled || index === 0} aria-label={t('Переместить фрагмент {index} вверх', { index: index + 1 })} title={t('Переместить фрагмент {index} вверх', { index: index + 1 })} onClick={() => onMove(range.id, -1)}><Icon name="chevron" size={17} style={{ transform: 'rotate(-90deg)' }} /></button><button type="button" className="icon-button" disabled={disabled || index === ranges.length - 1} aria-label={t('Переместить фрагмент {index} вниз', { index: index + 1 })} title={t('Переместить фрагмент {index} вниз', { index: index + 1 })} onClick={() => onMove(range.id, 1)}><Icon name="chevron" size={17} style={{ transform: 'rotate(90deg)' }} /></button></>}<button className="icon-button delete-range danger-button" type="button" disabled={disabled} aria-label={t('Удалить фрагмент {index}', { index: index + 1 })} title={t('Удалить фрагмент {index}', { index: index + 1 })} onClick={() => deleteOne(range.id, index)}><Icon name="trash" size={17} /></button></div></details>
        </li>)}</ol>
      </> : <div className="clip-empty"><Icon name="cut" size={25} /><h3>{t('Пока нет фрагментов')}</h3><p>{t('Добавьте момент, который хотите сохранить.')}</p><button className="button secondary" type="button" disabled={disabled || ranges.length >= limit} onClick={onAdd}><Icon name="plus" size={17} />{t('Добавить первый фрагмент')}</button></div>}
      {(duplicateLimit || ranges.length >= limit || (!included.length && ranges.length > 0)) && <p className="clip-compact-hint" id={hintID}>{duplicateLimit && ranges.length < limit ? t('Для копий не хватает места. Выберите меньше фрагментов: в списке может быть до {limit}.', { limit }) : ranges.length >= limit ? t('В одном задании — до {limit} фрагментов.', { limit }) : t('Выберите хотя бы один фрагмент для экспорта.')}</p>}
      {onPreview && <button type="button" className="button secondary clip-compact-preview" disabled={disabled || !included.length || !canPreview} onClick={onPreview}><Icon name="play" size={17} />{t('Посмотреть подборку')}</button>}
    </section>;
  }
  return <section ref={section} className="clip-library" aria-label={t('Фрагменты')}>
    <div className="clip-library-heading"><div><h2>{countLabel(ranges.length, 'clip', locale)}</h2><p>{t('Отметьте фрагменты для экспорта. Остальные останутся в списке.')}</p></div>{ranges.length > 0 && <button className="button secondary" type="button" onClick={onAdd} disabled={disabled || ranges.length >= limit}><Icon name="plus" size={17} />{t('Добавить фрагмент')}</button>}</div>
    {ranges.length > 0 ? <>
      <div className="clip-bulkbar"><div className="clip-select-all"><ClipCheckbox id={selectAllID} checked={included.length === ranges.length} mixed={included.length > 0 && included.length < ranges.length} label={t('Выбрать все фрагменты')} onChange={onSelectAll} disabled={disabled} /><label htmlFor={selectAllID}>{t('Выбрать все')}</label></div><span className="clip-selected-count" role="status">{t('Выбрано: {count} из {total}', { count: included.length, total: ranges.length })}</span><div className="clip-bulk-actions"><button className="text-button" type="button" onClick={onDuplicate} disabled={disabled || !included.length || duplicateLimit} aria-describedby={duplicateLimit ? 'clip-limit-hint' : undefined}><Icon name="duplicate" size={17} />{t('Дублировать выбранные')}</button><button className="text-button danger-button" type="button" onClick={deleteIncluded} disabled={disabled || !included.length}><Icon name="trash" size={17} />{t('Удалить выбранные')}</button></div></div>
      
      <ol ref={list} className="range-list clip-list">{ranges.map((range, index) => <li key={range.id} data-range-id={range.id} className={range.id === editedId ? 'editing' : ''}>
        <ClipCheckbox checked={selected.has(range.id)} label={t('Выбрать фрагмент {index}', { index: index + 1 })} onChange={() => onSelect(range.id)} disabled={disabled} />
        <div className="clip-row-body"><label className="clip-row-title"><input className="clip-row-name" type="text" disabled={disabled} value={range.label} maxLength={50} placeholder={`${t('Фрагмент')} ${index + 1}`} aria-label={t('Название фрагмента {index}', { index: index + 1 })} onFocus={() => onBeginChange?.()} onBlur={() => onEndChange?.()} onChange={event => onLabel(range.id, event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} /><Icon name="edit" size={14} /></label><div className="clip-row-times"><span>{displayTimecode(range.start_ms)} — {displayTimecode(range.end_ms)}</span><span>{durationLabel(range.end_ms - range.start_ms, locale)}</span></div></div>
        {onMove && <div className="clip-reorder"><button type="button" className="icon-button" disabled={disabled || index === 0} aria-label={t('Переместить фрагмент {index} вверх', { index: index + 1 })} onClick={() => onMove(range.id, -1)}><Icon name="chevron" size={15} style={{ transform: 'rotate(-90deg)' }} /></button><button type="button" className="icon-button" disabled={disabled || index === ranges.length - 1} aria-label={t('Переместить фрагмент {index} вниз', { index: index + 1 })} onClick={() => onMove(range.id, 1)}><Icon name="chevron" size={15} style={{ transform: 'rotate(90deg)' }} /></button></div>}
        <button className="button secondary clip-edit" type="button" disabled={disabled} aria-label={t('Редактировать фрагмент {index}', { index: index + 1 })} onClick={() => onEdit(range)}><Icon name="edit" size={16} /><span>{t('Редактировать')}</span></button>
        <button className="icon-button delete-range" type="button" disabled={disabled} aria-label={t('Удалить фрагмент {index}', { index: index + 1 })} onClick={() => deleteOne(range.id, index)}><Icon name="trash" size={17} /></button>
      </li>)}</ol>
    </> : <div className="clip-empty"><Icon name="cut" size={27} /><h3>{t('Пока нет фрагментов')}</h3><p>{t('Добавьте момент, который хотите сохранить.')}</p><button className="button primary" type="button" disabled={disabled || ranges.length >= limit} onClick={onAdd}><Icon name="plus" size={17} />{t('Добавить первый фрагмент')}</button></div>}
    
    <div className="clip-library-footer"><p id="clip-limit-hint">{duplicateLimit && ranges.length < limit ? t('Для копий не хватает места. Выберите меньше фрагментов: в списке может быть до {limit}.', { limit }) : ranges.length >= limit ? t('В одном задании — до {limit} фрагментов.', { limit }) : !included.length && ranges.length ? t('Выберите хотя бы один фрагмент для экспорта.') : t('Порядок списка задаёт порядок подборки. Формат результата выбирается при экспорте.')}</p><div className="clip-footer-actions">{onPreview && <button type="button" className="button secondary" disabled={disabled || !included.length || !canPreview} onClick={onPreview}><Icon name="play" size={17} />{t('Посмотреть подборку')}</button>}<button className="button primary" type="button" disabled={disabled || !included.length} onClick={onExport}>{t('К настройкам экспорта')}<Icon name="chevron" size={17} /></button></div></div>
  </section>;
}
