-- Artefacts67 2.0: internal collaboration — a folder may be shared with a colleague.
-- Rides on 0001-0005 (already applied — do not rewrite them).
--
-- A grant is the ONLY way one member reaches another member's estate: the platform `admin`
-- role carries no estate access at all, and neither does anything else. Ownership is
-- untouched by a grant — the folder, its subfolders and every artefact in them keep
-- belonging to the owner, who alone may hand out or take back access.
--
-- Three roles, widening:
--   viewer   — read metadata, and preview content through the authenticated console route
--   editor   — publish, change metadata/password/aliases, create subfolders
--   manager  — additionally manage visitor shares and read their detail analytics
--
-- A grant is recorded on one folder and is inherited by every folder nested beneath it
-- (folders.parent_id, ADR 0025). Where two grants meet on one chain, the strongest wins.
-- The composite primary key is what makes a re-grant a role change rather than a second row.

CREATE TABLE folder_grants (
  folder_id   TEXT NOT NULL REFERENCES folders(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  role        TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'manager')),
  granted_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (folder_id, user_id)
);

-- "Everything shared with me" is the console tree's root query and the API's folder listing.
CREATE INDEX idx_folder_grants_user ON folder_grants(user_id);
