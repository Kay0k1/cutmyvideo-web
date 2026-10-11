import { describe, expect, it } from 'vitest'
import { disposableDatabaseEnvironment } from '../e2e/databaseEnvironment'
import { disposableDatabaseDiagnostic } from '../e2e/databaseDiagnostics'

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
      PGUSER: 'cutmy', PGPASSWORD: 'disposable_fixture_only', PGSERVICEFILE: '/dev/null', PGOPTIONS: '' })
    expect(result.PGSERVICE).toBeUndefined()
    expect(inherited.PGHOSTADDR).toBe('198.51.100.9')
  })

  it('leaves service selection absent even when the inherited service is empty', () => {
    const result = disposableDatabaseEnvironment({ ...fixture, PGSERVICE: '' })
    expect(Object.hasOwn(result, 'PGSERVICE')).toBe(false)
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

describe('disposable database diagnostics', () => {
  it.each([
    ['psql: error: definition of service "private_fixture_detail" not found', 'service_configuration'],
    ['could not translate host name "private_fixture_detail" to address', 'name_resolution'],
    ['password authentication failed for user "private_fixture_detail"', 'authentication'],
    ['canceling statement due to lock timeout private_fixture_detail', 'lock_timeout'],
    ['permission denied for table private_fixture_detail', 'permission_denied'],
    ['relation "private_fixture_detail" does not exist', 'missing_relation'],
    ['connection to server at "private_fixture_detail" failed: Connection refused', 'connection_failure'],
    ['unrecognized error private_fixture_detail', 'unclassified'],
    ['', 'no_diagnostic'],
  ])('reports a fixed category without retaining connection details', (stderr, category) => {
    const result = disposableDatabaseDiagnostic(stderr)
    expect(result).toBe(category)
    expect(result).not.toContain('private_fixture_detail')
  })
})
