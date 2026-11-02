"""Preview task purposes from local JSON without changing recorded history."""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path


PURPOSES = ("research", "career", "business", "support")
REVIEW_FIELDS = ("id", "project_id", "repo", "description", "begin")


def _positive_id(value):
    return type(value) is int and value > 0


def task_key(entry):
    return entry["user_id"], entry["task_id"] if entry.get("task_id") is not None else entry["id"]


def reviewed_decisions(data):
    """Validate a local review manifest without opening its evidence sources."""
    if not isinstance(data, dict) or set(data) != {"decisions"} or not isinstance(data["decisions"], list):
        raise ValueError("review manifest must contain only a decisions list")
    decisions, segment_ids = {}, set()
    for decision in data["decisions"]:
        if not isinstance(decision, dict) or set(decision) != {
            "user_id", "task_id", "purpose", "reason", "sources", "segments"
        }:
            raise ValueError("review decisions need owner, task, purpose, reason, sources and segments")
        if not all(_positive_id(decision[field]) for field in ("user_id", "task_id")):
            raise ValueError("review owner and task must be positive integer ids")
        key = decision["user_id"], decision["task_id"]
        if key in decisions or decision["purpose"] not in PURPOSES:
            raise ValueError("review decisions need unique owner/task keys and a supported purpose")
        if not isinstance(decision["reason"], str) or not decision["reason"].strip():
            raise ValueError("review decisions need a nonblank reason")
        sources = decision["sources"]
        if not isinstance(sources, list) or not sources or any(
            not isinstance(source, str) or not Path(source).is_absolute() for source in sources
        ):
            raise ValueError("review sources must be nonempty absolute local paths")
        segments = decision["segments"]
        if not isinstance(segments, list) or not 1 <= len(segments) <= 200:
            raise ValueError("review decisions need between 1 and 200 segments")
        for segment in segments:
            if not isinstance(segment, dict) or set(segment) != set(REVIEW_FIELDS):
                raise ValueError("review segments must contain exactly the reviewed context fields")
            if not all(_positive_id(segment[field]) for field in ("id", "project_id")):
                raise ValueError("review segment and project ids must be positive integers")
            if segment["id"] in segment_ids:
                raise ValueError("review segment ids must be unique across the manifest")
            segment_ids.add(segment["id"])
            if not isinstance(segment["description"], str) or (
                segment["repo"] is not None and not isinstance(segment["repo"], str)
            ):
                raise ValueError("review description must be text and repo must be text or null")
            try:
                timestamp = datetime.fromisoformat(segment["begin"].replace("Z", "+00:00"))
                if timestamp.tzinfo is None:
                    raise ValueError
            except (AttributeError, TypeError, ValueError):
                raise ValueError("review begin must be an ISO timestamp with timezone") from None
        decisions[key] = decision
    return decisions


def check_review(decision, entries):
    """Require complete, unchanged, closed task context; return existing-intent state."""
    key = decision["user_id"], decision["task_id"]
    parts = sorted((entry for entry in entries if task_key(entry) == key), key=lambda part: part["id"])
    expected = sorted(decision["segments"], key=lambda part: part["id"])
    if not parts or any(any(field not in part for field in REVIEW_FIELDS) for part in parts):
        raise ValueError("reviewed task is missing complete segment context")
    if [{field: part[field] for field in REVIEW_FIELDS} for part in parts] != expected:
        raise ValueError("reviewed task segment membership or context changed")
    if any("purpose" not in part or "end" not in part for part in parts):
        raise ValueError("reviewed tasks require recorded purpose and lifecycle fields")
    if any(part["purpose"] is not None for part in parts):
        return False
    if any(not isinstance(part["end"], str) or not part["end"].strip() for part in parts):
        raise ValueError("reviewed task contains an active or unknown-lifecycle segment")
    return True


def _project_names(projects):
    if not isinstance(projects, list):
        raise ValueError("projects must be a list")
    names = {}
    for project in projects:
        if not isinstance(project, dict) or not _positive_id(project.get("id")):
            raise ValueError("each project needs a positive integer id")
        name = project.get("name")
        if not isinstance(name, str) or not name.strip() or project["id"] in names:
            raise ValueError("projects need nonblank names and unique ids")
        names[project["id"]] = name
    return names


def _approved_charters(charters):
    if charters is None:
        return {}
    if not isinstance(charters, dict) or set(charters) - {"projects", "repos"}:
        raise ValueError("charters must contain only projects and/or repos mappings")
    for mapping in charters.values():
        if not isinstance(mapping, dict):
            raise ValueError("each charter group must be a mapping")
        for name, purpose in mapping.items():
            if not isinstance(name, str) or not name.strip() or purpose not in PURPOSES:
                raise ValueError("charters need exact nonblank names and a supported purpose")
    return charters


