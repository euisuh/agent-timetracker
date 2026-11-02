import copy
import http.client
import json
import os
import urllib.error
import urllib.request

import pytest

import purpose_apply
from scripts import purpose_preview


def entry(id, **changes):
    return {"id": id, "user_id": 2, "task_id": 1, "project_id": 7, "repo": None,
            "description": "Price the golf product", "begin": "2026-10-01T00:00:00.123Z",
            "end": "2026-10-01T01:00:00.123Z", "purpose": None, "end_reason": "done",
            "tokens_input": 123, "tokens_by_agent": [{"user_id": 2, "output": 4}], **changes}


def manifest(rows):
    return {"decisions": [{"user_id": rows[0]["user_id"], "task_id": purpose_preview.task_key(rows[0])[1],
                           "purpose": "business", "reason": "Reviewed product pricing intent",
                           "sources": ["/private/product/README.md"],
                           "segments": [{field: row[field] for field in purpose_preview.REVIEW_FIELDS}
                                        for row in rows]}]}


def test_reviewed_preview_matches_complete_task_and_overrides_only_defaults():
    rows = [entry(1, task_id=None), entry(2), entry(3, user_id=3, task_id=1)]
    before = copy.deepcopy(rows)
    decisions = manifest(rows[:2])
    result = purpose_preview.build_preview(rows, {"projects": {}, "repos": {}}, decisions=decisions)
    assert rows == before
    assert result["tasks"][0]["segment_ids"] == [1, 2]
    assert result["tasks"][0]["proposed_purpose"] == "business"
    assert result["tasks"][0]["confidence"] == "reviewed"
    assert result["tasks"][0]["sources"] == decisions["decisions"][0]["sources"]
    assert result["tasks"][1]["proposed_purpose"] is None


@pytest.mark.parametrize("purposes", [("research", "research"), (None, "research"), ("career", "research")])
def test_review_decisions_never_override_accepted_or_mixed_intent(purposes):
    rows = [entry(1, purpose=purposes[0]), entry(2, purpose=purposes[1])]
    task = purpose_preview.build_preview(rows, decisions=manifest(rows))["tasks"][0]
    assert task["proposed_purpose"] == ("research" if purposes == ("research", "research") else None)
    assert task["confidence"] != "reviewed"


@pytest.mark.parametrize("change", [
    lambda rows: rows.pop(),
    lambda rows: rows.append(entry(3)),
    lambda rows: rows[0].update(description="Different assignment"),
    lambda rows: rows[0].update(repo="another"),
    lambda rows: rows[0].update(begin="2026-10-02T00:00:00.123Z"),
    lambda rows: rows[0].update(project_id=8),
    lambda rows: rows[0].update(user_id=3),
    lambda rows: rows[0].update(task_id=9),
    lambda rows: rows[0].update(end=None),
    lambda rows: rows[0].pop("purpose"),
    lambda rows: rows[0].pop("end"),
])
def test_changed_missing_or_open_review_fails_before_output(change):
    rows = [entry(1), entry(2)]
    decisions = manifest(rows)
    change(rows)
    with pytest.raises(ValueError):
        purpose_preview.build_preview(rows, decisions=decisions)


@pytest.mark.parametrize("change", [
    lambda d: d.update(extra="untrusted"),
    lambda d: d.update(user_id=True),
    lambda d: d.update(purpose=None),
    lambda d: d.update(reason=" "),
    lambda d: d.update(sources=["relative/README.md"]),
    lambda d: d.update(segments=[]),
    lambda d: d["segments"][0].update(begin="yesterday"),
    lambda d: d["segments"][0].update(begin="2026-01-01"),
    lambda d: d["segments"][0].update(project_id=True),
    lambda d: d["segments"][0].update(repo=[]),
    lambda d: d["segments"][0].update(extra="untrusted"),
    lambda d: d["segments"].append(copy.deepcopy(d["segments"][0])),
])
def test_malformed_review_rejected(change):
    decisions = manifest([entry(1)])
    change(decisions["decisions"][0])
    with pytest.raises(ValueError):
        purpose_preview.build_preview([entry(1)], decisions=decisions)


def test_duplicate_review_owner_keys_and_cross_task_segment_reuse_rejected():
    decisions = manifest([entry(1)])
    decisions["decisions"].append(copy.deepcopy(decisions["decisions"][0]))
    with pytest.raises(ValueError):
        purpose_preview.reviewed_decisions(decisions)
    decisions["decisions"][1]["user_id"] = 3
    with pytest.raises(ValueError):
        purpose_preview.reviewed_decisions(decisions)


