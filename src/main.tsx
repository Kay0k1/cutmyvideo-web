import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/geologica/wght.css';
import './styles.css';
import App from './ProductApp';
import { LanguageProvider } from './Language';
import { ThemeProvider } from './Theme';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><LanguageProvider><ThemeProvider><App /></ThemeProvider></LanguageProvider></React.StrictMode>);
