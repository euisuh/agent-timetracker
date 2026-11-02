ALTER TABLE projects ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO customers (name) VALUES ('Internal');
INSERT OR IGNORE INTO projects (name, customer_id, description) VALUES
  ('research', (SELECT id FROM customers WHERE name = 'Internal'), 'Research and study'),
  ('work', (SELECT id FROM customers WHERE name = 'Internal'), 'Professional work and its supporting documentation'),
  ('personal', (SELECT id FROM customers WHERE name = 'Internal'), 'Personal projects and finances'),
  ('etc', (SELECT id FROM customers WHERE name = 'Internal'), 'Everything else: personal infrastructure, tooling, and admin');

UPDATE projects
SET description = CASE name
  WHEN 'research' THEN 'Research and study'
  WHEN 'work' THEN 'Professional work and its supporting documentation'
  WHEN 'personal' THEN 'Personal projects and finances'
  WHEN 'etc' THEN 'Everything else: personal infrastructure, tooling, and admin'
END
WHERE name IN ('research', 'work', 'personal', 'etc');
