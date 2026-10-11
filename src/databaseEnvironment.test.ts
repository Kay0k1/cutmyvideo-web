import { describe, expect, it } from 'vitest'
import { disposableDatabaseEnvironment } from '../e2e/databaseEnvironment'

const fixture = {
  CUTMY_E2E_DATABASE_CONTROL: 'hosted-disposable', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
  DATABASE_URL: 'postgres://cutmy:disposable_fixture_only@postgres:5432/cutmy?sslmode=disable',
}

describe('disposable database fault injection target', () => {
  it('removes a hostile actual-address/service/authentication override before libpq can use it', () => {
    const inherited = { ...fixture, PATH: '/usr/bin', PGHOSTADDR: '198.51.100.9', PGSERVICE: 'foreign',
      PGSERVICEFILE: '/foreign/service', PGOPTIONS: '-c role=foreign', PGPASSFILE: '/foreign/passwords',
      PGSSLROOTCERT: '/foreign/ca', PGDATABASE: 'foreign', PGUSER: 'foreign', PGPASSWORD: 'foreign',
      PGFUTURE_DESTINATION_OVERRIDE: 'foreign' }
    const result = disposableDatabaseEnvironment(inherited)
    expect(result.PGHOSTADDR).toBeUndefined()
    expect(result.PGPASSFILE).toBeUndefined()
    expect(result.PGSSLROOTCERT).toBeUndefined()
    expect(result.PGFUTURE_DESTINATION_OVERRIDE).toBeUndefined()
    expect(result).toMatchObject({ PATH: '/usr/bin', PGHOST: 'postgres', PGPORT: '5432', PGDATABASE: 'cutmy',
      PGUSER: 'cutmy', PGPASSWORD: 'disposable_fixture_only', PGSERVICE: '', PGSERVICEFILE: '/dev/null', PGOPTIONS: '' })
    expect(inherited.PGHOSTADDR).toBe('198.51.100.9')
  })

  it.each([
    { CUTMY_E2E_DATABASE_CONTROL: undefined }, { GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' },
    { DATABASE_URL: 'postgres://cutmy:fixture@production.example/cutmy' },
    { DATABASE_URL: 'postgres://cutmy:fixture@postgres/other' },
    { DATABASE_URL: 'postgres://operator:fixture@postgres/cutmy' },
    { DATABASE_URL: 'postgres://cutmy:fixture@postgres:5433/cutmy' },
    { DATABASE_URL: 'postgres://cutmy@postgres/cutmy' },
  ])('refuses an unapproved runner or destination before spawning any client: %j', overrides => {
    expect(() => disposableDatabaseEnvironment({ ...fixture, ...overrides })).toThrow()
  })
})
