import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useLanguage } from './Language';
import { Icon } from './Icons';
import { SelectControl } from './SelectControl';
import { defaultPreferences } from './preferences';
import type { Preferences } from './preferences';
import type { OutputSettings } from './types';
import { useTheme } from './Theme';
import type { WorkbenchPanel } from './workflowHistory';

type Panel = Exclude<WorkbenchPanel, null>;
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

export function WorkspaceNav({ panel, onOpen, onClose, preferences, onSave, onExample, onCollectionOpen, collectionDisabled, busy }: {
  panel: WorkbenchPanel;
  onOpen(value: Panel): void;
  onClose(): Promise<boolean>;
  preferences: Preferences;
  onSave(value: Preferences): void;
  onExample(url: string): void;
  busy: boolean;
  onCollectionOpen?(): void;
  collectionDisabled?: boolean;
}) {
  const { t } = useLanguage();
  const { preference: themePreference, setPreference: setThemePreference } = useTheme();
  const [draft, setDraft] = useState<Preferences>(preferences);
  const [draftTheme, setDraftTheme] = useState(themePreference);
  const [settingsNotice, setSettingsNotice] = useState('');
  const [copied, setCopied] = useState('');
  const [copyError, setCopyError] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const copiedTimer = useRef<number | undefined>(undefined);
  const trigger = useRef<HTMLElement | null>(null);

  const close = () => { void onClose(); };

  const open = (value: Panel, control: HTMLElement) => {
    trigger.current = control;
    onOpen(value);
  };

  useEffect(() => {
    let returnFocusFrame: number | undefined;
    if (panel === 'settings') { setDraft(preferences); setDraftTheme(themePreference); setSettingsNotice(''); }
    if (panel && dialog.current && !dialog.current.open) dialog.current.showModal();
    if (!panel && dialog.current?.open) {
      const control = trigger.current;
      dialog.current.close();
      control?.focus();
      // Fragment history traversal can blur the invoker after close() returns.
      // Repair that native focus loss after traversal without taking focus from
      // a new stage or another control the user has already reached.
      returnFocusFrame = requestAnimationFrame(() => {
        if (!dialog.current?.open && control?.isConnected && document.activeElement === document.body) control.focus();
      });
    }
    const previous = document.body.style.overflow;
    if (panel) document.body.style.overflow = 'hidden';
    return () => {
      if (returnFocusFrame !== undefined) cancelAnimationFrame(returnFocusFrame);
      document.body.style.overflow = previous;
    };
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
      <button type="button" aria-haspopup="dialog" aria-controls="workspace-dialog" aria-expanded={panel === 'examples'} onClick={event => open('examples', event.currentTarget)}>{t('Примеры')}</button>
      <button type="button" aria-haspopup="dialog" aria-controls="workspace-dialog" aria-expanded={panel === 'settings'} onClick={event => open('settings', event.currentTarget)}>{t('Настройки')}</button>
      <button type="button" aria-haspopup="dialog" aria-controls="workspace-dialog" aria-expanded={panel === 'support'} onClick={event => open('support', event.currentTarget)}>{t('Поддержать')}</button>
      {onCollectionOpen && <button type="button" disabled={collectionDisabled} onClick={onCollectionOpen}>{t('Коллекции')}</button>}
    </nav>
    <dialog ref={dialog} id="workspace-dialog" className="workspace-dialog" aria-labelledby="dialog-title" onKeyDown={trapFocus} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === dialog.current) { const rect = dialog.current.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); } }}>
      <div className="dialog-header"><h2 id="dialog-title">{t(title)}</h2><button type="button" className="icon-button" aria-label={t('Закрыть')} onClick={close}><Icon name="close" size={22} /></button></div>
      <div className="dialog-body">
      {panel === 'examples' && <>
        <section className="sample-section"><h3>{t('Попробуйте на примере')}</h3><div className="sample-info"><Icon name="play" size={25} /><div><strong>Big Buck Bunny</strong><p>{t('Фильм Blender на YouTube. Открытие заменит текущее видео и выбранные моменты.')}</p></div></div><button type="button" className="button primary" disabled={busy} onClick={() => { void onClose().then(closed => { if (closed) onExample(sampleUrl); }); }}>{t('Открыть пример')}</button><a className="sample-source" href={sampleUrl} target="_blank" rel="noreferrer">YouTube</a></section>
        <section className="help-section"><h3>{t('Как вырезать момент')}</h3><ol><li>{t('Вставьте публичную ссылку на видео или загрузите MP4, MOV, MKV или WebM.')}</li><li>{t('Отметьте начало и конец. Можно двигать ручки или ввести время.')}</li><li>{t('Для одного момента нажмите «К скачиванию». Для нескольких откройте «Список фрагментов».')}</li><li>{t('Выберите MP4 или MP3, вырежьте фрагменты и скачайте файлы.')}</li></ol></section>
        <section className="help-section"><h3>{t('Примеры таймкодов')}</h3><dl className="timecode-examples"><div><dt>15</dt><dd>{t('15 секунд от начала')}</dd></div><div><dt>83:10</dt><dd>{t('83 минуты 10 секунд')}</dd></div><div><dt>01:23:10.250</dt><dd>{t('1 час 23 минуты 10,250 секунды')}</dd></div></dl></section>
        <section className="help-section"><h3>{t('Точные границы или сохранение качества?')}</h3><p>{t('«Точные границы» перекодируют видео. «Исходное качество» сохраняет его без перекодирования, но начало и конец могут сдвинуться. Фактические границы указаны рядом с готовым файлом.')}</p></section>
        <section className="help-section"><h3>{t('Ограничения источников')}</h3><p>{t('Для длинных записей достаточно ссылки. Недавние участки предпросмотра сохраняются для быстрой перемотки. Если сервис требует вход, загрузите доступное видео файлом.')}</p></section>
      </>}
      {panel === 'settings' && <form className="preferences-form" onSubmit={event => { event.preventDefault(); setThemePreference(draftTheme); onSave(draft); setSettingsNotice('Настройки сохранены.'); }}>
        <p className="dialog-intro">{t('Применяются к текущему и новым источникам. Выбранные интервалы сохраняются.')}</p>
        <label htmlFor="theme-preference">{t('Тема оформления')}</label><SelectControl id="theme-preference" value={draftTheme} onChange={value => { setDraftTheme(value as 'light' | 'dark' | 'system'); setSettingsNotice(''); }} options={[{ value: 'system', label: t('Как в системе') }, { value: 'light', label: t('Светлая') }, { value: 'dark', label: t('Тёмная') }]} />
        <label htmlFor="default-format">{t('Формат по умолчанию')}</label><SelectControl id="default-format" value={draft.output.format} onChange={value => updateOutput({ format: value as OutputSettings['format'] })} options={[{ value: 'mp4', label: 'MP4 — ' + t('Видео') }, { value: 'mp3', label: 'MP3 — ' + t('Аудио') }]} />
        <label htmlFor="default-quality">{t('Качество видео')}</label><SelectControl id="default-quality" value={draft.output.quality} disabled={draft.output.format === 'mp3'} onChange={value => updateOutput({ quality: value as OutputSettings['quality'] })} options={[{ value: '1080p', label: t('До 1080p') }, { value: '720p', label: t('До 720p') }, { value: 'best', label: t('Лучшее доступное') }]} />
        <label htmlFor="default-cut">{t('Границы и качество')}</label><SelectControl id="default-cut" value={draft.output.cut_mode} disabled={draft.output.format === 'mp3'} onChange={value => updateOutput({ cut_mode: value as OutputSettings['cut_mode'] })} options={[{ value: 'accurate', label: t('Точные границы') }, { value: 'copy', label: t('Исходное качество') }]} />
        <label htmlFor="default-zoom">{t('Масштаб шкалы по умолчанию')}</label><SelectControl id="default-zoom" value={String(draft.timeline_span)} onChange={value => { setDraft(previous => ({ ...previous, timeline_span: Number(value) })); setSettingsNotice(''); }} options={[{ value: '10000', label: t('10 секунд') }, { value: '60000', label: t('1 минута') }, { value: '300000', label: t('5 минут') }]} />
        <p className="field-hint">{t('Хранятся только в этом браузере.')}</p><div className="preferences-actions"><button type="submit" className="button primary">{t('Сохранить настройки')}</button><button type="button" className="text-button" onClick={() => { setDraft(defaultPreferences); setDraftTheme('system'); setSettingsNotice(''); }}>{t('Сбросить настройки')}</button></div><p className="settings-notice" role="status">{t(settingsNotice)}</p>
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
