#!/usr/bin/env python3
"""Two complete browser runs can keep distinct local fixture servers alive."""
import os
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
from contextlib import suppress
from pathlib import Path
from unittest.mock import patch

import e2e_dashboard as dashboard
from e2e_dashboard import ROOT


def check_startup_failures():
    for name, program in [
        ('no output', 'exec sleep 30'),
        ('partial line', "printf 'http://127.0.0.1:'; exec sleep 30"),
        ('early exit', "printf 'http://127.0.0.1:'; exit 0"),
        ('invalid line', "printf 'not-a-loopback-url\\n'; exec sleep 30"),
    ]:
        with tempfile.TemporaryDirectory(prefix='fixture-startup-') as folder:
            node = Path(folder) / 'node'
            node.write_text('#!/bin/sh\n' + program + '\n')
            node.chmod(0o755)
            children = []
            original = subprocess.Popen

            def spawn(*args, **kwargs):
                child = original(*args, **kwargs)
                children.append(child)
                return child

            started = time.monotonic()
            with patch.dict(os.environ, {'PATH': folder + os.pathsep + os.environ['PATH']}), patch.object(dashboard.subprocess, 'Popen', side_effect=spawn):
                try:
                    dashboard.start_server()
                except RuntimeError:
                    pass
                else:
                    raise AssertionError(f'{name} unexpectedly started')
            elapsed = time.monotonic() - started
            assert elapsed < 8, (name, elapsed)
            if name in ['no output', 'partial line']:
                assert elapsed >= 4.5, (name, elapsed)
            assert len(children) == 1 and children[0].poll() is not None, name
            assert children[0].stdout.closed, name
            print(f'PASS bounded fixture startup: {name}, child reaped and pipe closed')


def main():
    check_startup_failures()
    runs = []
    try:
        for _ in range(2):
            runs.append(subprocess.Popen([sys.executable, 'scripts/e2e_route_validation.py'], cwd=ROOT,
                                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                         text=True, start_new_session=True))
        urls = []
        for run in runs:
            line = run.stdout.readline().strip()
            assert line.startswith('Fixture server: http://127.0.0.1:'), line
            urls.append(line.removeprefix('Fixture server: '))
        assert urls[0] != urls[1], urls
        assert all(run.poll() is None for run in runs), 'browser runs did not overlap'
        for url in urls:
            with urllib.request.urlopen(url, timeout=5) as response:
                assert response.status == 200
        for run in runs:
            output, _ = run.communicate(timeout=120)
            assert run.returncode == 0, output
            assert 'PASS invalid routes and usable navigation 1440px' in output, output
            assert 'PASS invalid routes and usable navigation 390px' in output, output
        print('PASS overlapping browser runs: distinct live fixture ports and both desktop/mobile suites passed')
    finally:
        for run in runs:
            if run.poll() is None:
                with suppress(ProcessLookupError):
                    os.killpg(run.pid, signal.SIGTERM)
                run.wait()
            run.stdout.close()


if __name__ == '__main__':
    main()
