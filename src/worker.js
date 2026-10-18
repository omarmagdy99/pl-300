import { QUESTIONS } from './questions.js';
import { CONTENT } from './content.js';
import { SECTIONS, PARTS, EXAMS, finalId, sectionOfPart } from './course.js';
import { verifyGoogleIdToken, TokenError } from './google.js';

/* ------------------------------------------------------------------ */
/* constants                                                           */
/* ------------------------------------------------------------------ */
const PASS_PCT = 70;
const FINAL_SECONDS = 45 * 60; // time limit of a section final exam
const FINAL_GRACE = 60;
const SESSION_SECONDS = 30 * 24 * 3600;
const PBKDF2_ITERATIONS = 100000; // Workers' maximum
const LOGIN_MAX_FAILS = 8;
const LOGIN_WINDOW = 15 * 60;
const REGISTER_MAX = 10;
const REGISTER_WINDOW = 3600;

const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations: PBKDF2_ITERATIONS }, key, 256);
  return hex(bits);
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function getCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}

function sessionCookie(url, token, maxAge) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

async function readBody(request) {
  const len = +(request.headers.get('Content-Length') || 0);
  if (len > 200000) throw new HttpError(413, 'Request too large.');
  try { const b = await request.json(); return b && typeof b === 'object' ? b : {}; }
  catch { throw bad('Invalid JSON body.'); }
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

async function throttleCount(env, key, windowSec) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM throttle WHERE key = ?1 AND ts > ?2')
    .bind(key, now() - windowSec).first();
  return r ? r.n : 0;
}
const throttleHit = (env, key) =>
  env.DB.prepare('INSERT INTO throttle(key, ts) VALUES (?1, ?2)').bind(key, now()).run();

/* ------------------------------------------------------------------ */
/* questions: client view, grading                                     */
/* ------------------------------------------------------------------ */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffledOrder(q, attemptId) {
  const rnd = mulberry32(attemptId * 7919 + q.id);
  const idx = q.items.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  if (idx.every((v, i) => v === i)) idx.reverse();
  return idx.map((k) => ({ k, t: q.items[k] }));
}

// What the browser may see BEFORE submitting: no answers, no explanations.
function clientQuestion(q, attemptId) {
  const base = { id: q.id, part: q.part, type: q.type, text: q.text, ins: q.ins || null };
  switch (q.type) {
    case 'single': return { ...base, opts: q.opts };
    case 'multi': return { ...base, opts: q.opts, pick: q.ans.length };
    case 'yesno': return { ...base, st: q.st };
    case 'dropdown': return { ...base, tpl: q.tpl, dd: q.dd.map((d) => ({ opts: d.opts })) };
    case 'order': return { ...base, order: shuffledOrder(q, attemptId) };
  }
}

function isInt(v) { return Number.isInteger(v); }

function grade(q, a) {
  if (a === undefined || a === null) return false;
  switch (q.type) {
    case 'single':
      return isInt(a) && a === q.ans;
    case 'multi':
      return Array.isArray(a) && a.length === q.ans.length && a.every(isInt) &&
        new Set(a).size === a.length && [...a].sort().join() === [...q.ans].sort().join();
    case 'yesno':
      return Array.isArray(a) && a.length === q.st.length && q.ans.every((v, i) => a[i] === v);
    case 'dropdown':
      return Array.isArray(a) && a.length === q.dd.length && q.dd.every((d, i) => a[i] === d.ans);
    case 'order':
      return Array.isArray(a) && a.length === q.items.length && a.every((v, i) => v === i);
  }
  return false;
}

const EXAM_BY_ID = new Map(EXAMS.map((e) => [e.id, e]));
const isFinal = (id) => !!EXAM_BY_ID.get(id) && EXAM_BY_ID.get(id).kind === 'final';
function deckFor(id) {
  const e = EXAM_BY_ID.get(id);
  if (!e) return [];
  return e.kind === 'final'
    ? QUESTIONS.filter((q) => sectionOfPart(q.part) === e.section)
    : QUESTIONS.filter((q) => q.part === id);
}

