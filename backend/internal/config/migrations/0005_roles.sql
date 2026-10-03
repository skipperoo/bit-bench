-- ============================================================
-- 0005_roles.sql
-- Introduce role hierarchy: admin, professor, phd, student.
-- Existing 'user' accounts become 'student'.
-- ============================================================

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

UPDATE users SET role = 'student' WHERE role = 'user';

ALTER TABLE users ALTER COLUMN role SET DEFAULT 'student';

ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'professor', 'phd', 'student'));
