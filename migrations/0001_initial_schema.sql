CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE activities (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  token_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id)
);

CREATE TABLE recommended_tasks (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  description TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE timesheets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  activity_id INTEGER NOT NULL REFERENCES activities(id),
  description TEXT NOT NULL,
  begin TEXT NOT NULL,
  end TEXT,
  tokens_input INTEGER,
  tokens_output INTEGER,
  tokens_reasoning INTEGER,
  tokens_cache_read INTEGER,
  tokens_cache_write INTEGER,
  auto_closed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE timesheet_tokens (
  timesheet_id INTEGER NOT NULL REFERENCES timesheets(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  reasoning INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (timesheet_id, user_id)
);

CREATE INDEX timesheets_user_id ON timesheets(user_id);
CREATE INDEX timesheets_project_id ON timesheets(project_id);
CREATE INDEX timesheets_begin ON timesheets(begin);
CREATE INDEX recommended_tasks_project_id ON recommended_tasks(project_id);
