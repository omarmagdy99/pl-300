// End-to-end API check against a running `wrangler dev` (local D1). Needs the real src/questions.js.
// Never run this against production: it registers the admin email.
import { QUESTIONS } from '../src/questions.js';
import { EXAMS, PARTS, SECTIONS, finalId, sectionOfPart } from '../src/course.js';

const BASE = process.env.BASE || 'http://localhost:8787';
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

function client() {
  let cookie = '';
  return async (path, method = 'GET', body, extra = {}) => {
    const r = await fetch(BASE + '/api' + path, {
      method, headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra },
      body: method !== 'GET' ? JSON.stringify(body || {}) : undefined,
    });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let data = null; try { data = await r.json(); } catch {}
    return { s: r.status, d: data };
  };
}
const correctFor = (q) => q.type === 'dropdown' ? q.dd.map((d) => d.ans) : q.type === 'order' ? q.items.map((_, i) => i) : q.ans;
const deck = (id) => id >= 100 ? QUESTIONS.filter((q) => sectionOfPart(q.part) === id - 100) : QUESTIONS.filter((q) => q.part === id);

// start + submit an exam with all-correct (or all-empty) answers
async function take(c, id, perfect = true) {
  const st = await c(`/exams/${id}/start`, 'POST');
  if (st.s !== 200) return { start: st };
  const answers = {};
  if (perfect) deck(id).forEach((q) => answers[q.id] = correctFor(q));
  const sub = await c(`/attempts/${st.d.attemptId}/submit`, 'POST', { answers });
  return { start: st, sub };
}

const stamp = Date.now();
const admin = client(), u1 = client(), anon = client(), other = client();

/* ---------- structure ---------- */
ok(EXAMS.length === PARTS.length + SECTIONS.length && SECTIONS.length === 4, `course has ${PARTS.length} parts and ${SECTIONS.length} finals`);
ok(EXAMS.every((e) => deck(e.id).length > 0), 'every exam has questions');

/* ---------- accounts ---------- */
let r = await anon('/progress'); ok(r.s === 401, 'anon cannot read progress');
r = await anon('/register', 'POST', { name: 'X', email: 'bad', password: 'short' }); ok(r.s === 400, 'validation rejects bad input');
r = await admin('/register', 'POST', { name: 'Omar Admin', email: 'omarmagdy99860@gmail.com', password: 'AdminPass123' });
ok(r.s === 201 && r.d.user.role === 'admin', 'admin email becomes admin on register (Google not configured locally)');
const email = `student${stamp}@example.com`;
r = await u1('/register', 'POST', { name: 'Test Student', email, password: 'StudentPass1' }); ok(r.s === 201 && r.d.user.role === 'user', 'student registers as user');
r = await u1('/register', 'POST', { name: 'Dup', email, password: 'StudentPass1' }); ok(r.s === 409, 'duplicate email rejected');

/* ---------- gating chain, section 1 ---------- */
r = await u1('/progress');
ok(r.d.exams.length === EXAMS.length && r.d.sections.length === SECTIONS.length, `progress lists ${EXAMS.length} exams`);
ok(r.d.exams.filter((x) => x.unlocked).map((x) => x.exam).join() === '1', 'only Part 1.1 unlocked initially');
r = await u1('/content/2'); ok(r.s === 403, 'Part 1.2 content blocked');
r = await u1('/content/1'); ok(r.s === 200 && r.d.html.length > 500, 'Part 1.1 content served');
r = await u1('/content/7'); ok(r.s === 403, 'Section 2 content blocked');
r = await u1('/exams/2/start', 'POST'); ok(r.s === 403, 'Part 1.2 exam blocked');
r = await u1('/exams/999/start', 'POST'); ok(r.s === 404, 'unknown exam id → 404');

let t = await take(u1, 1, false);
ok(t.sub.d.pct === 0 && !t.sub.d.passed && t.sub.d.nextExam == null, 'empty submit scores 0, nothing unlocks');
ok(t.sub.d.questions[0].ans !== undefined && t.sub.d.questions[0].exp, 'results reveal answers after submit');
r = await u1(`/attempts/${t.start.d.attemptId}/submit`, 'POST', { answers: {} }); ok(r.s === 409, 'double submit rejected');
const leak = JSON.stringify(t.start.d); ok(!leak.includes('"ans"') && !leak.includes('"exp"'), 'start payload leaks no answers/explanations');

t = await take(u1, 1); ok(t.sub.d.pct === 100 && t.sub.d.passed && t.sub.d.nextExam === 2, 'perfect Part 1.1 unlocks Part 1.2');
r = await u1('/content/3'); ok(r.s === 403, 'Part 1.3 still locked');
for (let g = 2; g <= 5; g++) { t = await take(u1, g); ok(t.sub.d.passed && t.sub.d.nextExam === g + 1, `passing part ${g} unlocks part ${g + 1}`); }
r = await u1('/exams/101/start', 'POST'); ok(r.s === 403, 'Section 1 final locked until all 6 parts passed');
t = await take(u1, 6); ok(t.sub.d.passed && t.sub.d.nextExam === 101, 'passing Part 1.6 unlocks the Section 1 final');
r = await u1('/content/7'); ok(r.s === 403, 'Section 2 still locked after Part 1.6');
t = await take(u1, 101, false); ok(!t.sub.d.passed && t.start.d.limitSeconds === 2700, 'final is timed (45 min) and can fail');
r = await u1('/content/7'); ok(r.s === 403, 'Section 2 locked after failing the final');
t = await take(u1, 101); ok(t.sub.d.passed && t.sub.d.nextExam === 7 && t.sub.d.total === deck(101).length, 'passing the final unlocks Section 2');

