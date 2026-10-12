-- 0005: subfolders (ADR 0025). folders.parent_id nests a folder inside another of the same
-- owner's folders — a display hierarchy for the console tree only. Every public path stays
-- flat (/<slug>/), so nesting and moving never change a handed-out link.

ALTER TABLE folders ADD COLUMN parent_id TEXT REFERENCES folders(id);
CREATE INDEX idx_folders_parent ON folders(parent_id);
