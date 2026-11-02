"""Apply reviewed historical purposes with guarded API writes; default is offline dry-run."""

import argparse
import http.client
import json
import os
import sys
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

import timetracker_log
from scripts.purpose_preview import build_preview, check_review, reviewed_decisions, task_key


API_ORIGIN = os.environ.get("TIMETRACKER_API_ORIGIN", "https://time-api.example.com")


class ApiError(Exception):
    def __init__(self, status=None):
        self.status = status
        super().__init__(f"API request failed ({status})" if status else "API request failed")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def api_request(method, path, profile, body=None):
    try:
        base, username, token = timetracker_log._credentials(profile)
        if base != API_ORIGIN or not (method == "GET" and path in {"/api/timesheets", "/api/capabilities"}) and not (
            method == "PATCH" and path.startswith("/api/timesheets/")
            and path.removeprefix("/api/timesheets/").isdigit()
        ):
            raise ApiError()
        headers = {"X-AUTH-USER": username, "X-AUTH-TOKEN": token,
                   "Content-Type": "application/json",
                   "User-Agent": "Mozilla/5.0 (compatible; TimeTracker-Review/1.0)",
                   **timetracker_log._access_headers()}
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(base + path, data=data, headers=headers, method=method)
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=20) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        raise ApiError(error.code) from None
    except (OSError, ValueError, http.client.HTTPException):
        # Never echo credential configuration, URLs, response bodies or transport errors.
        raise ApiError() from None


def owner_profiles(data):
    if not isinstance(data, dict):
        raise ValueError("profiles must map owner IDs to existing local profile aliases")
    profiles = {}
    for owner, profile in data.items():
        if not isinstance(owner, str) or not owner.isascii() or not owner.isdecimal() or int(owner) < 1:
            raise ValueError("profile owner IDs must be positive decimal strings")
        if str(int(owner)) != owner or not isinstance(profile, str) or not profile.strip():
            raise ValueError("profiles need canonical owner IDs and nonblank aliases")
        profiles[int(owner)] = profile
    return profiles


def _task_rows(rows, decision):
    key = decision["user_id"], decision["task_id"]
    return sorted((row for row in rows if task_key(row) == key), key=lambda row: row["id"])


def _without_purpose(rows):
    return [{key: value for key, value in row.items() if key != "purpose"} for row in rows]


