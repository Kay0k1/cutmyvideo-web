# Lightweight verification

Keep test code and short conclusions in the repository. Put generated videos,
traces and raw sampled logs in a temporary directory and remove them after a
successful check. A failed check may retain ignored `artifacts/` for up to seven
days; CI diagnostics expire after three days. Local browser checks automatically
delete their temporary output on success and prune owned failure directories
older than seven days on the next run. Explicit `CUTMY_E2E_OUTPUT` paths remain
caller-managed. Do not create a dated benchmark
report for every change or repeat passed checks without a reason.

The tracked artifact guard runs in CI. Actual regression fixtures and product
assets are separate from diagnostic output. Historical compact observations
remain available, with the core's raw records linked to their original revision.

Legacy local workspace reports can be pruned with the core's
`scripts/prune-workspace-artifacts.py --root /absolute/workspace/reports`.
It defaults to a dry run and seven-day retention, and never targets production
media, database backups or migration snapshots. Add `--apply` only after the
corresponding checks have finished.