def test_preview_cli_decisions_remains_readonly(tmp_path, monkeypatch, capsys):
    rows = [entry(1), entry(2)]
    snapshot, decisions = tmp_path / "snapshot.json", tmp_path / "decisions.json"
    snapshot.write_text(json.dumps(rows))
    decisions.write_text(json.dumps(manifest(rows)))
    monkeypatch.setattr(urllib.request, "build_opener", lambda *args: pytest.fail("network used"))
    assert purpose_preview.main([str(snapshot), "--decisions", str(decisions)]) == 0
    assert json.loads(capsys.readouterr().out)["summary"]["purpose_counts"]["business"] == 1
    assert json.loads(snapshot.read_text()) == rows


class FakeAPI:
    def __init__(self, rows):
        self.rows = copy.deepcopy(rows)
        self.calls = []
        self.error = None
        self.mutate_after_patch = None
        self.capabilities = {"purpose_review": {"version": 1, "closed_only": True}}

    def __call__(self, method, path, profile, body=None):
        self.calls.append((method, path, profile, body))
        if method == "GET" and path == "/api/capabilities":
            return copy.deepcopy(self.capabilities)
        if method == "GET":
            return copy.deepcopy(self.rows)
        assert method == "PATCH"
        assert set(body) == {"purpose", "purpose_review"}
        assert body["purpose_review"]["closed_only"] is True
        assert set(body["purpose_review"]) == {"segments", "closed_only"}
        if self.error:
            raise self.error
        ids = {row["id"] for row in body["purpose_review"]["segments"]}
        for row in self.rows:
            if row["id"] in ids:
                row["purpose"] = body["purpose"]
        if self.mutate_after_patch:
            self.mutate_after_patch(self.rows)
        return copy.deepcopy(self.rows[0])


def test_apply_is_offline_dry_run_by_default():
    api = FakeAPI([entry(1)])
    report = purpose_apply.apply_reviews(api.rows, manifest(api.rows), {"2": "claude"}, request=api)
    assert report["counts"] == {"dry-run": 1}
    assert api.calls == []
    assert api.rows[0]["purpose"] is None


def test_apply_uses_owner_and_guard_then_compares_full_task_objects():
    rows = [entry(1, task_id=None), entry(2)]
    api, events = FakeAPI(rows), []
    report = purpose_apply.apply_reviews(rows, manifest(rows), {"2": "claude"},
                                        apply=True, request=api, emit=events.append)
    assert report["counts"] == {"verified": 1}
    assert [call[:3] for call in api.calls] == [
        ("GET", "/api/capabilities", "claude"),
        ("GET", "/api/timesheets", "claude"), ("PATCH", "/api/timesheets/1", "claude"),
        ("GET", "/api/timesheets", "claude")]
    assert [row for row in events if row["event"] == "before"][0]["entries"] == rows
    after = [row for row in events if row["event"] == "after"][0]
    assert after["nonpurpose_fields_preserved"] is True
    assert after["entries"][0]["tokens_by_agent"] == rows[0]["tokens_by_agent"]


@pytest.mark.parametrize("change", [
    lambda rows: rows[0].update(tokens_input=999),
    lambda rows: rows[0]["tokens_by_agent"][0].update(output=999),
    lambda rows: rows[0].update(end=None),
    lambda rows: rows.append(entry(3, purpose="business")),
    lambda rows: rows[0].update(purpose="career"),
])
def test_after_read_detects_other_field_changes_or_wrong_purpose(change):
    rows = [entry(1)]
    api = FakeAPI(rows)
    api.mutate_after_patch = change
    report = purpose_apply.apply_reviews(rows, manifest(rows), {"2": "claude"},
                                        apply=True, request=api, emit=lambda event: None)
    assert report["counts"] == {"verification-failed": 1}


@pytest.mark.parametrize("change,status", [
    (lambda rows: rows[0].update(purpose="research"), "already-classified"),
    (lambda rows: rows[0].update(end=None), "stale"),
    (lambda rows: rows[0].update(description="changed"), "stale"),
    (lambda rows: rows.append(entry(2)), "stale"),
    (lambda rows: rows[0].update(user_id=3), "owner-preflight-failed"),
])
def test_live_preflight_never_overrides_stale_classified_open_or_other_owner(change, status):
    rows = [entry(1)]
    api = FakeAPI(rows)
    change(api.rows)
    report = purpose_apply.apply_reviews(rows, manifest(rows), {"2": "claude"},
                                        apply=True, request=api, emit=lambda event: None)
    assert report["counts"] == {status: 1}
    assert [call[1] for call in api.calls] == ["/api/capabilities", "/api/timesheets"]


