ALTER TABLE timesheets ADD COLUMN task_id INTEGER;
ALTER TABLE timesheets ADD COLUMN end_reason TEXT CHECK (end_reason IN ('done', 'paused', 'auto'));

UPDATE timesheets
SET task_id = (
  SELECT MIN(other.id)
  FROM timesheets AS other
  WHERE other.user_id = timesheets.user_id
    AND other.project_id = timesheets.project_id
    AND other.description = timesheets.description
);

UPDATE timesheets
SET end_reason = CASE
  WHEN auto_closed = 1 THEN 'auto'
  WHEN end IS NOT NULL THEN 'done'
END;

CREATE INDEX timesheets_task_id ON timesheets(task_id);
