import copy
import io
import json

import pytest

from scripts import purpose_preview


def entry(id, **changes):
    return {"id": id, "user_id": 2, "task_id": id, "project_id": 1,
            "project": "research", "repo": "paper", "description": "Implement issue 12", **changes}


def test_preview_reconciles_segments_and_owners_without_inference_or_mutation():
    data = {"entries": [entry(3, user_id=3, task_id=1), entry(2, task_id=1),
                        entry(1), entry(4, task_id=None)], "token": "PRIVATE"}
    before = copy.deepcopy(data)
    result = purpose_preview.build_preview(data)

    assert result["summary"] == {
        "segments": 4, "tasks": 3, "classified_tasks": 0, "unclassified_tasks": 3,
        "conflicting_tasks": 0,
        "purpose_counts": {"research": 0, "career": 0, "business": 0, "support": 0, "unclassified": 3},
    }
    assert [(row["user_id"], row["task_id"], row["segment_ids"]) for row in result["tasks"]] == [
        (2, 1, [1, 2]), (2, 4, [4]), (3, 1, [3]),
    ]
    assert all(row["proposed_purpose"] is None for row in result["tasks"])
    assert all(row["confidence"] == "needs-review" for row in result["tasks"])
    assert data == before
    assert "PRIVATE" not in json.dumps(result)
    assert "hours" not in json.dumps(result)


def test_recorded_purpose_takes_priority_and_every_original_context_is_preserved():
    rows = [entry(2, task_id=1, project="shopfront", project_id=7, repo="app", purpose="career"),
            entry(1, purpose="career")]
    result = purpose_preview.build_preview(rows, {"projects": {"research": "research", "shopfront": "business"}})
    task = result["tasks"][0]
    assert task["proposed_purpose"] == "career"
    assert task["confidence"] == "explicit"
    assert task["original_projects"] == [{"id": 1, "name": "research"}, {"id": 7, "name": "shopfront"}]
    assert task["repos"] == ["app", "paper"]
    assert task["descriptions"] == ["Implement issue 12"]
    assert result["summary"]["purpose_counts"]["career"] == 1


@pytest.mark.parametrize("second,reason", [("business", "conflict"), (None, "missing")])
def test_conflicting_or_partial_recorded_intent_cannot_be_overridden(second, reason):
    result = purpose_preview.build_preview(
        [entry(1, purpose="research"), entry(2, task_id=1, purpose=second)],
        {"projects": {"research": "research"}},
    )
    task = result["tasks"][0]
    assert task["proposed_purpose"] is None
    assert task["confidence"] == "needs-review"
    assert reason in " ".join(task["reasons"]).lower()
    assert "Segment 1 records purpose 'research'" in task["reasons"]
    assert f"Segment 2 records purpose {second!r}" in task["reasons"]
    assert result["summary"]["conflicting_tasks"] == (second is not None)


def test_charters_are_explicit_exact_matches_and_cover_every_segment():
    rows = [entry(1), entry(2, task_id=1, repo="another"),
            entry(3, project="research-extra", project_id=2, repo="paper-extra")]
    result = purpose_preview.build_preview(rows, {"projects": {"research": "research"}})
    assert result["tasks"][0]["proposed_purpose"] == "research"
    assert result["tasks"][0]["confidence"] == "charter-derived"
    assert result["tasks"][1]["proposed_purpose"] is None

    partial = purpose_preview.build_preview(rows[:2], {"repos": {"paper": "research"}})
    assert partial["tasks"][0]["proposed_purpose"] is None
    assert "2" in " ".join(partial["tasks"][0]["reasons"])


def test_conflicting_charters_mark_review_instead_of_choosing_repo_or_project():
    result = purpose_preview.build_preview([entry(1)], {
        "projects": {"research": "research"}, "repos": {"paper": "business"},
    })
    assert result["tasks"][0]["proposed_purpose"] is None
    assert result["summary"]["conflicting_tasks"] == 1


def test_snapshot_catalog_or_explicit_catalog_resolves_api_project_ids():
    rows = [entry(1, project=None)]
    projects = [{"id": 1, "name": "research", "token": "PRIVATE"}]
    charters = {"projects": {"research": "research"}}
    expected = purpose_preview.build_preview({"entries": rows, "projects": projects}, charters)
    assert purpose_preview.build_preview(rows, charters, projects) == expected
    assert expected["tasks"][0]["proposed_purpose"] == "research"
    assert "PRIVATE" not in json.dumps(expected)
    assert purpose_preview.build_preview(rows)["tasks"][0]["original_projects"] == [{"id": 1, "name": None}]


def test_output_is_deterministic_under_input_reordering():
    rows = [entry(2, task_id=1, project="x", project_id=2, repo=None), entry(1), entry(3)]
    charters = {"projects": {"x": "research", "research": "research"}}
    assert purpose_preview.build_preview(rows, charters) == purpose_preview.build_preview(list(reversed(rows)), charters)


@pytest.mark.parametrize("data,charters", [
    ({}, None), ([None], None), ([entry(1), entry(1)], None),
    ([entry(True)], None), ([entry(1, user_id=None)], None),
    ([entry(1, task_id="1")], None), ([entry(1, purpose="growth")], None),
    ([entry(1, repo=[])], None), ([entry(1)], {"projects": {"research": None}}),
    ([entry(1)], {"projects": {"": "research"}}), ([entry(1)], {"defaults": {}}),
])
def test_invalid_input_is_rejected_before_a_preview_is_returned(data, charters):
    with pytest.raises(ValueError):
        purpose_preview.build_preview(data, charters)


def test_cli_only_reads_input_files_and_prints_json(tmp_path, capsys, monkeypatch):
    source = tmp_path / "snapshot.json"
    charters = tmp_path / "charters.json"
    projects = tmp_path / "projects.json"
    source.write_text(json.dumps([entry(1, project=None)]))
    charters.write_text(json.dumps({"projects": {"research": "research"}}))
    projects.write_text(json.dumps([{"id": 1, "name": "research"}]))
    original = {path: path.read_bytes() for path in tmp_path.iterdir()}
    real_open = io.open

    def read_only_open(file, mode="r", *args, **kwargs):
        assert not any(flag in mode for flag in "wax+")
        return real_open(file, mode, *args, **kwargs)

    monkeypatch.setattr(io, "open", read_only_open)
    assert purpose_preview.main([str(source), "--charters", str(charters), "--projects", str(projects)]) == 0
    assert json.loads(capsys.readouterr().out)["tasks"][0]["proposed_purpose"] == "research"
    assert {path: path.read_bytes() for path in tmp_path.iterdir()} == original
    with pytest.raises(SystemExit):
        purpose_preview.main([str(source), "--apply"])


def test_cli_invalid_json_returns_error_without_partial_output(tmp_path, capsys):
    source = tmp_path / "bad.json"
    source.write_text("{")
    assert purpose_preview.main([str(source)]) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "error:" in captured.err
