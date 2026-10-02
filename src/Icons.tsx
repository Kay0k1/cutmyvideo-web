import type { CSSProperties } from 'react';

export function Icon({ name, size = 20, style }: { name: 'cut' | 'link' | 'upload' | 'play' | 'plus' | 'trash' | 'download' | 'file' | 'check' | 'close' | 'chevron' | 'pause'; size?: number; style?: CSSProperties }) {
  const paths = {
    cut: <><path d="M7 3v18M17 3v18M3 7h18M3 17h18" /><path d="M7 7h10v10H7z" /></>,
    link: <><path d="m10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 9l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(0 -1)" /></>,
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5" /></>,
    play: <path d="m8 4 12 8-12 8z" />,
    pause: <><path d="M8 5v14M16 5v14" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    trash: <><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" /></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4" /></>,
    file: <><path d="M14 3H5v18h14V8l-5-5zm0 0v5h5M9 13h6M9 17h6" /></>,
    check: <path d="m5 12 4 4 10-10" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    chevron: <path d="m9 5 7 7-7 7" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>{paths[name]}</svg>;
}
