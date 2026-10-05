"""Cleanup failures in the isolated measurement tool must stay isolated."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC=importlib.util.spec_from_file_location('load_profile',Path(__file__).parent.parent/'scripts'/'load-profile.py')
runner=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class LoadCleanupTest(unittest.TestCase):
    def test_log_timeout_still_removes_all_owned_containers_and_network(self):
        owner='cutmy-load-fixture'
        calls=[]
        def docker(argv,**kwargs):
            calls.append(argv)
            if argv[1]=='logs':
                raise subprocess.TimeoutExpired(argv,15)
            return subprocess.CompletedProcess(argv,0,stdout=(owner+'\n').encode())
        with tempfile.TemporaryDirectory() as temporary,patch.object(runner.subprocess,'run',side_effect=docker):
            runner.remove_owned(owner,[owner+'-api',owner+'-worker'],True,Path(temporary))
            status=json.loads((Path(temporary)/'cleanup.json').read_text())
        self.assertTrue(status['cleanup_complete'])
        self.assertEqual(len([argv for argv in calls if argv[1]=='rm']),2)
        self.assertTrue(any(argv[1:3]==['network','rm'] for argv in calls))

    def test_foreign_name_and_failed_inspection_are_never_removed_or_claimed_clean(self):
        for result in (subprocess.CompletedProcess([],0,stdout=b'foreign\n'),subprocess.CompletedProcess([],1,stdout=b'')):
            calls=[]
            def docker(argv,**kwargs):
                calls.append(argv)
                return result
            with tempfile.TemporaryDirectory() as temporary,patch.object(runner.subprocess,'run',side_effect=docker):
                runner.remove_owned('cutmy-load-fixture',['cutmy-load-fixture-api'],False,Path(temporary))
                status=json.loads((Path(temporary)/'cleanup.json').read_text())
            self.assertFalse(status['cleanup_complete'])
            self.assertFalse(any(argv[1]=='rm' for argv in calls))

    def test_container_removal_timeout_does_not_skip_other_owned_removals(self):
        owner='cutmy-load-fixture'
        calls=[]
        def docker(argv,**kwargs):
            calls.append(argv)
            if argv[1]=='rm' and argv[-1].endswith('-worker'):
                raise subprocess.TimeoutExpired(argv,30)
            return subprocess.CompletedProcess(argv,0,stdout=(owner+'\n').encode())
        with tempfile.TemporaryDirectory() as temporary,patch.object(runner.subprocess,'run',side_effect=docker):
            runner.remove_owned(owner,[owner+'-api',owner+'-worker'],False,Path(temporary))
            status=json.loads((Path(temporary)/'cleanup.json').read_text())
        self.assertFalse(status['cleanup_complete'])
        self.assertEqual(len([argv for argv in calls if argv[1]=='rm']),2)


if __name__=='__main__':
    unittest.main()
