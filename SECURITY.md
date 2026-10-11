# Security policy

Security fixes target the latest release and the `main` branch. Upgrade the
website and its pinned core together; an older core revision can retain a
vulnerability even when the browser assets are current.

## Reporting a vulnerability

Use [private vulnerability reporting](https://github.com/Kay0k1/cutmyvideo-web/security/advisories/new)
for session isolation, script injection, unsafe media access, deployment or
credential exposure. Do not disclose vulnerability details in public issues.
Maintainers can coordinate a fix in a draft GitHub security advisory.

For a vulnerability in the public media engine or HTTP API, follow the
[core repository's security policy](https://github.com/Kay0k1/cutmyvideo-core/security/policy).

Include the affected revision, deployment configuration without secrets,
reproduction steps, expected/actual behavior and impact. Use synthetic media and
test accounts. Do not include production cookies, passwords, private keys or
signed source URLs. Do not access other users' media while investigating.

Ordinary website defects and feature requests belong in this repository's
public issues. Using the hosted editor does not require a GitHub account.

## Deployment requirements

Serve the site and API from one HTTPS origin, retain the documented CSP and
ownership checks, keep PostgreSQL/internal API ports private, and preserve the
processing network restrictions. Review [DEPLOYMENT.md](docs/DEPLOYMENT.md) before
making an internet-facing installation. Browser emulation is not an independent
security audit.
