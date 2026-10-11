// Return only fixed categories. Raw psql diagnostics may contain connection
// details and must never be copied into browser reports or CI artifacts.
export function disposableDatabaseDiagnostic(stderr: string): string {
  if (/definition of service .* not found/.test(stderr)) return 'service_configuration'
  if (/could not translate host name/.test(stderr)) return 'name_resolution'
  if (/password authentication failed|no password supplied/.test(stderr)) return 'authentication'
  if (/canceling statement due to lock timeout/.test(stderr)) return 'lock_timeout'
  if (/permission denied/.test(stderr)) return 'permission_denied'
  if (/relation .* does not exist/.test(stderr)) return 'missing_relation'
  if (/connection .* failed|could not connect to server/.test(stderr)) return 'connection_failure'
  return stderr ? 'unclassified' : 'no_diagnostic'
}
