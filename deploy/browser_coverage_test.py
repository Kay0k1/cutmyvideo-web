from copy import deepcopy
import importlib.util
import os
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('browser_coverage', Path(__file__).with_name('browser-coverage.py'))
coverage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(coverage)


def report(project='desktop', count=2, executed=True):
    cases = []
    for index in range(count):
        cases.append({'id': f'{project}-{index}', 'title': f'Case {index}',
                      'file': 'workflow.spec.ts', 'line': index + 1, 'column': 1,
                      'tests': [{'projectName': project, 'expectedStatus': 'passed',
                                 'annotations': [], 'results': [{'status': 'passed', 'retry': 0}] if executed else []}]})
    return {'config': {'metadata': {'ci': {'commit': os.environ.get('GITHUB_SHA', 'local'),
                                        'run': os.environ.get('GITHUB_RUN_ID', 'local'),
                                        'attempt': os.environ.get('GITHUB_RUN_ATTEMPT', 'local')}}},
            'suites': [{'specs': cases}], 'errors': [], 'stats': {'unexpected': 0, 'duration': 10}}


class BrowserCoverageTests(unittest.TestCase):
    def setUp(self):
        self.inventory = report(executed=False)
        self.execution = report()

    def test_partitioned_reports_cover_the_collected_inventory(self):
        second = deepcopy(self.execution)
        second['suites'][0]['specs'] = [second['suites'][0]['specs'].pop()]
        self.execution['suites'][0]['specs'].pop()
        result = coverage.verify(self.inventory, [self.execution, second], 'desktop')
        self.assertEqual(result['projects']['desktop'], {'collected': 2, 'passed': 2, 'skipped': 0})

    def test_all_eight_projects_are_required(self):
        inventory = report(count=0, executed=False)
        reports = [report(project) for project in sorted(coverage.PROJECTS)]
        inventory['suites'] = [r['suites'][0] for r in reports]
        self.assertEqual(coverage.verify(inventory, reports)['cases'], 16)
        for project in coverage.PROJECTS:
            with self.assertRaises(ValueError):
                coverage.verify(inventory, [r for r in reports if r['suites'][0]['specs'][0]['tests'][0]['projectName'] != project])

    def test_missing_duplicate_or_unexecuted_cases_fail(self):
        for mutation in ('missing', 'duplicate', 'unexecuted'):
            execution = deepcopy(self.execution)
            if mutation == 'missing': execution['suites'][0]['specs'].pop()
            elif mutation == 'duplicate': execution['suites'][0]['specs'].append(deepcopy(execution['suites'][0]['specs'][0]))
            else: execution['suites'][0]['specs'][0]['tests'][0]['results'] = []
            with self.assertRaises(ValueError): coverage.verify(self.inventory, [execution], 'desktop')

    def test_failures_interruptions_retries_and_runner_errors_fail(self):
        for mutation in ('failed', 'timedOut', 'interrupted', 'retry', 'runner', 'unexpected', 'expected_failure'):
            execution = deepcopy(self.execution)
            test = execution['suites'][0]['specs'][0]['tests'][0]
            if mutation in ('failed', 'timedOut', 'interrupted'): test['results'][0]['status'] = mutation
            elif mutation == 'retry': test['results'][0]['retry'] = 1
            elif mutation == 'runner': execution['errors'] = [{'message': 'Runner crashed'}]
            elif mutation == 'unexpected': execution['stats']['unexpected'] = 1
            else: test['expectedStatus'] = 'failed'
            with self.assertRaises(ValueError): coverage.verify(self.inventory, [execution], 'desktop')

    def test_wrong_source_attempt_location_or_project_fail(self):
        for mutation in ('commit', 'attempt', 'location', 'project'):
            execution = deepcopy(self.execution)
            if mutation in ('commit', 'attempt'): execution['config']['metadata']['ci'][mutation] = 'other'
            elif mutation == 'location': execution['suites'][0]['specs'][0]['line'] = 1000
            else: execution['suites'][0]['specs'][0]['tests'][0]['projectName'] = 'missing-browser'
            with self.assertRaises(ValueError): coverage.verify(self.inventory, [execution], 'desktop')

    def test_explicit_device_skip_is_retained_but_contract_skip_fails(self):
        test = self.execution['suites'][0]['specs'][0]['tests'][0]
        test['expectedStatus'] = test['results'][0]['status'] = 'skipped'
        with self.assertRaises(ValueError): coverage.verify(self.inventory, [self.execution], 'desktop')
        test['annotations'] = [{'type': 'skip', 'description': 'Explicit touch-only scenario'}]
        self.assertEqual(coverage.verify(self.inventory, [self.execution], 'desktop')['projects']['desktop']['skipped'], 1)
        for item in (self.inventory, self.execution): item['suites'][0]['specs'][0]['file'] = 'core-contract.spec.ts'
        with self.assertRaises(ValueError): coverage.verify(self.inventory, [self.execution], 'desktop')
