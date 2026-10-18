// End-to-end API check against a running `wrangler dev` (local D1).
import { QUESTIONS } from '../src/questions.js';
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

const stamp = Date.now();
const admin = client(), u1 = client(), anon = client();

let r = await anon('/progress'); ok(r.s === 401, 'anon cannot read progress');
r = await anon('/register', 'POST', { name: 'X', email: 'bad', password: 'short' }); ok(r.s === 400, 'validation rejects bad input');

r = await admin('/register', 'POST', { name: 'Omar Admin', email: 'omarmagdy99860@gmail.com', password: 'AdminPass123' });
ok(r.s === 201 && r.d.user.role === 'admin', 'admin email becomes admin on register');

const email = `student${stamp}@example.com`;
r = await u1('/register', 'POST', { name: 'Test Student', email, password: 'StudentPass1' }); ok(r.s === 201 && r.d.user.role === 'user', 'student registers as user');
r = await u1('/register', 'POST', { name: 'Dup', email, password: 'StudentPass1' }); ok(r.s === 409, 'duplicate email rejected');
r = await u1('/me'); ok(r.d.user && r.d.user.email === email, 'session cookie works');

r = await u1('/progress');
ok(r.d.exams[0].unlocked && !r.d.exams[1].unlocked && !r.d.exams[6].unlocked, 'only Part 1 unlocked initially');
r = await u1('/content/2'); ok(r.s === 403, 'Part 2 content blocked before passing Part 1');
r = await u1('/content/1'); ok(r.s === 200 && r.d.html.includes('storage mode') || r.d.html.includes('Storage modes'), 'Part 1 content served');
r = await u1('/exams/2/start', 'POST'); ok(r.s === 403, 'Part 2 exam blocked');

r = await u1('/exams/1/start', 'POST');
const att = r.d; ok(r.s === 200 && att.questions.length === 4, 'Part 1 exam starts with 4 questions');
ok(!JSON.stringify(att).includes('"ans"') && !JSON.stringify(att).includes('"exp"'), 'start payload leaks no answers/explanations');
const r2 = await u1('/exams/1/start', 'POST'); ok(r2.d.attemptId === att.attemptId, 'start resumes the open attempt');

// fail first (all wrong/empty)
r = await u1(`/attempts/${att.attemptId}/submit`, 'POST', { answers: {} });
ok(r.s === 200 && r.d.pct === 0 && !r.d.passed && r.d.nextUnlocked == null, 'empty submit scores 0, no unlock');
ok(r.d.questions[0].ans !== undefined && r.d.questions[0].exp, 'results reveal answers after submit');
r = await u1(`/attempts/${att.attemptId}/submit`, 'POST', { answers: {} }); ok(r.s === 409, 'double submit rejected');
r = await u1('/content/2'); ok(r.s === 403, 'still locked after failing');

// pass with correct answers (derived from server bank)
r = await u1('/exams/1/start', 'POST'); const a2 = r.d;
const answers = {}; QUESTIONS.filter((q) => q.part === 1).forEach((q) => answers[q.id] = correctFor(q));
r = await u1(`/attempts/${a2.attemptId}/submit`, 'POST', { answers });
ok(r.d.pct === 100 && r.d.passed && r.d.nextUnlocked === 2, 'perfect score passes and unlocks Part 2');
r = await u1('/content/2'); ok(r.s === 200, 'Part 2 content now served');
r = await u1('/content/3'); ok(r.s === 403, 'Part 3 still locked');
r = await u1('/exams/7/start', 'POST'); ok(r.s === 403, 'final exam locked');

// tampering
r = await u1('/exams/2/start', 'POST'); const a3 = r.d;
r = await u1(`/attempts/${a3.attemptId}/submit`, 'POST', { answers: { 5: 'x', 6: { a: 1 }, 7: [99], 8: [true, true, true] } });
ok(r.s === 200 && r.d.pct === 0, 'garbage answers just score 0');
const other = client(); await other('/register', 'POST', { name: 'Other', email: `o${stamp}@example.com`, password: 'OtherPass12' });
r = await other(`/attempts/${a2.attemptId}`); ok(r.s === 404, "user cannot read another user's attempt");
r = await other(`/attempts/${a3.attemptId}/submit`, 'POST', { answers: {} }); ok(r.s === 404, "user cannot submit another user's attempt");

// CSRF
r = await u1('/logout', 'POST', {}, { Origin: 'https://evil.example' }); ok(r.s === 403, 'cross-origin POST blocked');

// admin
r = await u1('/admin/overview'); ok(r.s === 403, 'student blocked from admin API');
r = await admin('/admin/overview'); ok(r.s === 200 && r.d.totals.users >= 3 && r.d.funnel.length === 7, 'admin overview works');
ok(r.d.hardest.length > 0, 'hardest questions computed');
r = await admin('/admin/users'); const stu = r.d.users.find((x) => x.email === email);
ok(stu && stu.parts_passed === 1, 'admin user list shows progress');
r = await admin(`/admin/users/${stu.id}/unlock`, 'POST', { exam: 4, unlock: true }); ok(r.s === 200, 'admin unlocks Part 4');
r = await u1('/content/4'); ok(r.s === 200, 'student can open overridden Part 4');
r = await admin(`/admin/users/${stu.id}/unlock`, 'POST', { exam: 4, unlock: false });
r = await u1('/content/4'); ok(r.s === 403, 'override removal locks again');
r = await admin(`/admin/users/${stu.id}/password`, 'POST', { password: 'NewPassword99' });
r = await u1('/me'); ok(r.d.user === null, 'password change signs the student out');
const u1b = client(); r = await u1b('/login', 'POST', { email, password: 'NewPassword99' }); ok(r.s === 200, 'login with new password');
r = await u1b('/login', 'POST', { email, password: 'wrong-password' }); ok(r.s === 401, 'wrong password rejected');
r = await admin(`/admin/users/${stu.id}/reset-progress`, 'POST'); r = await u1b('/progress'); ok(!r.d.exams[1].unlocked, 'reset progress re-locks');
r = await admin('/admin/users/1/delete', 'POST'); ok(r.s === 400, 'admin cannot delete self');
r = await admin(`/admin/users/${stu.id}/delete`, 'POST'); ok(r.s === 200, 'admin deletes user');
r = await u1b('/me'); ok(r.d.user === null, 'deleted user session is gone');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
