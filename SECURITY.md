# Security policy

Security fixes target the latest release and the `main` branch. Upgrade the
website and its pinned core together; an older core revision can retain a
vulnerability even when the browser assets are current.

## Reporting a vulnerability

This repository is private. Collaborators should request a private reporting
channel from the repository owner for session isolation, script injection,
unsafe media access, deployment or credential exposure. A repository issue may
request that channel, but must not contain vulnerability details. Maintainers
can coordinate a fix in a draft GitHub security advisory where available.

For a vulnerability in the public media engine or HTTP API, follow the
[core repository's security policy](https://github.com/Kay0k1/cutmyvideo-core/security/policy).

Include the affected revision, deployment configuration without secrets,
reproduction steps, expected/actual behavior and impact. Use synthetic media and
test accounts. Do not include production cookies, passwords, private keys or
signed source URLs. Do not access other users' media while investigating.

Ordinary website defects and feature requests belong in this private
repository's issues. The hosted site's users do not need access to this source
repository to use the editor.

## Deployment requirements

Serve the site and API from one HTTPS origin, retain the documented CSP and
ownership checks, keep PostgreSQL/internal API ports private, and preserve the
processing network restrictions. Review [DEPLOYMENT.md](docs/DEPLOYMENT.md) before
making an internet-facing installation. Browser emulation is not an independent
security audit.
