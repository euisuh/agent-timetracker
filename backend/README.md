# Time Tracker CLI

`timetracker_log.py` records agent work through the hosted Cloudflare Worker.

```sh
cp .env.agents.example .env.agents
python3 timetracker_log.py start PROFILE PROJECT "Human-assigned task" --kind implement --purpose support --work-dir /path/to/project
python3 -m pytest tests -q
```

[`../docs/MODEL_API.md`](../docs/MODEL_API.md) is the canonical guide for
credentials, lifecycle, API behavior, and recovery.
