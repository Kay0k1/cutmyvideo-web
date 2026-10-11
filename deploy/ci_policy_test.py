import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("ci_policy", Path(__file__).with_name("ci-policy.py"))
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class CIPolicyTests(unittest.TestCase):
    def test_docs_only_pr_keeps_frontend_but_skips_heavy_checks(self):
        self.assertEqual(policy.scope("pull_request", "refs/pull/1/merge",
                         ["README.md", "docs/QA.md", "LICENSE"]),
                         {"full": False, "image": False})

    def test_runtime_dependencies_and_unknown_paths_require_full_checks(self):
        for path in ["src/App.tsx", "package-lock.json", "core.version", "Dockerfile",
                     "nginx.conf", "deploy/compose.yaml", "e2e/layout.spec.ts",
                     ".github/workflows/checks.yml", "future/new-format", "src/runtime.md", "file\nname"]:
            with self.subTest(path=path):
                self.assertEqual(policy.scope("pull_request", "refs/pull/1/merge",
                                 ["README.md", path]), {"full": True, "image": True})

    def test_missing_diff_fails_toward_full_checks(self):
        self.assertEqual(policy.scope("pull_request", "refs/pull/1/merge", []),
                         {"full": True, "image": True})

    def test_main_push_builds_image_without_repeating_full_matrix(self):
        self.assertEqual(policy.scope("push", "refs/heads/main", ["src/App.tsx"]),
                         {"full": False, "image": True})

    def test_tags_and_manual_runs_always_require_full_checks(self):
        for event, ref in [("push", "refs/tags/v0.2.2"),
                           ("workflow_dispatch", "refs/heads/main")]:
            self.assertEqual(policy.scope(event, ref, ["README.md"]),
                             {"full": True, "image": True})

    def test_code_renamed_to_docs_is_not_treated_as_docs_only(self):
        self.assertEqual(policy.scope("pull_request", "refs/pull/1/merge",
                         ["src/App.tsx", "docs/old-app.md"]),
                         {"full": True, "image": True})
