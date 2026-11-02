# Time logging for coding models

> **INTERNAL/LOCAL USE ONLY.** Do not expose the service publicly or commit real tokens.

Canonical setup, API, role, endpoint, and recovery documentation lives in
[`../docs/MODEL_API.md`](../docs/MODEL_API.md). Read it before calling the tracker.

Use [`../docs/MODEL_API.md`](../docs/MODEL_API.md) for lifecycle, profiles,
projects, purposes, kinds, repo capture, token detection, and stale-entry behavior.

For each new assignment, choose `--purpose research|career|business|support`
when its intended benefit is known; omit it when unknown. Read
[`../docs/PURPOSES.md`](../docs/PURPOSES.md). Resume by entry ID inherits purpose
without an override, and one assigned task still maps to one logical task.
