import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { translate } from './locales';
import type { Locale } from './locales';

interface LanguageContext {
  locale: Locale;
  setLocale(locale: Locale): void;
  t(text: string, values?: Record<string, string | number>): string;
}
const context = createContext<LanguageContext>({ locale: 'ru', setLocale: () => undefined, t: text => text });

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const query = new URLSearchParams(window.location.search).get('lang');
    if (query === 'ru' || query === 'en') return query;
    try { return localStorage.getItem('cutmyvideo.language') === 'en' ? 'en' : 'ru'; } catch { return 'ru'; }
  });
  const setLocale = (value: Locale) => {
    setLocaleState(value);
    try { localStorage.setItem('cutmyvideo.language', value); } catch { /* Optional persistence. */ }
    const url = new URL(window.location.href);
    url.searchParams.delete('lang');
    history.replaceState(null, '', url);
  };
  useEffect(() => {
    try { localStorage.setItem('cutmyvideo.language', locale); } catch { /* Optional persistence. */ }
    document.documentElement.lang = locale;
    document.querySelector('meta[name="description"]')?.setAttribute('content', locale === 'ru' ? 'Выберите моменты в видео и скачайте готовые фрагменты в MP4 или MP3.' : 'Select moments in a video and download your clips as MP4 or MP3.');
  }, [locale]);
  return <context.Provider value={{ locale, setLocale, t: (text, values) => translate(text, locale, values) }}>{children}</context.Provider>;
}

export const useLanguage = () => useContext(context);
