-- Run this in Supabase SQL Editor (https://supabase.com > SQL Editor)

CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  email TEXT,
  password TEXT NOT NULL,
  tokens INTEGER DEFAULT 0,
  "uploadsCount" INTEGER DEFAULT 0,
  admin BOOLEAN DEFAULT false,
  banned BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS unlocked_docs (
  username TEXT NOT NULL REFERENCES users(username),
  doc_id TEXT NOT NULL,
  PRIMARY KEY (username, doc_id)
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  score INTEGER DEFAULT 0,
  file_path TEXT,
  file_hash TEXT,
  filiere TEXT,
  niveau TEXT,
  matiere TEXT
);

CREATE TABLE IF NOT EXISTS comments (
  id SERIAL PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id),
  "user" TEXT NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bounties (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  title TEXT NOT NULL,
  "desc" TEXT NOT NULL,
  file_name TEXT DEFAULT 'Specs_Attached.pdf',
  author TEXT NOT NULL,
  settled BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS answers (
  id SERIAL PRIMARY KEY,
  bounty_id TEXT NOT NULL REFERENCES bounties(id),
  "user" TEXT NOT NULL,
  text TEXT NOT NULL,
  file_name TEXT DEFAULT 'Solution_Breakdown.pdf',
  winner BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS votes (
  doc_id TEXT NOT NULL REFERENCES documents(id),
  username TEXT NOT NULL REFERENCES users(username),
  direction TEXT NOT NULL CHECK (direction IN ('up', 'down')),
  PRIMARY KEY (doc_id, username)
);
