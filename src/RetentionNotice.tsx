import { useLanguage } from './Language';

export function retentionMessage(kind: 'source' | 'artifact' | 'wait', timestamp: number, now = Date.now()): string {
  if (timestamp <= now) return kind === 'wait' ? 'Время ожидания места истекло. Обновляем состояние задания…' : kind === 'source' ? 'Срок хранения видео истёк {date}. Оно может быть удалено, когда на него больше не ссылаются задания и результаты.' : 'Срок хранения файла истёк {date}. Он может быть удалён в любой момент.';
  return kind === 'wait' ? 'Ожидание места — до {date}.' : kind === 'source' ? 'Видео будет удалено после {date}, если его больше не используют задания.' : 'Удаление после {date}.';
}

/** The timestamp is a cleanup target; active references can retain a source. */
export function RetentionNotice({ expiresAt, blocked = false, kind }: {
  expiresAt?: string | null;
  blocked?: boolean;
  kind: 'source' | 'artifact' | 'wait';
}) {
  const { locale, t } = useLanguage();
  const timestamp = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
  if (kind === 'source' && blocked) return <p className="retention-note">{t('Видео сохраняется, пока на него ссылаются задания и результаты.')}</p>;
  if (!Number.isFinite(timestamp)) return null;
  const date = new Intl.DateTimeFormat(locale === 'ru' ? 'ru-RU' : 'en-GB', {
    dateStyle: 'short', timeStyle: 'short',
  }).format(timestamp);
  const text = retentionMessage(kind, timestamp);
  return <p className="retention-note">{t(text, { date })}</p>;
}
