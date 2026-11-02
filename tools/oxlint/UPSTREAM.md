# Anti-slop rule provenance

The 38 files under `anti-slop/` are copied byte-for-byte from
[dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), the upstream source
(146,353 content bytes). They were first imported through another of the author's
projects; that intermediate repository is private and not referenced here.
No rule files or their embedded third-party notices have been modified here.

`ANTI-SLOP-LICENSE` retains upstream's MIT notice for Dillon Mulroy, retrieved
from its GitHub license endpoint on 2026-10-14; Git blob
`69239ead1ed4a05db45c0da08d1b8f64c0a76ee4`.
The nested ESLint Stylistic files retain their own `LICENSE` and `UPSTREAM.md`,
including the upstream revision and local adaptations supplied by anti-slop.

The configuration enables the general rules. As upstream does,
`require-readable-spacing` is off to avoid a formatting migration; the Effect
plugin is not enabled because this repository does not use Effect. These are
configuration choices, not changes to the vendored implementations.

`changed.mjs` and its tests are specific to timetracker. The source repository's
runner was not copied: it silently fell back to HEAD when history was missing.
This runner requires a resolvable common ancestor and invokes the installed
pinned binary. For updates, compare against an explicit source commit, retain
both license notices, rerun `npm run test:quality`, and do not edit the vendored
rules to make project code pass.
