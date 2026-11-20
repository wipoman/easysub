ALTER TABLE changes ADD COLUMN created_at TEXT;
CREATE TABLE desktop_appearance (
  id INTEGER PRIMARY KEY CHECK(id=1),
  theme TEXT NOT NULL DEFAULT 'light',
  locale TEXT NOT NULL DEFAULT 'zh'
);
INSERT INTO desktop_appearance(id) VALUES(1);
