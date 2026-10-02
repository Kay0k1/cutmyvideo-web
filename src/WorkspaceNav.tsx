import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useLanguage } from './Language';
import { Icon } from './Icons';
import { defaultPreferences } from './preferences';
import type { Preferences } from './preferences';
import type { OutputSettings } from './types';
import { useTheme } from './Theme';

type Panel = 'examples' | 'settings' | 'support';
const sampleUrl = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const wallets = [
  { network: 'TRON', address: 'TEaL7LYGWKLGMALr8QZKV412xAjC6x4MdE' },
  { network: 'Solana', address: 'AfFgZ9Se53R9xKzoEpHrZnULmVKpm6iSE3aBx9DtBMdj' },
  { network: 'Ethereum', address: '0xC51fC6DB30e7EE6ed801F98bfA1c214991D21f78' },
  { network: 'Bitcoin', address: 'bc1q2ynccztq2t2z8f6nwx9rlve9tt29t72h2mnrpv' },
];

export function LanguageSwitch() {
  const { locale, setLocale, t } = useLanguage();
  return <div className="language-switch" role="group" aria-label={t('Язык интерфейса')}>
    <button type="button" lang="ru" aria-label="Русский" aria-pressed={locale === 'ru'} onClick={() => setLocale('ru')}>RU</button>
    <button type="button" lang="en" aria-label="English" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>EN</button>
  </div>;
}

