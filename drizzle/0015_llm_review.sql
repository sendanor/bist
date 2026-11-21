ALTER TABLE openai_settings ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE revisions ADD COLUMN llm_warnings TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
CREATE TABLE llm_review_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  policy TEXT NOT NULL CHECK (json_valid(policy))
);
--> statement-breakpoint
CREATE TABLE llm_review_receipts (
  digest TEXT PRIMARY KEY,
  receipt TEXT NOT NULL,
  expires INTEGER NOT NULL,
  warnings TEXT NOT NULL CHECK (json_valid(warnings))
);
--> statement-breakpoint
CREATE INDEX llm_review_receipts_expiry ON llm_review_receipts(expires);
