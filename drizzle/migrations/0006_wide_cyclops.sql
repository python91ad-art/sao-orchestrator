-- Add ownership column to deployments
ALTER TABLE deployments ADD COLUMN user_id varchar(255) NULL;

-- Add index for ownership lookups
CREATE INDEX idx_deployments_user ON deployments(user_id);

-- Assign existing deployments to the admin user (only user in system)
-- Use a subquery to fetch the admin user ID safely
UPDATE deployments SET user_id = (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1) WHERE user_id IS NULL;
