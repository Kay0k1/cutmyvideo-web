import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

// This is an explicit fault injector for the disposable CI database. Ordinary
// development and the deployed website never enable or call it.
export async function holdStorageCounterLock(): Promise<() => Promise<void>> {
  if (process.env.CUTMY_E2E_DATABASE_CONTROL !== 'hosted-disposable'
      || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
    throw new Error('Database fault injection requires the disposable hosted integration job')
  }
  const url = new URL(process.env.DATABASE_URL || '')
  if (url.hostname !== 'postgres' || url.pathname !== '/cutmy' || url.username !== 'cutmy'
      || (url.port && url.port !== '5432') || url.protocol !== 'postgres:') {
    throw new Error('Database fault injection refused an unexpected test database')
  }
  const marker = `cutmy_lock_${randomBytes(12).toString('hex')}`
  const child = spawn('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], {
    detached: true,
    env: { ...process.env, PGHOST: 'postgres', PGPORT: '5432', PGDATABASE: 'cutmy', PGUSER: 'cutmy',
      PGPASSWORD: decodeURIComponent(url.password), PGSERVICE: '', PGSERVICEFILE: '/dev/null',
      PGOPTIONS: '', PGAPPNAME: 'cutmy-disposable-browser-contract', PGCONNECT_TIMEOUT: '3' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = '', bytes = 0
  child.stdin.on('error', () => { /* Close/error handling below owns a broken pipe. */ })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', value => { bytes += Buffer.byteLength(value); if (bytes <= 65536) output += value })
  // Diagnostics can contain connection details, so they never enter artifacts.
  child.stderr.on('data', value => { bytes += value.length })
  const closed = new Promise<number | null>(resolve => child.once('close', resolve))
  let released = false
  const release = async () => {
    if (released) return
    released = true
    if (child.exitCode === null && child.signalCode === null) child.stdin.end('ROLLBACK;\n\\q\n')
    const finish = await Promise.race([closed.then(code => ({ code })),
      new Promise<null>(resolve => { const timer = setTimeout(() => resolve(null), 5000); timer.unref() })])
    if (finish === null && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
      await closed
      throw new Error('Disposable database lock did not close gracefully')
    }
    if (finish?.code !== 0) throw new Error('Disposable database lock command failed')
  }
  try {
    child.stdin.write("SET lock_timeout='2s'; SET idle_in_transaction_session_timeout='20s';\n"
      + `BEGIN; LOCK TABLE public.storage_counters IN ACCESS EXCLUSIVE MODE; SELECT '${marker}';\n`)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('Disposable database lock was not acknowledged')), 5000)
      const onData = () => {
        if (bytes > 65536) finish(new Error('Disposable database command exceeded its output bound'))
        else if (output.split(/\r?\n/).includes(marker)) finish()
      }
      const onError = () => finish(new Error('Disposable database command could not start'))
      const onClose = () => finish(new Error('Disposable database command closed before acquiring its lock'))
      const finish = (error?: Error) => {
        clearTimeout(timeout); child.stdout.off('data', onData); child.off('error', onError); child.off('close', onClose)
        if (error) reject(error); else resolve()
      }
      child.stdout.on('data', onData); child.once('error', onError); child.once('close', onClose)
      onData()
    })
    return release
  } catch (error) {
    try { await release() } catch { /* Preserve the original bounded failure. */ }
    throw error
  }
}
