CREATE TABLE revision_line_comments (
  id INTEGER PRIMARY KEY,
  revision TEXT NOT NULL REFERENCES revisions(id),
  edit_version INTEGER NOT NULL,
  part TEXT NOT NULL,
  line INTEGER NOT NULL,
  excerpt TEXT NOT NULL,
  body TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX revision_line_comments_revision ON revision_line_comments(revision, edit_version, part, line);
--> statement-breakpoint
CREATE TRIGGER revision_line_comments_remove
AFTER UPDATE OF state ON revisions
WHEN NEW.state = 'removed' AND OLD.state != 'removed'
BEGIN
  DELETE FROM revision_line_comments WHERE revision = NEW.id;
END;
