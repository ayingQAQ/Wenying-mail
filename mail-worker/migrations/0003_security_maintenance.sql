CREATE INDEX idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX idx_sessions_revoked ON sessions(revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX idx_auth_attempts_window ON auth_attempts(window_start);