def apply_reviews(snapshot, manifest, profiles, *, apply=False, request=api_request, emit=None):
    """Return receipts; only explicit apply makes requests, always with purpose_review."""
    build_preview(snapshot, decisions=manifest)
    decisions = list(reviewed_decisions(manifest).values())
    profiles = owner_profiles(profiles)
    if apply and emit is None:
        raise ValueError("apply requires a private ledger writer")
    emit = emit or (lambda event: None)
    ledger_failed = False

    def record(event):
        nonlocal ledger_failed
        try:
            emit(event)
            return True
        except OSError:
            ledger_failed = True
            return False

    entries = snapshot["entries"] if isinstance(snapshot, dict) else snapshot
    results = []
    pending = {}
    for decision in decisions:
        result = {"user_id": decision["user_id"], "task_id": decision["task_id"], "status": "dry-run"}
        results.append(result)
        if not check_review(decision, entries):
            result["status"] = "already-classified"
        elif decision["user_id"] not in profiles:
            result["status"] = "missing-profile"
        elif apply:
            result["status"] = "pending"
            pending.setdefault(decision["user_id"], []).append((decision, result))
    stopped = not record({"event": "start", "mode": "apply" if apply else "dry-run", "tasks": len(results)})
    # Recheck preservation after small batches instead of writing all history first.
    batches = [(owner, rows[index:index + 20]) for owner, rows in pending.items()
               for index in range(0, len(rows), 20)]
    checked_profiles = set()
    for owner, batch in batches:
        if stopped:
            break
        profile = profiles[owner]
        if profile not in checked_profiles:
            try:
                capabilities = request("GET", "/api/capabilities", profile)
                feature = capabilities.get("purpose_review") if isinstance(capabilities, dict) else None
                if not isinstance(feature, dict) or set(feature) != {"version", "closed_only"} or not (
                    type(feature["version"]) is int and feature["version"] == 1 and feature["closed_only"] is True
                ):
                    raise ValueError("required purpose review capability is unavailable")
            except (ApiError, ValueError):
                for _, result in batch:
                    result["status"] = "server-capability-failed"
                record({"event": "server-capability-failed", "user_id": owner})
                stopped = True
                continue
            checked_profiles.add(profile)
        try:
            before = request("GET", "/api/timesheets", profile)
            build_preview(before)
            if not before or any(row["user_id"] != owner for row in before):
                raise ValueError("profile does not exclusively list the reviewed owner")
        except (ApiError, ValueError):
            for _, result in batch:
                result["status"] = "owner-preflight-failed"
            record({"event": "owner-preflight-failed", "user_id": owner})
            stopped = True
            continue
        attempted = []
        for decision, result in batch:
            try:
                eligible = check_review(decision, before)
            except ValueError:
                result["status"] = "stale"
                continue
            if not eligible:
                result["status"] = "already-classified"
                continue
            original = _task_rows(before, decision)
            if not record({"event": "before", "decision": decision, "entries": original}):
                stopped = True
                break
            payload = {"purpose": decision["purpose"],
                       "purpose_review": {"segments": decision["segments"], "closed_only": True}}
            try:
                request("PATCH", f"/api/timesheets/{original[0]['id']}", profile, payload)
                result["status"] = "submitted"
                attempted.append((decision, result, original))
            except ApiError as error:
                result["status"] = "conflict" if error.status == 409 else "unverified"
                if error.status != 409:
                    attempted.append((decision, result, original))
                    stopped = True
            if not record({"event": "request-result", **result}):
                stopped = True
            if stopped:
                break
        if not attempted:
            continue
        try:
            after = request("GET", "/api/timesheets", profile)
            build_preview(after)
            if any(row["user_id"] != owner for row in after):
                raise ValueError("after-read owner mismatch")
        except (ApiError, ValueError):
            for _, result, _ in attempted:
                result["status"] = "unverified"
            record({"event": "verification-read-failed", "user_id": owner})
            stopped = True
            continue
        for decision, result, original in attempted:
            current = _task_rows(after, decision)
            preserved = _without_purpose(current) == _without_purpose(original)
            classified = bool(current) and all(row.get("purpose") == decision["purpose"] for row in current)
            result["status"] = "verified" if preserved and classified else "verification-failed"
            if not record({"event": "after", **result, "entries": current, "nonpurpose_fields_preserved": preserved}):
                stopped = True
            stopped = stopped or result["status"] != "verified"
    for result in results:
        if result["status"] == "pending":
            result["status"] = "not-attempted"
    report = {"mode": "apply" if apply else "dry-run", "counts": dict(Counter(r["status"] for r in results)),
              "tasks": results}
    if ledger_failed:
        report["ledger_error"] = True
    record({"event": "complete", **report})
    if ledger_failed:
        report["ledger_error"] = True
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("--decisions", type=Path, required=True)
    parser.add_argument("--profiles", type=Path, required=True, help='Local owner mapping, e.g. {"2":"claude"}')
    parser.add_argument("--apply", action="store_true", help="Send guarded purpose-only PATCH requests")
    parser.add_argument("--ledger", type=Path, help="New private JSONL receipt path; required for apply")
    args = parser.parse_args(argv)
    if args.apply and args.ledger is None:
        parser.error("--apply requires --ledger")
    ledger = None
    status = 1
    try:
        snapshot = json.loads(args.snapshot.read_text())
        decisions = json.loads(args.decisions.read_text())
        profiles = json.loads(args.profiles.read_text())
        # Validate all local inputs before creating a ledger or loading any credentials.
        build_preview(snapshot, decisions=decisions)
        owner_profiles(profiles)
        if args.ledger is not None:
            ledger = os.fdopen(os.open(args.ledger, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w")

        def emit(event):
            if ledger is not None:
                ledger.write(json.dumps(event, ensure_ascii=False) + "\n")
                ledger.flush()
                os.fsync(ledger.fileno())

        report = apply_reviews(snapshot, decisions, profiles, apply=args.apply, emit=emit)
        print(json.dumps(report, indent=2))
        status = int(report.get("ledger_error", False) or any(
            status not in {"dry-run", "verified", "already-classified"} for status in report["counts"]))
    except (OSError, ValueError, ApiError):
        print("error: invalid local review inputs, unavailable ledger, or failed API request", file=sys.stderr)
    finally:
        if ledger is not None:
            try:
                ledger.close()
            except OSError:
                print("error: private receipt ledger could not be closed", file=sys.stderr)
                status = 1
    return status


if __name__ == "__main__":
    raise SystemExit(main())
