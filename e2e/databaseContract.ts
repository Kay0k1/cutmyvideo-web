import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { disposableDatabaseEnvironment } from './databaseEnvironment'
import { disposableDatabaseDiagnostic } from './databaseDiagnostics'

// This is an explicit fault injector for the disposable CI database. Ordinary
// development and the deployed website never enable or call it.
export async function holdStorageCounterLock(): Promise<() => Promise<void>> {
  const environment = disposableDatabaseEnvironment(process.env)
  const marker = `cutmy_lock_${randomBytes(12).toString('hex')}`
  const child = spawn('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], {
    detached: true,
    env: { ...environment, LC_ALL: 'C' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = '', diagnostic = '', bytes = 0
  child.stdin.on('error', () => { /* Close/error handling below owns a broken pipe. */ })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', value => { bytes += Buffer.byteLength(value); if (bytes <= 65536) output += value })
  // Keep at most the shared output bound in memory; expose only a fixed category.
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', value => { bytes += Buffer.byteLength(value); if (bytes <= 65536) diagnostic += value })
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
      const onClose = (code: number | null) => finish(new Error(
        `Disposable database command closed before acquiring its lock (exit=${code}; diagnostic=${disposableDatabaseDiagnostic(diagnostic)})`))
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
