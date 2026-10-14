#!/usr/bin/env python3
"""Require the complete collected Playwright inventory across isolated CI jobs."""
import argparse
from collections import Counter
import json
import math
import os
from pathlib import Path


PROJECTS = frozenset(('desktop', 'mobile', 'layout-chromium', 'layout-firefox',
                      'usability-chromium', 'usability-firefox',
                      'layout-webkit', 'usability-webkit'))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def cases(report):
    require(not report.get('errors'), 'Browser report contains runner errors')
    result = {}

    def walk(suites):
        for suite in suites:
            for spec in suite.get('specs', []):
                require(isinstance(spec.get('id'), str) and spec['id'], 'Missing test identity')
                for test in spec['tests']:
                    project = test['projectName']
                    require(project in PROJECTS, 'Unknown browser project')
                    key = (project, spec['id'])
                    require(key not in result, 'Duplicate test identity')
                    result[key] = (spec, test)
            walk(suite.get('suites', []))

    walk(report['suites'])
    require(result, 'Empty browser inventory or execution report')
    return result


def verify(inventory, reports, project=None):
    expected = cases(inventory)
    projects = {key[0] for key in expected}
    require(projects == ({project} if project else PROJECTS), 'Collected project set is incomplete')
    identity = inventory['config']['metadata']['ci']
    require(identity == {'commit': os.environ.get('GITHUB_SHA', 'local'),
                         'run': os.environ.get('GITHUB_RUN_ID', 'local'),
                         'attempt': os.environ.get('GITHUB_RUN_ATTEMPT', 'local')},
            'Collected inventory belongs to another source, run or attempt')
    observed, skipped = {}, Counter()
    durations = []
    for report in reports:
        require(report['config']['metadata']['ci'] == identity, 'Execution source/run identity differs')
        require(report['stats']['unexpected'] == 0, 'Unexpected browser test result')
        duration = report['stats']['duration']
        require(isinstance(duration, (int, float)) and math.isfinite(duration) and duration >= 0,
                'Invalid browser execution duration')
        durations.append(duration)
        for key, (spec, test) in cases(report).items():
            require(key in expected and key not in observed, 'Unexpected or multiply executed test')
            expected_spec, _ = expected[key]
            require(all(spec[field] == expected_spec[field] for field in ('title', 'file', 'line', 'column')),
                    'Test location differs from the collected inventory')
            results = test['results']
            require(len(results) == 1 and results[0].get('retry', 0) == 0,
                    'Each browser case must execute once without retries')
            status = results[0]['status']
            if status == 'skipped':
                require(test['expectedStatus'] == 'skipped' and any(
                    item.get('type') == 'skip' and item.get('description')
                    for item in test.get('annotations', [])), 'Unexplained skipped browser test')
                # Preserve existing explicit opt-in/device skips; missing tests
                # and a skipped database-contract group are never accepted.
                require('core-contract.spec.ts' not in spec['file'], 'Database fault contract must actually pass')
                skipped[key[0]] += 1
            else:
                require(status == 'passed' and test['expectedStatus'] == 'passed',
                        'Browser test failed, was interrupted or expected failure')
            observed[key] = test
    require(set(observed) == set(expected), 'Browser coverage is missing collected cases')
    counts = Counter(key[0] for key in expected)
    return {'ok': True, 'ci': identity, 'cases': len(expected),
            'projects': {name: {'collected': counts[name], 'passed': counts[name] - skipped[name],
                                'skipped': skipped[name]} for name in sorted(projects)},
            'report_durations_ms': durations}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', type=Path, required=True)
    parser.add_argument('--reports', type=Path, nargs='+', required=True)
    parser.add_argument('--project', choices=sorted(PROJECTS))
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    receipt = verify(json.loads(args.inventory.read_text()),
                     [json.loads(path.read_text()) for path in args.reports], args.project)
    args.output.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
