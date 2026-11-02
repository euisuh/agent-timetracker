# Intended purpose

Purpose answers **what this assignment is intended to advance**. It is independent
of the original project label, repository, action kind, and agent performing it.
One human assignment has one primary purpose; resumed segments inherit it.

| Value | Display label | Intended benefit |
|---|---|---|
| `research` | Research | Research ability, evidence, or entry into a research path |
| `career` | Developer & career | Engineering capability, professional credibility, or employment options |
| `business` | Business & assets | A product/business, earning money, or protecting assets |
| `support` | Support & life | Shared operations or personal needs without a direct primary aim above |
| omitted / `null` | Unclassified | The assignment's primary intent is not recorded |

Classify the requested benefit, not the technique or repository name. A research
harness can be `research` + `implement`; pricing investigation can be `business`
+ `research`; an OSS contribution requested for professional credibility can be
`career` + `implement`. Coding alone does not establish career intent. Shared
queue/backups/timetracker maintenance is normally `support`; a narrowly scoped
repair requested to unblock a research experiment can instead be `research`.

Support is a real purpose; Unclassified means unknown. Do not guess a product's
purpose from its name or move every `etc` task to career. When a product's main
purpose is known, record its charter in the product's existing documentation.
An explicit assignment can differ from that default. Mixed or missing historical
intent stays Unclassified until reviewed.

The existing project taxonomy in [PROJECTS.md](../PROJECTS.md) and original
product labels remain intact. Purpose is the primary intended-benefit view;
project and repository remain available for context and historical comparisons.
The API does not infer purpose from these fields. New callers should send purpose
when known; omission remains compatible and records Unclassified.

```sh
python3 backend/timetracker_log.py start codex research "Build experiment harness" --kind implement --purpose research --work-dir /path/to/research-repo
python3 backend/timetracker_log.py resume codex ENTRY_ID
```

Resume by entry ID inherits purpose and does not accept an override. The legacy
project/description form starts a new Unclassified task if no paused match exists;
prefer entry-ID resume. Correct purpose in task
details or with a purpose-only API PATCH. The correction applies to all segments
of the same owned logical task, including paused and resumed segments, without
changing their times, lifecycle, or counters. Setting `null` explicitly clears it.

Purpose records intended investment, not proven personal growth or income.
Logged agent elapsed time, task completion and model-reported counters are activity
measures. See [WEEKLY_REVIEW.md](WEEKLY_REVIEW.md) for reviewing actual evidence,
and [PURPOSE_PREVIEW.md](PURPOSE_PREVIEW.md) for conservative historical previews.
