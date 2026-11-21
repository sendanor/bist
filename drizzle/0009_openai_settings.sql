CREATE TABLE openai_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  model TEXT NOT NULL,
  credential TEXT
);
--> statement-breakpoint
CREATE TABLE openai_rate_limits (
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  window INTEGER NOT NULL,
  hits INTEGER NOT NULL,
  PRIMARY KEY (actor, action)
);
