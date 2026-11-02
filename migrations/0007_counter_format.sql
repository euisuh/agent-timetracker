ALTER TABLE timesheet_tokens ADD COLUMN counter_format TEXT
  CHECK (counter_format IN ('codex_response_exclusive_v1'));