export function WorkspaceNav({ preferences, onSave, onExample, busy }: {
  preferences: Preferences;
  onSave(value: Preferences): void;
  onExample(url: string): void;
  busy: boolean;
}) {
  const { t } = useLanguage();
  const { preference: themePreference, setPreference: setThemePreference } = useTheme();
  const [panel, setPanel] = useState<Panel | null>(() => {
    const requested = new URLSearchParams(window.location.search).get('panel');
    return requested === 'examples' || requested === 'settings' || requested === 'support' ? requested : null;
  });
  const [draft, setDraft] = useState<Preferences>(preferences);
  const [settingsNotice, setSettingsNotice] = useState('');
  const [copied, setCopied] = useState('');
  const [copyError, setCopyError] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const copiedTimer = useRef<number | undefined>(undefined);
  const trigger = useRef<HTMLElement | null>(null);

  const close = () => {
    const wasOpen = dialog.current?.open;
    dialog.current?.close();
    setPanel(null);
    const url = new URL(window.location.href); url.searchParams.delete('panel'); history.replaceState(null, '', url);
    if (wasOpen) trigger.current?.focus();
  };

  const open = (value: Panel) => {
    trigger.current = document.activeElement as HTMLElement;
    setPanel(value);
    const url = new URL(window.location.href); url.searchParams.set('panel', value); history.replaceState(null, '', url);
  };

  useEffect(() => {
    if (panel === 'settings') { setDraft(preferences); setSettingsNotice(''); }
    if (panel && dialog.current && !dialog.current.open) dialog.current.showModal();
    const previous = document.body.style.overflow;
    if (panel) document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [panel]);

  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const updateOutput = (value: Partial<OutputSettings>) => {
    setDraft(previous => {
      const output = { ...previous.output, ...value };
      if (output.format === 'mp3') output.cut_mode = 'accurate';
      return { ...previous, output };
    });
    setSettingsNotice('');
  };

  function trapFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Tab' || !dialog.current) return;
    const controls = [...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }

  async function copy(network: string, address: string) {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(network); setCopyError(false);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(''), 5000);
    } catch { setCopyError(true); setCopied(''); }
  }

  const title = panel === 'examples' ? 'Примеры и помощь' : panel === 'settings' ? 'Настройки по умолчанию' : 'Поддержать cutmyvideo';

  return <>
    <nav className="workspace-nav" aria-label={t('Навигация')}>
      <button type="button" aria-current={panel ? undefined : 'page'} onClick={() => { close(); document.getElementById('editor')?.scrollIntoView({ block: 'start' }); }}>{t('Редактор')}</button>
      <button type="button" aria-expanded={panel === 'examples'} onClick={() => open('examples')}>{t('Примеры')}</button>
      <button type="button" aria-expanded={panel === 'settings'} onClick={() => open('settings')}>{t('Настройки')}</button>
      <button type="button" aria-expanded={panel === 'support'} onClick={() => open('support')}>{t('Поддержать')}</button>
    </nav>
    <dialog ref={dialog} className="workspace-dialog" aria-labelledby="dialog-title" onKeyDown={trapFocus} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === dialog.current) { const rect = dialog.current.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); } }}>
      <div className="dialog-header"><h2 id="dialog-title">{t(title)}</h2><button type="button" className="icon-button" aria-label={t('Закрыть')} onClick={close}><Icon name="close" size={22} /></button></div>
      <div className="dialog-body">
      {panel === 'examples' && <>
        <section className="sample-section"><h3>{t('Попробуйте на примере')}</h3><div className="sample-info"><Icon name="play" size={25} /><div><strong>Big Buck Bunny</strong><p>{t('Фильм Blender на YouTube. Открытие заменит текущее видео и выбранные моменты.')}</p></div></div><button type="button" className="button primary" disabled={busy} onClick={() => { close(); onExample(sampleUrl); }}>{t('Открыть пример')}</button><a className="sample-source" href={sampleUrl} target="_blank" rel="noreferrer">YouTube</a></section>
        <section className="help-section"><h3>{t('Как вырезать момент')}</h3><ol><li>{t('Откройте ссылку на YouTube или загрузите MP4.')}</li><li>{t('Отметьте начало и конец. Можно двигать ручки или ввести время.')}</li><li>{t('Добавьте другие моменты и перейдите к экспорту.')}</li><li>{t('Выберите MP4 или MP3, вырежьте фрагменты и скачайте файлы.')}</li></ol></section>
        <section className="help-section"><h3>{t('Примеры таймкодов')}</h3><dl className="timecode-examples"><div><dt>15</dt><dd>{t('15 секунд от начала')}</dd></div><div><dt>83:10</dt><dd>{t('83 минуты 10 секунд')}</dd></div><div><dt>01:23:10.250</dt><dd>{t('1 час 23 минуты 10,250 секунды')}</dd></div></dl></section>
        <section className="help-section"><h3>{t('Точные границы или сохранение качества?')}</h3><p>{t('«Точные границы» перекодируют видео. «Исходное качество» сохраняет его без перекодирования, но начало и конец могут сдвинуться. Фактические границы указаны рядом с готовым файлом.')}</p></section>
        <section className="help-section"><h3>{t('Ограничения источников')}</h3><p>{t('YouTube иногда ограничивает доступ с сервера или требует входа. В таком случае загрузите MP4. Не все кодеки можно просмотреть в браузере; время и экспорт можно настроить вручную.')}</p></section>
      </>}
      {panel === 'settings' && <form className="preferences-form" onSubmit={event => { event.preventDefault(); onSave(draft); setSettingsNotice('Настройки сохранены.'); }}>
        <p className="dialog-intro">{t('Применяются к текущему и новым источникам. Выбранные интервалы сохраняются.')}</p>
        <label htmlFor="theme-preference">{t('Тема оформления')}</label><select id="theme-preference" value={themePreference} onChange={event => setThemePreference(event.target.value as 'light' | 'dark' | 'system')}><option value="system">{t('Как в системе')}</option><option value="light">{t('Светлая')}</option><option value="dark">{t('Тёмная')}</option></select>
        <label htmlFor="default-format">{t('Формат по умолчанию')}</label><select id="default-format" value={draft.output.format} onChange={event => updateOutput({ format: event.target.value as OutputSettings['format'] })}><option value="mp4">MP4 — {t('Видео')}</option><option value="mp3">MP3 — {t('Аудио')}</option></select>
        <label htmlFor="default-quality">{t('Качество видео')}</label><select id="default-quality" value={draft.output.quality} disabled={draft.output.format === 'mp3'} onChange={event => updateOutput({ quality: event.target.value as OutputSettings['quality'] })}><option value="1080p">{t('До 1080p')}</option><option value="720p">{t('До 720p')}</option><option value="best">{t('Лучшее доступное')}</option></select>
        <label htmlFor="default-cut">{t('Границы и качество')}</label><select id="default-cut" value={draft.output.cut_mode} disabled={draft.output.format === 'mp3'} onChange={event => updateOutput({ cut_mode: event.target.value as OutputSettings['cut_mode'] })}><option value="accurate">{t('Точные границы')}</option><option value="copy">{t('Исходное качество')}</option></select>
        <label htmlFor="default-zoom">{t('Масштаб шкалы по умолчанию')}</label><select id="default-zoom" value={draft.timeline_span} onChange={event => { setDraft(previous => ({ ...previous, timeline_span: Number(event.target.value) })); setSettingsNotice(''); }}><option value="10000">{t('10 секунд')}</option><option value="60000">{t('1 минута')}</option><option value="300000">{t('5 минут')}</option></select>
        <p className="field-hint">{t('Хранятся только в этом браузере.')}</p><div className="preferences-actions"><button type="submit" className="button primary">{t('Сохранить настройки')}</button><button type="button" className="text-button" onClick={() => { setDraft(defaultPreferences); setSettingsNotice(''); }}>{t('Сбросить настройки')}</button></div><p className="settings-notice" role="status">{t(settingsNotice)}</p>
      </form>}
      {panel === 'support' && <>
        <p className="dialog-intro">{t('Если инструмент пригодился, можно поддержать его разработку и сервер.')}</p><p className="donation-help">{t('Выберите сеть и скопируйте адрес. Перевод выполняется в вашем кошельке.')}</p>
        <ul className="wallet-list">{wallets.map(wallet => <li key={wallet.network}><div className="wallet-heading"><h3>{wallet.network}</h3><button type="button" className="button secondary" aria-label={t('Скопировать адрес {network}', { network: wallet.network })} onClick={() => void copy(wallet.network, wallet.address)}><Icon name={copied === wallet.network ? 'check' : 'file'} size={16} />{copied === wallet.network ? t('Скопировано') : t('Скопировать адрес')}</button></div><code>{wallet.address}</code></li>)}</ul>
        <p className={copyError ? 'error-message' : 'copy-notice'} role="status">{copyError ? t('Не удалось скопировать. Выделите адрес и скопируйте его вручную.') : copied ? t('Адрес {network} скопирован.', { network: copied }) : ''}</p><p className="support-thanks">{t('Спасибо за поддержку.')}</p>
      </>}
      </div>
    </dialog>
  </>;
}
