# Projects

These original project labels remain available for context and history. The
independent [intended purpose](docs/PURPOSES.md) field records what the assignment
is meant to advance. Do not use repository or project names alone to infer it.

What each project means, so an agent can classify a task without asking.

`GET /api/projects` is the source of truth for which projects **exist**. This
file is the source of truth for what they **mean**. If a project named here is
missing from the API, create it with `POST /api/projects` and continue.

Classify from the task the human actually assigned, not from the repo you
happen to be in — work on the timetracker itself is `etc`, not the project
whose data it holds.

Also choose the lifecycle `--kind` that describes the assigned work; use the
default only when no listed kind fits.

Changing this taxonomy — adding, renaming, or retiring a project — is the
curation agent's job: [`docs/CURATION_AGENT.md`](docs/CURATION_AGENT.md).

Every `##` heading that is a bare slug (lowercase letters, digits, hyphens) is
a project, and must match the seed list in `migrations/0005_project_meta.sql`
exactly — `migration seed slugs match PROJECTS.md` enforces it. Headings with
spaces or capitals, like the guidance section below, are prose.

## research

Research and study.

- **Belongs:** literature review, experiments, benchmarks, analysis, paper
  writing, coursework, research code and artifacts.
- **Doesn't:** engineering that serves no research question — that is `etc`.
- **Examples:** "run the ablation for the eval section", "draft related work",
  "reproduce the baseline numbers".

## work

Professional work and its supporting documentation.

- **Belongs:** employer or client tasks, portfolio and personal site, résumé
  upkeep, professional writing.
- **Doesn't:** research output — that is `research`.
- **Examples:** "update the portfolio page", "write the project summary".

## personal

Personal projects and finances.

- **Belongs:** side projects, personal bookkeeping and reporting, hobby tools.
- **Doesn't:** general infrastructure that merely happens to support them —
  judge by whose problem it solves.
- **Examples:** "fix the retry logic in the budget script", "reconcile the
  monthly spreadsheet".

## etc

Everything else. A real category, not a dumping ground for unclear tasks.

- **Belongs:** personal infrastructure and homelab, agent and tooling setup,
  dotfiles, deployments, this timetracker, one-off scripts, admin and errands.
- **Doesn't:** anything that fits one of the three above.
- **Examples:** "prune the codex rules file", "restart the gateways", "set up
  the code-server container".

## When it isn't clear

Ask. Do not guess, and do not default to `etc` to avoid asking.

Agents correct misfiled entries with `PATCH`; `DELETE /api/timesheets/{id}` is
available to an entry's owner or an admin. `DELETE /api/projects/{id}` refuses
projects with entries. One question costs less than a timesheet you stop trusting.
