DROP INDEX revisions_unhashed;
--> statement-breakpoint
CREATE INDEX revisions_unhashed ON revisions(id) WHERE unit_hashes IS NULL AND files IS NOT NULL;
