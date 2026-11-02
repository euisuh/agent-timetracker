ALTER TABLE timesheets ADD COLUMN purpose TEXT CHECK (purpose IN ('research', 'career', 'business', 'support'));