/* ------------------------------------------------------------------ */
/* auth                                                                */
/* ------------------------------------------------------------------ */
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

async function currentUser(env, request) {
  const token = getCookie(request, 'sid');
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.role, u.last_seen FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?1 AND s.expires_at > ?2`)
    .bind(await sha256(token), now()).first();
  if (!row) return null;
  if (!row.last_seen || now() - row.last_seen > 600) {
    await env.DB.prepare('UPDATE users SET last_seen = ?1 WHERE id = ?2').bind(now(), row.id).run();
  }
  return row;
}

async function createSession(env, url, userId) {
  const token = randHex(32);
  await env.DB.prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)')
    .bind(await sha256(token), userId, now() + SESSION_SECONDS).run();
  return sessionCookie(url, token, SESSION_SECONDS);
}

function adminEmails(env) {
  return (env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cleanCreds(body, { needName }) {
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const name = String(body.name || '').trim().replace(/\s+/g, ' ');
  if (!EMAIL_RE.test(email) || email.length > 120) throw bad('Enter a valid email address.');
  if (needName && (name.length < 2 || name.length > 80)) throw bad('Name must be 2 to 80 characters.');
  if (password.length < 8 || password.length > 200) throw bad('Password must be at least 8 characters.');
  return { email, password, name };
}

async function register({ env, request, url }) {
  const ip = clientIp(request);
  if ((await throttleCount(env, 'reg:' + ip, REGISTER_WINDOW)) >= REGISTER_MAX)
    throw new HttpError(429, 'Too many sign-ups from your network. Try again later.');
  const { email, password, name } = cleanCreds(await readBody(request), { needName: true });
  // An unverified password sign-up must not be able to claim an admin email.
  if (env.GOOGLE_CLIENT_ID && adminEmails(env).includes(email))
    throw new HttpError(403, 'This email must sign in with Google.');
  const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?1').bind(email).first();
  if (exists) throw new HttpError(409, 'An account with this email already exists.');
  await throttleHit(env, 'reg:' + ip);
  const salt = randHex(16);
  const role = adminEmails(env).includes(email) ? 'admin' : 'user';
  const row = await env.DB.prepare(
    `INSERT INTO users(email, name, pw_hash, pw_salt, role, created_at, last_seen)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) RETURNING id, name, email, role`)
    .bind(email, name, await hashPassword(password, salt), salt, role, now()).first();
  await env.DB.prepare('DELETE FROM throttle WHERE ts < ?1').bind(now() - 86400).run();
  return json({ user: publicUser(row) }, 201, { 'Set-Cookie': await createSession(env, url, row.id) });
}

async function login({ env, request, url }) {
  const { email, password } = cleanCreds(await readBody(request), { needName: false });
  const keyEmail = 'login:' + email, keyIp = 'loginip:' + clientIp(request);
  if ((await throttleCount(env, keyEmail, LOGIN_WINDOW)) >= LOGIN_MAX_FAILS ||
      (await throttleCount(env, keyIp, LOGIN_WINDOW)) >= LOGIN_MAX_FAILS * 3)
    throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
  const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?1').bind(email).first();
  const computed = await hashPassword(password, u ? u.pw_salt : '00'.repeat(16)); // same cost either way
  if (!u || !safeEqual(computed, u.pw_hash)) {
    await throttleHit(env, keyEmail); await throttleHit(env, keyIp);
    throw new HttpError(401, 'Incorrect email or password.');
  }
  await env.DB.prepare('DELETE FROM throttle WHERE key = ?1').bind(keyEmail).run();
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now()).run();
  return json({ user: publicUser(u) }, 200, { 'Set-Cookie': await createSession(env, url, u.id) });
}

async function jwks(force) {
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs',
    force ? { cf: { cacheTtl: 0 } } : { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!r.ok) throw new Error('Could not load Google signing keys');
  return r.json();
}

async function googleLogin({ env, request, url }) {
  if (!env.GOOGLE_CLIENT_ID) throw new HttpError(404, 'Google sign-in is not configured.');
  const keyIp = 'googleip:' + clientIp(request);
  if ((await throttleCount(env, keyIp, LOGIN_WINDOW)) >= LOGIN_MAX_FAILS * 3)
    throw new HttpError(429, 'Too many failed attempts. Try again later.');
  const { credential } = await readBody(request);
  let g;
  try {
    g = await verifyGoogleIdToken(credential, env.GOOGLE_CLIENT_ID, jwks, now());
  } catch (e) {
    if (e instanceof TokenError) { await throttleHit(env, keyIp); throw new HttpError(401, 'Google sign-in failed. Please try again.'); }
    throw e;
  }
  let u = await env.DB.prepare('SELECT * FROM users WHERE email = ?1').bind(g.email).first();
  if (!u) {
    // Google proved ownership of the email; the random password can never be guessed
    // (an admin can set a real one later if the person wants password login too).
    const salt = randHex(16);
    const role = adminEmails(env).includes(g.email) ? 'admin' : 'user';
    const name = g.name.trim().replace(/\s+/g, ' ').slice(0, 80) || g.email.split('@')[0];
    u = await env.DB.prepare(
      `INSERT INTO users(email, name, pw_hash, pw_salt, role, created_at, last_seen)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) RETURNING id, name, email, role`)
      .bind(g.email, name, randHex(32), salt, role, now()).first();
  } else if (u.role !== 'admin' && adminEmails(env).includes(g.email)) {
    await env.DB.prepare(`UPDATE users SET role = 'admin' WHERE id = ?1`).bind(u.id).run();
    u.role = 'admin';
  }
  return json({ user: publicUser(u) }, 200, { 'Set-Cookie': await createSession(env, url, u.id) });
}

async function logout({ env, request, url }) {
  const token = getCookie(request, 'sid');
  if (token && /^[0-9a-f]{64}$/.test(token))
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256(token)).run();
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(url, '', 0) });
}

/* ------------------------------------------------------------------ */
/* progress & gating                                                   */
/* ------------------------------------------------------------------ */
function lockMessage(e) {
  if (e.kind === 'final') return 'Pass all six part exams of this section to unlock its final exam.';
  if (e.local === 1) return `Pass the final exam of Section ${e.section - 1} (${PASS_PCT}%) to unlock this section.`;
  return `Pass the Part ${e.section}.${e.local - 1} exam (${PASS_PCT}%) to unlock this part.`;
}

// Gating rule: a part needs the previous part to be passed; the first part of a later
// section needs the previous section's final exam; a final needs all parts of its section.
function earnedUnlock(e, passed) {
  if (e.kind === 'final') return PARTS.filter((p) => p.section === e.section).every((p) => passed(p.g));
  if (e.id === 1) return true;
  if (e.local === 1) return passed(finalId(e.section - 1));
  return passed(e.id - 1);
}

async function computeProgress(env, userId, isAdmin) {
  const [stats, unl] = await Promise.all([
    env.DB.prepare(
      `SELECT exam, COUNT(*) AS attempts, MAX(pct) AS best, MAX(passed) AS passed, MAX(submitted_at) AS last
         FROM attempts WHERE user_id = ?1 AND status = 'submitted' GROUP BY exam`).bind(userId).all(),
    env.DB.prepare('SELECT exam FROM unlocks WHERE user_id = ?1').bind(userId).all(),
  ]);
  const byExam = new Map(stats.results.map((r) => [r.exam, r]));
  const overrides = new Set(unl.results.map((r) => r.exam));
  const passed = (id) => !!(byExam.get(id) && byExam.get(id).passed);
  return EXAMS.map((e) => {
    const s = byExam.get(e.id);
    return {
      exam: e.id, kind: e.kind, section: e.section, local: e.local, title: e.title,
      questions: deckFor(e.id).length,
      unlocked: isAdmin || earnedUnlock(e, passed) || overrides.has(e.id),
      overridden: overrides.has(e.id),
      passed: passed(e.id),
      best: s ? s.best : null,
      attempts: s ? s.attempts : 0,
      last: s ? s.last : null,
    };
  });
}

async function progress({ env, user }) {
  const exams = await computeProgress(env, user.id, user.role === 'admin');
  const history = (await env.DB.prepare(
    `SELECT id, exam, pct, correct, total, passed, submitted_at FROM attempts
      WHERE user_id = ?1 AND status = 'submitted' ORDER BY submitted_at DESC, id DESC LIMIT 30`)
    .bind(user.id).all()).results;
  const sections = SECTIONS.map((s) => ({ id: s.id, title: s.title, weight: s.weight, final: finalId(s.id) }));
  return json({ passPct: PASS_PCT, sections, exams, history });
}

async function content({ env, user, params }) {
  const n = +params[0];
  if (!(n >= 1 && n <= PARTS.length)) throw new HttpError(404, 'Not found.');
  const p = (await computeProgress(env, user.id, user.role === 'admin')).find((x) => x.exam === n);
  if (!p.unlocked) throw new HttpError(403, lockMessage(p));
  return json({ part: n, section: p.section, local: p.local, title: p.title, html: CONTENT[n - 1].html });
}

/* ------------------------------------------------------------------ */
/* exams                                                               */
/* ------------------------------------------------------------------ */
async function startExam({ env, user, params }) {
  const exam = +params[0];
  if (!EXAM_BY_ID.has(exam)) throw new HttpError(404, 'Not found.');
  const p = (await computeProgress(env, user.id, user.role === 'admin')).find((x) => x.exam === exam);
  if (!p.unlocked) throw new HttpError(403, lockMessage(p));
  const timed = isFinal(exam);

  let att = await env.DB.prepare(
    `SELECT id, started_at FROM attempts WHERE user_id = ?1 AND exam = ?2 AND status = 'in_progress'
      ORDER BY id DESC LIMIT 1`).bind(user.id, exam).first();
  if (att && timed && att.started_at + FINAL_SECONDS + FINAL_GRACE < now()) {
    await env.DB.prepare(`UPDATE attempts SET status = 'expired' WHERE id = ?1`).bind(att.id).run();
    att = null;
  }
  if (!att) {
    att = await env.DB.prepare('INSERT INTO attempts(user_id, exam, started_at) VALUES (?1, ?2, ?3) RETURNING id, started_at')
      .bind(user.id, exam, now()).first();
  }
  return json({
    attemptId: att.id,
    exam,
    startedAt: att.started_at,
    limitSeconds: timed ? FINAL_SECONDS : null,
    remainingSeconds: timed ? Math.max(0, att.started_at + FINAL_SECONDS - now()) : null,
    passPct: PASS_PCT,
    questions: deckFor(exam).map((q) => clientQuestion(q, att.id)),
  });
}

function resultPayload(att, deck, answers) {
  return {
    attemptId: att.id,
    exam: att.exam,
    pct: att.pct,
    correct: att.correct,
    total: att.total,
    passed: !!att.passed,
    passPct: PASS_PCT,
    status: att.status,
    submittedAt: att.submitted_at,
    // After submission the full question (answers + explanation) is revealed.
    questions: deck.map((q) => ({ ...q, userAnswer: answers[q.id] ?? null, ok: grade(q, answers[q.id]) })),
  };
}

async function submitAttempt({ env, user, params, request }) {
  const id = +params[0];
  const att = await env.DB.prepare('SELECT * FROM attempts WHERE id = ?1 AND user_id = ?2').bind(id, user.id).first();
  if (!att) throw new HttpError(404, 'Attempt not found.');
  if (att.status !== 'in_progress') throw new HttpError(409, 'This attempt was already submitted.');
  const body = await readBody(request);
  let answers = body.answers && typeof body.answers === 'object' ? body.answers : {};
  const deck = deckFor(att.exam);
  const isAdmin = user.role === 'admin';
  const before = await computeProgress(env, user.id, isAdmin);

  let status = 'submitted';
  if (isFinal(att.exam) && att.started_at + FINAL_SECONDS + FINAL_GRACE < now()) {
    status = 'expired'; answers = {};
  }
  const flags = deck.map((q) => (grade(q, answers[q.id]) ? 1 : 0));
  const correct = flags.reduce((a, b) => a + b, 0);
  const total = deck.length;
  const pct = Math.round((correct / total) * 100);
  const passed = status === 'submitted' && pct >= PASS_PCT ? 1 : 0;

  const upd = await env.DB.prepare(
    `UPDATE attempts SET status = ?1, submitted_at = ?2, correct = ?3, total = ?4, pct = ?5, passed = ?6, answers = ?7
      WHERE id = ?8 AND status = 'in_progress'`)
    .bind(status, now(), correct, total, pct, passed, JSON.stringify(answers), id).run();
  if (!upd.meta || upd.meta.changes !== 1) throw new HttpError(409, 'This attempt was already submitted.');
  if (status === 'submitted') {
    await env.DB.batch(deck.map((q, i) =>
      env.DB.prepare('INSERT INTO attempt_answers(attempt_id, qid, correct) VALUES (?1, ?2, ?3)').bind(id, q.id, flags[i])));
  }
  const done = await env.DB.prepare('SELECT * FROM attempts WHERE id = ?1').bind(id).first();
  const out = resultPayload(done, deck, answers);
  const exams = await computeProgress(env, user.id, isAdmin);
  // The next exam in learning order, if this pass just unlocked it.
  const idx = EXAMS.findIndex((e) => e.id === att.exam);
  const next = idx >= 0 ? EXAMS[idx + 1] : null;
  const wasOpen = next ? before.find((x) => x.exam === next.id).unlocked : true;
  const nowOpen = next ? exams.find((x) => x.exam === next.id).unlocked : false;
  out.nextExam = passed && next && nowOpen && !wasOpen ? next.id : null;
  out.progress = exams;
  return json(out);
}

async function getAttempt({ env, user, params }) {
  const att = await env.DB.prepare('SELECT * FROM attempts WHERE id = ?1').bind(+params[0]).first();
  if (!att || (att.user_id !== user.id && user.role !== 'admin')) throw new HttpError(404, 'Attempt not found.');
  if (att.status === 'in_progress') throw bad('This attempt is still in progress.');
  return json(resultPayload(att, deckFor(att.exam), att.answers ? JSON.parse(att.answers) : {}));
}

/* ------------------------------------------------------------------ */
/* admin                                                               */
/* ------------------------------------------------------------------ */
const plain = (html) => String(html).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

async function adminOverview({ env }) {
  const t = now();
  const [totals, perExam, hard, recent] = await Promise.all([
    env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM users) AS users,
              (SELECT COUNT(*) FROM users WHERE last_seen > ?1) AS active7,
              (SELECT COUNT(*) FROM users WHERE created_at > ?1) AS new7,
              (SELECT COUNT(*) FROM attempts WHERE status = 'submitted') AS attempts,
              (SELECT COUNT(*) FROM attempts WHERE status = 'submitted' AND passed = 1) AS passes`)
      .bind(t - 7 * 86400).first(),
    env.DB.prepare(
      `SELECT exam, COUNT(*) AS attempts, ROUND(AVG(pct)) AS avg_pct,
              COUNT(DISTINCT CASE WHEN passed = 1 THEN user_id END) AS users_passed,
              COUNT(DISTINCT user_id) AS users_tried
         FROM attempts WHERE status = 'submitted' GROUP BY exam ORDER BY exam`).all(),
    env.DB.prepare(
      `SELECT qid, COUNT(*) AS n, SUM(correct) AS c FROM attempt_answers
        GROUP BY qid HAVING n >= 1 ORDER BY (SUM(correct) * 1.0 / COUNT(*)) ASC, n DESC LIMIT 8`).all(),
    env.DB.prepare(
      `SELECT a.id, a.exam, a.pct, a.passed, a.submitted_at, u.name, u.email FROM attempts a
         JOIN users u ON u.id = a.user_id WHERE a.status = 'submitted'
        ORDER BY a.submitted_at DESC, a.id DESC LIMIT 12`).all(),
  ]);
  const byExam = new Map(perExam.results.map((r) => [r.exam, r]));
  const funnel = EXAMS.map((e) => {
    const r = byExam.get(e.id) || {};
    return {
      exam: e.id, kind: e.kind, section: e.section, local: e.local, title: e.title,
      attempts: r.attempts || 0, avgPct: r.avg_pct ?? null,
      usersTried: r.users_tried || 0, usersPassed: r.users_passed || 0,
    };
  });
  const qmap = new Map(QUESTIONS.map((q) => [q.id, q]));
  return json({
    totals, funnel, passPct: PASS_PCT,
    hardest: hard.results.map((r) => ({
      qid: r.qid, part: qmap.get(r.qid)?.part, n: r.n, correctPct: Math.round((r.c / r.n) * 100),
      text: plain(qmap.get(r.qid)?.text || '').slice(0, 160),
    })),
    recent: recent.results,
  });
}

