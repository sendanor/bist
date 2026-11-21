CREATE TABLE revision_comments (
  id INTEGER PRIMARY KEY,
  revision TEXT NOT NULL REFERENCES revisions(id),
  edit_version INTEGER NOT NULL,
  part TEXT NOT NULL,
  line INTEGER,
  excerpt TEXT,
  body TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (line IS NULL AND excerpt IS NULL) OR
    (line IS NOT NULL AND line >= 1 AND excerpt IS NOT NULL)
  )
);
--> statement-breakpoint
INSERT INTO revision_comments (id, revision, edit_version, part, line, excerpt, body, reviewer, created)
SELECT id, revision, edit_version, part, line, excerpt, body, reviewer, created
FROM revision_line_comments;
--> statement-breakpoint
DROP TRIGGER revision_line_comments_remove;
--> statement-breakpoint
DROP TABLE revision_line_comments;
--> statement-breakpoint
CREATE INDEX revision_comments_revision ON revision_comments(revision, edit_version, part, line);
--> statement-breakpoint
CREATE TRIGGER revision_comments_remove
AFTER UPDATE OF state ON revisions
WHEN NEW.state = 'removed' AND OLD.state != 'removed'
BEGIN
  DELETE FROM revision_comments WHERE revision = NEW.id;
END;
