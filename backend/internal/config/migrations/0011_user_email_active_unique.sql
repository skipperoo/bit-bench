-- Emails are unique among *active* users and compared case-insensitively
-- (login already matches LOWER(email)). The old column constraint kept the
-- address of soft-deleted users reserved forever and allowed "A@x" next to
-- "a@x".
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM users WHERE deleted_at IS NULL
        GROUP BY LOWER(email) HAVING COUNT(*) > 1
    ) THEN
        RAISE WARNING 'users: case-insensitive duplicate active emails exist; unique index users_email_active_ci not created';
    ELSE
        CREATE UNIQUE INDEX IF NOT EXISTS users_email_active_ci ON users (LOWER(email)) WHERE deleted_at IS NULL;
    END IF;
END $$;
