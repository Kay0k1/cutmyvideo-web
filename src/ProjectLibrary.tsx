import { useEffect, useRef, useState } from 'react';
import { useLanguage } from './Language';
import { Icon } from './Icons';
import { formatTimecode } from './timecode';
import type { CuttingProject } from './cuttingProjects';
import './projects.css';

/** Browser projects are separate from retained server media and files. */
export function ProjectLibrary({ projects, activeID, disabled, canExport, onOpen, onDelete, onExport, onImport }: {
  projects: CuttingProject[]; activeID: string | null; disabled: boolean; canExport: boolean;
  onOpen(project: CuttingProject): void; onDelete(id: string): void; onExport(): void; onImport(file: File): void;
}) {
  const { t } = useLanguage();
  const [expanded, setExpanded] = useState(false);
  const [projectOrder, setProjectOrder] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!expanded) return;
    setProjectOrder(previous => {
      const known = new Set(previous);
      const added = [...projects].sort((a, b) => b.updated_at - a.updated_at).filter(project => !known.has(project.id));
      return added.length ? [...previous, ...added.map(project => project.id)] : previous;
    });
  }, [expanded, projects]);
  // Autosaves update recency while a pointer can be down on a project. Keep
  // visible rows in place until the next opening, while their data stays live.
  const positions = new Map(projectOrder.map((id, index) => [id, index]));
  const visibleProjects = [...projects].sort((a, b) => (positions.get(a.id) ?? projectOrder.length) - (positions.get(b.id) ?? projectOrder.length) || b.updated_at - a.updated_at);
  return <section className="project-library" aria-label={t('Проекты в этом браузере')}>
    <button type="button" className="text-button" aria-expanded={expanded} aria-controls="saved-projects" onClick={() => { if (!expanded) setProjectOrder([...projects].sort((a, b) => b.updated_at - a.updated_at).map(project => project.id)); setExpanded(value => !value); }}>{t('Мои проекты')}<Icon name="chevron" size={15} style={{ transform: expanded ? 'rotate(-90deg)' : 'rotate(90deg)' }} /></button>
    {expanded && <div id="saved-projects"><p className="field-hint">{t('Сохраняются в этом браузере. План можно скачать и перенести; видео и готовые файлы хранятся отдельно.')}</p>
      <div className="project-plan-actions"><button type="button" className="button secondary" onClick={onExport} disabled={disabled || !canExport}><Icon name="download" size={16} />{t('Скачать план')}</button><button type="button" className="button secondary" onClick={() => fileInput.current?.click()} disabled={disabled}><Icon name="upload" size={16} />{t('Открыть план')}</button></div>
      <p className="field-hint">{t('В план входят выбранные фрагменты в порядке списка. Для CLI укажите путь к исходному файлу в поле input.')}</p>
      <input ref={fileInput} className="sr-only" type="file" accept=".json,application/json" aria-label={t('Файл плана нарезки')} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onImport(file); }} />
      {projects.length ? <ul>{visibleProjects.map(project => <li key={project.id}><div><h3>{String(project.draft.source_title || t('Видео'))}</h3><span>{formatTimecode(Number(project.draft.source_duration_ms))} · {t('Фрагментов: {count}', { count: Array.isArray(project.draft.ranges) ? project.draft.ranges.length : 0 })}</span>{project.draft.media_unavailable === true && <p className="field-hint">{t('Откройте исходную запись заново, чтобы продолжить.')}</p>}</div><div className="project-row-actions"><button type="button" className="button secondary" disabled={disabled} aria-label={t('Открыть проект «{title}»', { title: String(project.draft.source_title || t('Видео')) })} onClick={() => onOpen(project)}>{t(project.id === activeID ? 'Продолжить' : 'Открыть')}</button><button type="button" className="icon-button danger-button" disabled={disabled} aria-label={t('Удалить проект «{title}» из браузера', { title: String(project.draft.source_title || t('Видео')) })} onClick={() => onDelete(project.id)}><Icon name="trash" size={16} /></button></div></li>)}</ul> : <p className="field-hint">{t('Проекты появятся после открытия видео.')}</p>}
    </div>}
  </section>;
}
