import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/onest/latin-400.css';
import '@fontsource/onest/cyrillic-400.css';
import '@fontsource/onest/latin-500.css';
import '@fontsource/onest/cyrillic-500.css';
import '@fontsource/onest/latin-600.css';
import '@fontsource/onest/cyrillic-600.css';
import './styles.css';
import App from './App';
import { LanguageProvider } from './Language';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><LanguageProvider><App /></LanguageProvider></React.StrictMode>);
