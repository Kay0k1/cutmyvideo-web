/** Run before session bootstrap. A handoff capability must never enter history/storage. */
export function takeHandoffFragment(location: Pick<Location, 'hash' | 'pathname' | 'search'>, history: Pick<History, 'replaceState' | 'state'>): string | null {
  const parameters = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (!parameters.has('handoff')) return null;
  const tokens = parameters.getAll('handoff');
  history.replaceState(history.state, '', location.pathname + location.search);
  return tokens.length === 1 && /^[A-Za-z0-9_-]{32,256}$/.test(tokens[0]) ? tokens[0] : '';
}
