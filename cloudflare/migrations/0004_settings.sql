CREATE TABLE profile(id INTEGER PRIMARY KEY CHECK(id=1), username TEXT, email TEXT DEFAULT '', password TEXT, epoch TEXT DEFAULT '', otp TEXT, pending TEXT, calendar TEXT, channels TEXT, rates TEXT, rate_time TEXT);
INSERT INTO profile(id) VALUES(1);
CREATE TABLE api_keys(id INTEGER PRIMARY KEY, name TEXT NOT NULL, digest TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT);
ALTER TABLE deliveries ADD COLUMN attempted_at TEXT;
ALTER TABLE deliveries ADD COLUMN error TEXT;