def test_guard_conflict_is_not_retried_or_downgraded_to_ordinary_patch():
    rows = [entry(1)]
    api = FakeAPI(rows)
    api.error = purpose_apply.ApiError(409)
    report = purpose_apply.apply_reviews(rows, manifest(rows), {"2": "claude"},
                                        apply=True, request=api, emit=lambda event: None)
    assert report["counts"] == {"conflict": 1}
    assert len(api.calls) == 3
    assert api.rows == rows


def test_missing_owner_profile_skips_without_loading_credentials():
    api = FakeAPI([entry(1)])
    report = purpose_apply.apply_reviews(api.rows, manifest(api.rows), {}, apply=True,
                                        request=api, emit=lambda event: None)
    assert report["counts"] == {"missing-profile": 1}
    assert api.calls == []


def test_lost_patch_response_stops_further_writes_and_records_verification_failure():
    rows = [entry(1), entry(2, task_id=2)]
    decisions = {"decisions": manifest(rows[:1])["decisions"] + manifest(rows[1:])["decisions"]}
    api = FakeAPI(rows)
    api.error = purpose_apply.ApiError()
    report = purpose_apply.apply_reviews(rows, decisions, {"2": "claude"}, apply=True,
                                        request=api, emit=lambda event: None)
    assert report["counts"] == {"verification-failed": 1, "not-attempted": 1}
    assert [call[0] for call in api.calls] == ["GET", "GET", "PATCH", "GET"]


@pytest.mark.parametrize("capabilities", [
    None, [], {}, {"purpose_review": None}, {"purpose_review": {"version": 1}},
    {"purpose_review": {"version": True, "closed_only": True}},
    {"purpose_review": {"version": 1.0, "closed_only": True}},
    {"purpose_review": {"version": 2, "closed_only": True}},
    {"purpose_review": {"version": 1, "closed_only": 1}},
    {"purpose_review": {"version": 1, "closed_only": False}},
    {"purpose_review": {"version": 1, "closed_only": True, "unknown": True}},
])
def test_capability_check_fails_closed_before_review_receipts_or_writes(capabilities):
    rows = [entry(1)]
    api, events = FakeAPI(rows), []
    api.capabilities = capabilities
    report = purpose_apply.apply_reviews(rows, manifest(rows), {"2": "claude"},
                                        apply=True, request=api, emit=events.append)
    assert report["counts"] == {"server-capability-failed": 1}
    assert [call[1] for call in api.calls] == ["/api/capabilities"]
    assert not any(event["event"] == "before" for event in events)
    assert api.rows == rows


def test_unavailable_capability_endpoint_prevents_writes():
    rows, events = [entry(1)], []

    def old_server(method, path, profile, body=None):
        assert method == "GET" and path == "/api/capabilities"
        raise purpose_apply.ApiError(404)

    report = purpose_apply.apply_reviews(rows, manifest(rows), {"2": "claude"},
                                        apply=True, request=old_server, emit=events.append)
    assert report["counts"] == {"server-capability-failed": 1}
    assert not any(event["event"] == "before" for event in events)


@pytest.mark.parametrize("failure_event,patches", [("start", 0), ("before", 0), ("request-result", 1)])
def test_ledger_failure_stops_mutations_but_verifies_any_attempted_patch(failure_event, patches):
    rows = [entry(1), entry(2, task_id=2)]
    decisions = {"decisions": [manifest([row])["decisions"][0] for row in rows]}
    api, events = FakeAPI(rows), []

    def emit(event):
        if event["event"] == failure_event:
            raise OSError("PRIVATE_RECEIPT_ERROR")
        events.append(event)

    report = purpose_apply.apply_reviews(rows, decisions, {"2": "claude"}, apply=True,
                                        request=api, emit=emit)
    assert report["ledger_error"] is True
    assert "PRIVATE" not in json.dumps(report)
    assert sum(call[0] == "PATCH" for call in api.calls) == patches
    assert api.rows[1]["purpose"] is None
    if patches:
        assert report["counts"] == {"verified": 1, "not-attempted": 1}
        assert api.calls[-1][0] == "GET"
        assert any(event["event"] == "after" for event in events)
    else:
        assert report["counts"] == {"not-attempted": 2}


