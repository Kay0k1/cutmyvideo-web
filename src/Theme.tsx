import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useLanguage } from './Language';
import { Icon } from './Icons';

export type ThemePreference = 'system' | 'light' | 'dark';
interface ThemeContext {
  preference: ThemePreference;
  effective: 'light' | 'dark';
  setPreference(value: ThemePreference): void;
}
const context = createContext<ThemeContext>({ preference: 'system', effective: 'light', setPreference: () => undefined });

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem('cutmyvideo.theme');
    return value === 'dark' || value === 'light' ? value : 'system';
  } catch { return 'system'; }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, updatePreference] = useState<ThemePreference>(readPreference);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const effective = preference === 'system' ? systemDark ? 'dark' : 'light' : preference;
  const setPreference = (value: ThemePreference) => {
    updatePreference(value);
    try { localStorage.setItem('cutmyvideo.theme', value); } catch { /* Optional browser storage. */ }
  };
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const change = () => setSystemDark(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = effective;
    document.documentElement.style.colorScheme = effective;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', effective === 'dark' ? '#14191f' : '#f2f4f7');
  }, [effective]);
  return <context.Provider value={{ preference, effective, setPreference }}>{children}</context.Provider>;
}

export const useTheme = () => useContext(context);

export function ThemeToggle() {
  const { effective, setPreference } = useTheme();
  const { t } = useLanguage();
  const label = t(effective === 'light' ? 'Включить тёмную тему' : 'Включить светлую тему');
  return <button type="button" className="theme-toggle icon-button" aria-label={label} title={label} onClick={() => setPreference(effective === 'light' ? 'dark' : 'light')}><Icon name={effective === 'light' ? 'moon' : 'sun'} size={20} /></button>;
}
