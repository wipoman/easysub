CREATE TABLE installation(epoch TEXT PRIMARY KEY);
INSERT INTO installation VALUES (lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))));
CREATE TABLE changes(
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, kind TEXT NOT NULL,
 version INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, readonly INTEGER NOT NULL DEFAULT 0,
 data TEXT NOT NULL, device TEXT, op TEXT, UNIQUE(id,version), UNIQUE(device,op)
);
CREATE VIEW current_records AS SELECT c.* FROM changes c
 WHERE NOT EXISTS (SELECT 1 FROM changes newer WHERE newer.id=c.id AND newer.version>c.version);
CREATE TABLE receipts(device TEXT NOT NULL, op TEXT NOT NULL, digest TEXT NOT NULL,
 status TEXT NOT NULL, seq INTEGER REFERENCES changes(seq), PRIMARY KEY(device,op));
CREATE TABLE images(id TEXT NOT NULL, part INTEGER NOT NULL, mime TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(id,part));
CREATE TABLE deliveries(day TEXT, channel TEXT, state TEXT NOT NULL, lease INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(day,channel));
