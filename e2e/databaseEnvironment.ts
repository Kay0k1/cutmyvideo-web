// libpq accepts destination, service and authentication overrides through many
// PG* variables. None may come from the host running a destructive CI fixture.
export function disposableDatabaseEnvironment(environment: Record<string, string | undefined>): Record<string, string | undefined> {
  if (environment.CUTMY_E2E_DATABASE_CONTROL !== 'hosted-disposable'
      || environment.GITHUB_ACTIONS !== 'true' || environment.RUNNER_ENVIRONMENT !== 'github-hosted') {
    throw new Error('Database fault injection requires the disposable hosted integration job')
  }
  const url = new URL(environment.DATABASE_URL || '')
  if (url.hostname !== 'postgres' || url.pathname !== '/cutmy' || url.username !== 'cutmy'
      || (url.port && url.port !== '5432') || url.protocol !== 'postgres:' || !url.password) {
    throw new Error('Database fault injection refused an unexpected test database')
  }
  const clean = Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith('PG')))
  return { ...clean, PGHOST: 'postgres', PGPORT: '5432', PGDATABASE: 'cutmy', PGUSER: 'cutmy',
    PGPASSWORD: decodeURIComponent(url.password), PGSERVICE: '', PGSERVICEFILE: '/dev/null',
    PGOPTIONS: '', PGSSLMODE: 'disable', PGAPPNAME: 'cutmy-disposable-browser-contract', PGCONNECT_TIMEOUT: '3' }
}
