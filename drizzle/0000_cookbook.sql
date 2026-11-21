CREATE TABLE recipes (
  slug TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  live TEXT
);
--> statement-breakpoint
CREATE TABLE revisions (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL REFERENCES recipes(slug),
  author TEXT NOT NULL,
  base TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT NOT NULL,
  files TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_by TEXT,
  review_note TEXT,
  published_at TEXT,
  removal_reason TEXT,
  removal_by TEXT
);
--> statement-breakpoint
CREATE INDEX revisions_queue ON revisions(state, created);
--> statement-breakpoint
CREATE INDEX revisions_slug ON revisions(slug, created);