/* ---------- later sections: each needs the previous section's final ---------- */
// walk sections in order: section 1's final already passed above, so section 2 is open
for (const sec of SECTIONS.slice(1)) {
  const parts = PARTS.filter((p) => p.section === sec.id);
  r = await u1('/content/' + parts[0].g); ok(r.s === 200, `Section ${sec.id} opens after the previous final`);
  r = await u1('/exams/' + finalId(sec.id) + '/start', 'POST'); ok(r.s === 403, `Section ${sec.id} final locked until its parts are passed`);
  for (const p of parts) { t = await take(u1, p.g); ok(t.sub.d.passed, `Part ${sec.id}.${p.local} passed (${t.sub.d.total} questions)`); }
  const after = PARTS.find((p) => p.section === sec.id + 1);
  if (after) { r = await u1('/content/' + after.g); ok(r.s === 403, `Section ${sec.id + 1} still locked before the Section ${sec.id} final`); }
  t = await take(u1, finalId(sec.id));
  const last = SECTIONS[SECTIONS.length - 1].id === sec.id;
  ok(t.sub.d.passed && t.sub.d.total === deck(finalId(sec.id)).length, `Section ${sec.id} final passed (${t.sub.d.total} questions)`);
  ok(last ? t.sub.d.nextExam == null : t.sub.d.nextExam === PARTS.find((p) => p.section === sec.id + 1).g, last ? 'last final ends the programme' : `Section ${sec.id + 1} unlocked by the final`);
}
for (const p of PARTS) { r = await u1('/content/' + p.g); if (r.s !== 200 || r.d.html.length < 500) ok(false, 'content ' + p.g); }
ok(true, 'all parts are served once unlocked');
r = await u1('/progress'); ok(r.d.exams.every((x) => x.passed && x.unlocked), 'dashboard shows everything passed');

/* ---------- tampering / isolation ---------- */
await other('/register', 'POST', { name: 'Other', email: `o${stamp}@example.com`, password: 'OtherPass12' });
r = await other('/exams/1/start', 'POST'); const a3 = r.d;
r = await other(`/attempts/${a3.attemptId}/submit`, 'POST', { answers: { 1: 'x', 2: { a: 1 }, 3: [99], 4: [true, true, true] } });
ok(r.s === 200 && r.d.pct === 0, 'garbage answers just score 0');
r = await u1(`/attempts/${a3.attemptId}`); ok(r.s === 404, "user cannot read another user's attempt");
r = await u1('/logout', 'POST', {}, { Origin: 'https://evil.example' }); ok(r.s === 403, 'cross-origin POST blocked');

/* ---------- admin ---------- */
r = await u1('/admin/overview'); ok(r.s === 403, 'student blocked from admin API');
r = await admin('/admin/overview'); ok(r.s === 200 && r.d.funnel.length === EXAMS.length && r.d.totals.users >= 3, 'admin overview lists every exam');
ok(r.d.hardest.length > 0, 'hardest questions computed');
r = await admin('/admin/users'); const stu = r.d.users.find((x) => x.email === email);
ok(stu && stu.parts_passed === PARTS.length && stu.finals_passed === SECTIONS.length, 'admin list shows all parts and finals passed');
const o = r.d.users.find((x) => x.email === `o${stamp}@example.com`);
r = await admin(`/admin/users/${o.id}/unlock`, 'POST', { exam: 7, unlock: true }); ok(r.s === 200, 'admin unlocks Part 2.1 for another user');
r = await other('/content/7'); ok(r.s === 200, 'override opens Part 2.1');
r = await other('/content/8'); ok(r.s === 403, 'override opens only that part');
r = await admin(`/admin/users/${o.id}/unlock`, 'POST', { exam: 7, unlock: false }); r = await other('/content/7'); ok(r.s === 403, 'override removal locks again');
r = await admin(`/admin/users/${o.id}/unlock`, 'POST', { exam: 999, unlock: true }); ok(r.s === 400, 'invalid unlock id rejected');
r = await admin(`/admin/users/${stu.id}`); ok(r.s === 200 && r.d.exams.length === EXAMS.length, 'admin user detail lists every exam');
r = await admin('/admin/users/1/delete', 'POST'); ok(r.s === 400, 'admin cannot delete self');
r = await admin(`/admin/users/${stu.id}/reset-progress`, 'POST'); r = await u1('/progress'); ok(r.d.exams.filter((x) => x.unlocked).length === 1, 'reset progress re-locks everything');
r = await admin(`/admin/users/${stu.id}/delete`, 'POST'); ok(r.s === 200, 'admin deletes user');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