async function adminUsers({ env }) {
  const rows = (await env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.role, u.created_at, u.last_seen,
       (SELECT COUNT(DISTINCT exam) FROM attempts a WHERE a.user_id = u.id AND a.status = 'submitted' AND a.passed = 1 AND a.exam < 100) AS parts_passed,
       (SELECT COUNT(*) FROM attempts a WHERE a.user_id = u.id AND a.status = 'submitted') AS attempts,
       (SELECT MAX(submitted_at) FROM attempts a WHERE a.user_id = u.id AND a.status = 'submitted') AS last_attempt,
       (SELECT COUNT(DISTINCT exam) FROM attempts a WHERE a.user_id = u.id AND a.status = 'submitted' AND a.passed = 1 AND a.exam >= 100) AS finals_passed
       FROM users u ORDER BY u.created_at DESC LIMIT 1000`).all()).results;
  return json({ users: rows });
}

async function adminUser({ env, params }) {
  const id = +params[0];
  const u = await env.DB.prepare('SELECT id, name, email, role, created_at, last_seen FROM users WHERE id = ?1').bind(id).first();
  if (!u) throw new HttpError(404, 'User not found.');
  const exams = await computeProgress(env, id, false);
  const attempts = (await env.DB.prepare(
    `SELECT id, exam, status, pct, correct, total, passed, started_at, submitted_at FROM attempts
      WHERE user_id = ?1 AND status != 'in_progress' ORDER BY id DESC LIMIT 100`).bind(id).all()).results;
  return json({ user: u, exams, attempts });
}

async function adminSetRole({ env, user, params, request }) {
  const id = +params[0];
  const { role } = await readBody(request);
  if (role !== 'user' && role !== 'admin') throw bad('Invalid role.');
  if (id === user.id) throw bad('You cannot change your own role.');
  const r = await env.DB.prepare('UPDATE users SET role = ?1 WHERE id = ?2').bind(role, id).run();
  if (!r.meta.changes) throw new HttpError(404, 'User not found.');
  return json({ ok: true });
}

async function adminUnlock({ env, user, params, request }) {
  const id = +params[0];
  const { exam, unlock } = await readBody(request);
  if (!isInt(exam) || exam === 1 || !EXAM_BY_ID.has(exam)) throw bad('Invalid exam.');
  const exists = await env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(id).first();
  if (!exists) throw new HttpError(404, 'User not found.');
  if (unlock) {
    await env.DB.prepare('INSERT OR IGNORE INTO unlocks(user_id, exam, granted_by, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(id, exam, user.id, now()).run();
  } else {
    await env.DB.prepare('DELETE FROM unlocks WHERE user_id = ?1 AND exam = ?2').bind(id, exam).run();
  }
  return json({ ok: true });
}

async function adminResetProgress({ env, params }) {
  const id = +params[0];
  await env.DB.batch([
    env.DB.prepare('DELETE FROM attempts WHERE user_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM unlocks WHERE user_id = ?1').bind(id),
  ]);
  return json({ ok: true });
}

async function adminSetPassword({ env, params, request }) {
  const id = +params[0];
  const { password } = await readBody(request);
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw bad('Password must be at least 8 characters.');
  const salt = randHex(16);
  const r = await env.DB.prepare('UPDATE users SET pw_hash = ?1, pw_salt = ?2 WHERE id = ?3')
    .bind(await hashPassword(password, salt), salt, id).run();
  if (!r.meta.changes) throw new HttpError(404, 'User not found.');
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(id).run();
  return json({ ok: true });
}

async function adminDeleteUser({ env, user, params }) {
  const id = +params[0];
  if (id === user.id) throw bad('You cannot delete your own account.');
  const r = await env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(id).run();
  if (!r.meta.changes) throw new HttpError(404, 'User not found.');
  return json({ ok: true });
}

/* ------------------------------------------------------------------ */
/* router                                                              */
/* ------------------------------------------------------------------ */
const ROUTES = [
  ['POST', /^\/api\/register$/, 'public', register],
  ['POST', /^\/api\/login$/, 'public', login],
  ['POST', /^\/api\/google$/, 'public', googleLogin],
  ['POST', /^\/api\/logout$/, 'public', logout],
  ['GET', /^\/api\/me$/, 'public', async ({ env, user }) =>
    json({ user: user ? publicUser(user) : null, googleClientId: env.GOOGLE_CLIENT_ID || null })],
  ['GET', /^\/api\/progress$/, 'user', progress],
  ['GET', /^\/api\/content\/(\d+)$/, 'user', content],
  ['POST', /^\/api\/exams\/(\d+)\/start$/, 'user', startExam],
  ['POST', /^\/api\/attempts\/(\d+)\/submit$/, 'user', submitAttempt],
  ['GET', /^\/api\/attempts\/(\d+)$/, 'user', getAttempt],
  ['GET', /^\/api\/admin\/overview$/, 'admin', adminOverview],
  ['GET', /^\/api\/admin\/users$/, 'admin', adminUsers],
  ['GET', /^\/api\/admin\/users\/(\d+)$/, 'admin', adminUser],
  ['POST', /^\/api\/admin\/users\/(\d+)\/role$/, 'admin', adminSetRole],
  ['POST', /^\/api\/admin\/users\/(\d+)\/unlock$/, 'admin', adminUnlock],
  ['POST', /^\/api\/admin\/users\/(\d+)\/reset-progress$/, 'admin', adminResetProgress],
  ['POST', /^\/api\/admin\/users\/(\d+)\/password$/, 'admin', adminSetPassword],
  ['POST', /^\/api\/admin\/users\/(\d+)\/delete$/, 'admin', adminDeleteUser],
];

async function handle(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    // CSRF: same-origin only, and a JSON content type (forces a CORS preflight cross-site).
    const origin = request.headers.get('Origin');
    if (origin && new URL(origin).host !== url.host) throw new HttpError(403, 'Cross-origin request blocked.');
    if (!(request.headers.get('Content-Type') || '').includes('application/json'))
      throw new HttpError(415, 'Content-Type must be application/json.');
  }

  for (const [method, re, access, fn] of ROUTES) {
    if (request.method !== method) continue;
    const m = url.pathname.match(re);
    if (!m) continue;
    const user = await currentUser(env, request);
    if (access !== 'public' && !user) throw new HttpError(401, 'Please sign in.');
    if (access === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Admins only.');
    return fn({ env, request, url, user, params: m.slice(1) });
  }
  throw new HttpError(404, 'Not found.');
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error('Unhandled error', e && e.stack ? e.stack : e);
      return json({ error: 'Something went wrong. Please try again.' }, 500);
    }
  },
};