def test_incomplete_patch_response_is_sanitized_and_verified_without_more_writes(monkeypatch):
    rows = [entry(1), entry(2, task_id=2)]
    decisions = {"decisions": [manifest([row])["decisions"][0] for row in rows]}
    api, events = FakeAPI(rows), []
    monkeypatch.setattr(purpose_apply.timetracker_log, "_credentials",
                        lambda profile: (purpose_apply.API_ORIGIN, "owner", "PRIVATE_TOKEN"))
    monkeypatch.setattr(purpose_apply.timetracker_log, "_access_headers", lambda: {})

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            raise http.client.IncompleteRead(b"PRIVATE_RESPONSE_BYTES", 200)

    class Opener:
        def open(self, request, timeout):
            return Response()

    monkeypatch.setattr(urllib.request, "build_opener", lambda *args: Opener())

    def request(method, path, profile, body=None):
        result = api(method, path, profile, body)
        if method == "PATCH":
            return purpose_apply.api_request(method, path, profile, body)
        return result

    report = purpose_apply.apply_reviews(rows, decisions, {"2": "claude"}, apply=True,
                                        request=request, emit=events.append)
    assert report["counts"] == {"verified": 1, "not-attempted": 1}
    assert sum(call[0] == "PATCH" for call in api.calls) == 1
    assert api.calls[-1][0] == "GET"
    assert "PRIVATE" not in json.dumps(report) + json.dumps(events)


def test_preservation_failure_stops_before_next_twenty_task_batch():
    rows = [entry(id, task_id=id) for id in range(1, 22)]
    decisions = {"decisions": [manifest([row])["decisions"][0] for row in rows]}
    api = FakeAPI(rows)
    api.mutate_after_patch = lambda current: current[0].update(tokens_input=999)
    report = purpose_apply.apply_reviews(rows, decisions, {"2": "claude"}, apply=True,
                                        request=api, emit=lambda event: None)
    assert report["counts"] == {"verification-failed": 1, "verified": 19, "not-attempted": 1}
    assert sum(call[0] == "PATCH" for call in api.calls) == 20
    assert api.rows[-1]["purpose"] is None


def test_network_transport_uses_known_origin_no_redirect_and_timeout(monkeypatch):
    monkeypatch.setattr(purpose_apply.timetracker_log, "_credentials",
                        lambda profile: (purpose_apply.API_ORIGIN, "owner", "PRIVATE_TOKEN"))
    monkeypatch.setattr(purpose_apply.timetracker_log, "_access_headers", lambda: {"Access": "PRIVATE_ACCESS"})

    class Opener:
        def open(self, request, timeout):
            assert request.full_url == purpose_apply.API_ORIGIN + "/api/timesheets"
            assert request.get_header("X-auth-token") == "PRIVATE_TOKEN"
            assert timeout == 20
            raise urllib.error.HTTPError(request.full_url, 302, "PRIVATE_BODY", {}, None)

    def build_opener(handler):
        assert isinstance(handler, purpose_apply.NoRedirect)
        assert handler.redirect_request(None, None, 302, None, None, "https://other.example") is None
        return Opener()

    monkeypatch.setattr(urllib.request, "build_opener", build_opener)
    with pytest.raises(purpose_apply.ApiError) as caught:
        purpose_apply.api_request("GET", "/api/timesheets", "owner")
    assert caught.value.status == 302
    assert "PRIVATE" not in str(caught.value)
    monkeypatch.setattr(purpose_apply.timetracker_log, "_credentials",
                        lambda profile: ("https://other.example", "owner", "PRIVATE_TOKEN"))
    monkeypatch.setattr(urllib.request, "build_opener", lambda *args: pytest.fail("unsafe origin"))
    with pytest.raises(purpose_apply.ApiError):
        purpose_apply.api_request("GET", "/api/timesheets", "owner")


def test_cli_private_ledger_is_exclusive_and_errors_do_not_leak(tmp_path, capsys, monkeypatch):
    snapshot, decisions, profiles, ledger = [tmp_path / name for name in ("s.json", "d.json", "p.json", "l.jsonl")]
    snapshot.write_text(json.dumps([entry(1)]))
    decisions.write_text(json.dumps(manifest([entry(1)])))
    profiles.write_text('{"2":"claude"}')
    args = [str(snapshot), "--decisions", str(decisions), "--profiles", str(profiles), "--ledger", str(ledger)]
    monkeypatch.setattr(purpose_apply.timetracker_log, "_credentials", lambda *args: pytest.fail("dry-run credentials"))
    assert purpose_apply.main(args) == 0
    assert os.stat(ledger).st_mode & 0o777 == 0o600
    original = ledger.read_bytes()
    assert purpose_apply.main(args) == 1
    assert ledger.read_bytes() == original
    assert "PRIVATE" not in capsys.readouterr().err
    with pytest.raises(SystemExit):
        purpose_apply.main([str(snapshot), "--decisions", str(decisions), "--profiles", str(profiles), "--apply"])
