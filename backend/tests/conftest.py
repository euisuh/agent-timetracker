import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture(autouse=True)
def isolated_native_receipt_root(monkeypatch, tmp_path_factory):
    import timetracker_log

    monkeypatch.setattr(
        timetracker_log, "_NATIVE_RECEIPT_ROOT",
        tmp_path_factory.mktemp("no-receipts") / "absent",
    )
