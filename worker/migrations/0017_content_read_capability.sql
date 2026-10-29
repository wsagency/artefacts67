ALTER TABLE api_keys ADD COLUMN can_read_content INTEGER NOT NULL DEFAULT 0 CHECK (can_read_content IN (0,1));
