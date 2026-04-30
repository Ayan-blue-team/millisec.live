CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(50)  NOT NULL UNIQUE,
    email         VARCHAR(100) UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role          VARCHAR(20)  NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user','staff')),
    mfa_secret    VARCHAR(100),
    mfa_enabled   BOOLEAN      NOT NULL DEFAULT false,
    last_login    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS login_logs (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER REFERENCES users(id),
    ip_address VARCHAR(45),
    event      VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- Default users (şifrə: Admin123! və User123!)
INSERT INTO users (username, email, password_hash, role, mfa_secret, mfa_enabled)
VALUES
  ('admin', 'admin@millisec.live', '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMUFD1Rm8quRNrwwGFDXWBJ3K2', 'admin', 'JBSWY3DPEHPK3PXP', false),
  ('john',  'john@millisec.live',  '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMUFD1Rm8quRNrwwGFDXWBJ3K2', 'user',  'JBSWY3DPEHPK3PXP', false),
  ('sarah', 'sarah@millisec.live', '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMUFD1Rm8quRNrwwGFDXWBJ3K2', 'staff', 'JBSWY3DPEHPK3PXP', false)
ON CONFLICT (username) DO NOTHING;
