import pytest

import timetracker_log


@pytest.fixture
def calls(monkeypatch):
    requests = []

    def request(method, path, profile, body=None):
        requests.append((method, path, profile, body))
        if path == '/api/projects':
            return [{'id': 4, 'name': 'etc'}]
        if path == '/api/activities':
            return [{'id': 2, 'name': 'implement'}]
        return {'id': 17}

    monkeypatch.setattr(timetracker_log, '_request', request)
    monkeypatch.setattr(timetracker_log, '_repo_name', lambda _: 'example')
    monkeypatch.setattr(timetracker_log, '_warn_misclassification', lambda *args: None)
    return requests


@pytest.mark.parametrize('purpose', ['research', 'career', 'business', 'support'])
def test_start_sends_explicit_purpose_independently_of_project(calls, purpose):
    assert timetracker_log.start_task('model', 'etc', 'Build a test harness', 'implement', '/work', purpose) == 17
    assert calls[-1] == ('POST', '/api/timesheets', 'model', {
        'project': 4, 'activity': 2, 'description': 'Build a test harness',
        'repo': 'example', 'purpose': purpose,
    })


def test_omitted_purpose_preserves_legacy_payload(calls):
    timetracker_log.start_task('model', 'etc', 'Build a test harness', 'implement', '/work')
    assert 'purpose' not in calls[-1][3]


@pytest.mark.parametrize('purpose', ['Research', '', 'unclassified', 'etc', 42])
def test_invalid_purpose_fails_before_requests(monkeypatch, purpose):
    monkeypatch.setattr(timetracker_log, '_request', lambda *args: pytest.fail('unexpected request'))
    with pytest.raises(ValueError, match='purpose must be'):
        timetracker_log.start_task('model', 'etc', 'Task', purpose=purpose)


def test_cli_start_passes_purpose(calls, capsys):
    assert timetracker_log.main(['start', 'model', 'etc', 'Task', '--kind', 'implement', '--work-dir', '/work', '--purpose', 'career']) == 0
    assert calls[-1][3]['purpose'] == 'career'
    assert capsys.readouterr().out == '17\n'


def test_cli_rejects_invalid_purpose_before_requests(monkeypatch):
    monkeypatch.setattr(timetracker_log, '_request', lambda *args: pytest.fail('unexpected request'))
    with pytest.raises(SystemExit) as error:
        timetracker_log.main(['start', 'model', 'etc', 'Task', '--purpose', 'Research'])
    assert error.value.code == 2


def test_resume_keeps_inheritance_payload(calls):
    assert timetracker_log.resume_task('model', 17) == 17
    assert calls == [('POST', '/api/timesheets', 'model', {'resume_of': 17})]
