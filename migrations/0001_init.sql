CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  created_at INTEGER NOT NULL,
  last_seen INTEGER
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- exam 1..6 = part exams, 7 = final exam
CREATE TABLE attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exam INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','submitted','expired')),
  started_at INTEGER NOT NULL,
  submitted_at INTEGER,
  correct INTEGER,
  total INTEGER,
  pct INTEGER,
  passed INTEGER NOT NULL DEFAULT 0,
  answers TEXT
);
CREATE INDEX idx_attempts_user ON attempts(user_id, exam, status);

CREATE TABLE attempt_answers (
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  qid INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, qid)
);
CREATE INDEX idx_attempt_answers_q ON attempt_answers(qid);

-- admin override: lets a user open an exam/part without passing the previous one
CREATE TABLE unlocks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exam INTEGER NOT NULL,
  granted_by INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, exam)
);

CREATE TABLE throttle (
  key TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX idx_throttle ON throttle(key, ts);