def _classify(parts, charters):
    recorded = {part["purpose"] for part in parts if part["purpose"] is not None}
    if len(recorded) > 1:
        reasons = ["Recorded purposes conflict across task segments"]
        reasons.extend(f"Segment {part['id']} records purpose {part['purpose']!r}" for part in parts)
        return None, "needs-review", reasons, True
    if recorded:
        if any(part["purpose"] is None for part in parts):
            reasons = ["Recorded purpose is missing on some task segments"]
            reasons.extend(f"Segment {part['id']} records purpose {part['purpose']!r}" for part in parts)
            return None, "needs-review", reasons, False
        return recorded.pop(), "explicit", ["Every task segment records the same purpose"], False

    proposed, reasons, missing = set(), set(), []
    for part in parts:
        matched = False
        for group, name in (("projects", part["project"]), ("repos", part["repo"])):
            purpose = charters.get(group, {}).get(name)
            if purpose is not None:
                matched = True
                proposed.add(purpose)
                reasons.add(f"Approved {group} charter {name!r}: {purpose}")
        if not matched:
            missing.append(part["id"])
    reasons = sorted(reasons)
    if len(proposed) > 1:
        return None, "needs-review", reasons + ["Approved charters conflict within this task"], True
    if missing:
        reason = "No recorded purpose or approved charter covers segment IDs: " + ", ".join(map(str, missing))
        return None, "needs-review", reasons + [reason], False
    return proposed.pop(), "charter-derived", reasons, False


def build_preview(data, charters=None, projects=None, decisions=None):
    """Return one proposal per owner/logical task; never infer intent from titles."""
    entries = data.get("entries") if isinstance(data, dict) else data
    if not isinstance(entries, list):
        raise ValueError("input must be an entry list or a snapshot with an entries list")
    if projects is None:
        projects = data.get("projects", []) if isinstance(data, dict) else []
    names = _project_names(projects)
    charters = _approved_charters(charters)
    reviews = reviewed_decisions(decisions) if decisions is not None else {}
    groups, seen = {}, set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("each entry must be an object")
        entry_id, owner = entry.get("id"), entry.get("user_id")
        task_id, project_id = entry.get("task_id"), entry.get("project_id")
        if not _positive_id(entry_id) or not _positive_id(owner):
            raise ValueError("entries need positive integer id and user_id")
        if entry_id in seen:
            raise ValueError("entry ids must be unique; duplicate segments cannot be reconciled")
        seen.add(entry_id)
        if task_id is not None and not _positive_id(task_id):
            raise ValueError("task_id must be a positive integer or null")
        if project_id is not None and not _positive_id(project_id):
            raise ValueError("project_id must be a positive integer or null")
        purpose = entry.get("purpose")
        if purpose is not None and purpose not in PURPOSES:
            raise ValueError("purpose must be research, career, business, support, or null")
        project, repo, description = entry.get("project"), entry.get("repo"), entry.get("description")
        if any(value is not None and not isinstance(value, str) for value in (project, repo, description)):
            raise ValueError("project, repo, and description must be text or null")
        if project and project_id in names and names[project_id] != project:
            raise ValueError("entry project name conflicts with the project catalog")
        groups.setdefault((owner, task_id if task_id is not None else entry_id), []).append({
            "id": entry_id, "purpose": purpose, "project_id": project_id,
            "project": project or names.get(project_id), "repo": repo or None, "description": description,
        })

    eligible = {key: check_review(decision, entries) for key, decision in reviews.items()}

    tasks, conflicts = [], 0
    counts = dict.fromkeys((*PURPOSES, "unclassified"), 0)
    for (owner, task_id), parts in sorted(groups.items()):
        parts.sort(key=lambda part: part["id"])
        purpose, confidence, reasons, conflict = _classify(parts, charters)
        decision = reviews.get((owner, task_id))
        if decision is not None and eligible[(owner, task_id)]:
            purpose, confidence, reasons, conflict = decision["purpose"], "reviewed", [decision["reason"]], False
        conflicts += conflict
        counts[purpose or "unclassified"] += 1
        original_projects = {(part["project_id"], part["project"]) for part in parts}
        tasks.append({
            "user_id": owner, "task_id": task_id, "segment_ids": [part["id"] for part in parts],
            "original_projects": [{"id": id, "name": name} for id, name in sorted(
                original_projects, key=lambda pair: (pair[0] is None, pair[0] or 0, pair[1] or ""))],
            "repos": sorted({part["repo"] for part in parts}, key=lambda repo: (repo is not None, repo or "")),
            "descriptions": sorted({part["description"] for part in parts if part["description"] is not None}),
            "proposed_purpose": purpose, "confidence": confidence, "reasons": reasons,
            **({"sources": decision["sources"]} if decision is not None and confidence == "reviewed" else {}),
        })
    return {
        "summary": {
            "segments": len(entries), "tasks": len(tasks),
            "classified_tasks": len(tasks) - counts["unclassified"],
            "unclassified_tasks": counts["unclassified"], "conflicting_tasks": conflicts,
            "purpose_counts": counts,
        },
        "tasks": tasks,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path, help="Sanitized local snapshot or API entry-list JSON")
    parser.add_argument("--charters", type=Path, help="Explicitly approved project/repo purpose mappings in local JSON")
    parser.add_argument("--projects", type=Path, help="Optional local project catalog JSON for an API entry list")
    parser.add_argument("--decisions", type=Path, help="Task-specific reviewed decisions with exact segment context")
    args = parser.parse_args(argv)
    try:
        data = json.loads(args.snapshot.read_text(encoding="utf-8"))
        charters = json.loads(args.charters.read_text(encoding="utf-8")) if args.charters else None
        projects = json.loads(args.projects.read_text(encoding="utf-8")) if args.projects else None
        decisions = json.loads(args.decisions.read_text(encoding="utf-8")) if args.decisions else None
        result = build_preview(data, charters, projects, decisions)
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
