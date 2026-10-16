import { lazy, Suspense, useEffect, useState } from 'react';
import App from './App';
import { api } from './api';
import { collectionAPI } from './collectionApi';
import { takeHandoffFragment } from './collectionHandoff';
import type { CollectionOpening } from './CollectionWorkspace';
import { useLanguage } from './Language';

const CollectionWorkspace = lazy(() => import('./CollectionWorkspace').then(module => ({ default: module.CollectionWorkspace })));
// Remove the capability before either editor can initiate a request. StrictMode
// shares one redemption promise; a lost response is recoverable for this session.
let token = takeHandoffFragment(window.location, window.history);
let redemption: ReturnType<typeof collectionAPI.redeem> | null = null;
function redeem() {
  if (!redemption) { const pendingToken = token; token = null; redemption = api.session().then(() => { if (!pendingToken) throw new Error(); return collectionAPI.redeem(pendingToken); }); }
  return redemption;
}
function collectionRoute(open: boolean) {
  const url = new URL(location.href); if (open) url.searchParams.set('workspace', 'collection'); else url.searchParams.delete('workspace');
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
}
export default function ProductApp() {
  const { t } = useLanguage();
  const [opening, setOpening] = useState<CollectionOpening | null>(() => new URLSearchParams(location.search).get('workspace') === 'collection' && token === null ? {} : null);
  const [booting, setBooting] = useState(token !== null), [error, setError] = useState('');
  useEffect(() => {
    if (!booting) return;
    let active = true;
    void redeem().then(project => { if (active) { setOpening({ project }); collectionRoute(true); } }).catch(() => { if (active) setError(t('Приглашение недоступно или срок его действия закончился. Попросите владельца создать новую ссылку.')); }).finally(() => { if (active) setBooting(false); });
    return () => { active = false; };
  }, []);
  if (booting) return <main className="stage-page" aria-busy="true"><p role="status">{t('Открываем переданный проект…')}</p></main>;
  if (opening) return <Suspense fallback={<main className="stage-page"><p role="status">{t('Открываем коллекцию…')}</p></main>}><CollectionWorkspace opening={opening} onExit={() => { collectionRoute(false); setOpening(null); }} /></Suspense>;
  return <>{error && <div className="collection-bootstrap-error" role="alert">{error}<button className="text-button" onClick={() => setError('')}>{t('Закрыть')}</button></div>}<App onCollectionOpen={(document, source) => { collectionRoute(true); setOpening(document ? { document, source } : {}); }} /></>;
}
