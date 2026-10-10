# Contributing

This is the private product website repository. These instructions apply to
invited collaborators. The public MIT media engine is maintained in
[cutmyvideo-core](https://github.com/Kay0k1/cutmyvideo-core).

Small, focused pull requests are welcome from collaborators. Russian and English
reports are both accepted. Check existing repository issues first; describe larger changes before investing
in a redesign or a new integration.

## Local development

Follow the [README quick start](README.en.md#local-development). Keep the core
repository beside this repository; `core.version` records the exact revision
used by CI. Media operations belong in
[cutmyvideo-core](https://github.com/Kay0k1/cutmyvideo-core), while browser behavior,
translations, accessibility and product deployment belong here.

Do not edit `core.version` just to make a failing integration check disappear.
When updating it, verify the new core revision with the real browser suite and
explain the required behavior in the pull request.

## Checks

```sh
npm ci
npm test
npm run build
npm run test:deploy
```

For changes to the editor, API integration, media playback or downloads, start an
isolated real core/database/worker and run the relevant Playwright cases. See
[QA](docs/QA.md#running-the-integrated-checks) for fixture limits and browser
projects. Tests create and delete actual media; use a disposable database and
media directory. External providers and the three-hour fixture are opt-in.

Keep both interface languages complete, keyboard operation usable, and storage
migrations compatible with saved browser drafts. Prefer a regression test that
exercises the bug over tests that repeat the implementation. Do not remove real
playback, decoded-frame or downloaded-file assertions to work around an
environment failure.

For deployment changes, run the deployment fault-injection checks. Production
settings, keys, cookies, media URLs with access tokens and database dumps must
never enter commits, issues or test artifacts. Report vulnerabilities through
[SECURITY.md](SECURITY.md).

## Pull requests

Describe the problem, the resulting user behavior and the checks you ran. Add an
entry to the relevant Unreleased section in [CHANGELOG.md](CHANGELOG.md). Include
screenshots when a visible change is difficult to explain in words. Keep
dependency updates reproducible through `package-lock.json`.

Project contributions are licensed under [MIT](LICENSE). The bundled Geologica
font keeps its separate [SIL Open Font License](public/licenses/geologica.txt).
