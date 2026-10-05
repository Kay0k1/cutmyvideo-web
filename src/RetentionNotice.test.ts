import { describe, expect, it } from 'vitest';
import { retentionMessage } from './RetentionNotice';
import { translate } from './locales';

describe('server retention targets', () => {
  it('never promises future availability once a cleanup target has passed', () => {
    expect(retentionMessage('source', 1000, 2000)).toContain('когда на него больше не ссылаются задания и результаты');
    expect(translate(retentionMessage('source', 1000, 2000), 'en')).toContain('once no jobs or results reference it');
    expect(retentionMessage('artifact', 1000, 2000)).toContain('может быть удалён в любой момент');
    expect(retentionMessage('wait', 2000, 2000)).toContain('Время ожидания места истекло');
    for (const kind of ['source', 'artifact', 'wait'] as const) expect(translate(retentionMessage(kind, 1000, 2000), 'en')).not.toMatch(/[А-Яа-яЁё]/);
  });
  it('describes future dates as cleanup targets with reference protection', () => {
    expect(retentionMessage('source', 3000, 2000)).toContain('если его больше не используют задания');
    expect(retentionMessage('artifact', 3000, 2000)).toContain('Удаление после');
  });
});
