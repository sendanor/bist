CREATE TABLE assistant_skill_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled TEXT NOT NULL CHECK (json_valid(enabled))
);
