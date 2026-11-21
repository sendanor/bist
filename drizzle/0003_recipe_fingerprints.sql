ALTER TABLE revisions ADD COLUMN code_hash TEXT;
--> statement-breakpoint
ALTER TABLE revisions ADD COLUMN unit_hashes TEXT;
--> statement-breakpoint
CREATE INDEX revisions_code_hash ON revisions(code_hash) WHERE code_hash IS NOT NULL;
--> statement-breakpoint
CREATE INDEX revisions_unhashed ON revisions(id) WHERE code_hash IS NULL AND files IS NOT NULL;
