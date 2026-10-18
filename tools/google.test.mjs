// Unit test for Google ID-token verification using a locally generated RSA key (no network).
import { verifyGoogleIdToken } from '../src/google.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const enc = new TextEncoder();

const pair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
const jwks = { keys: [{ ...pub, kid: 'k1', use: 'sig', alg: 'RS256' }] };
const getJwks = async () => jwks;

const CLIENT = 'test-client.apps.googleusercontent.com';
const NOW = 1_800_000_000;
async function mint(over = {}, { kid = 'k1', alg = 'RS256', key = pair.privateKey } = {}) {
  const h = b64u(enc.encode(JSON.stringify({ alg, kid, typ: 'JWT' })));
  const p = b64u(enc.encode(JSON.stringify({
    iss: 'https://accounts.google.com', aud: CLIENT, sub: '123', email: 'Sara@Example.com', email_verified: true,
    name: 'سارة أحمد', iat: NOW - 10, exp: NOW + 3000, ...over })));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(h + '.' + p));
  return `${h}.${p}.${b64u(sig)}`;
}
const rejects = async (t, m) => { try { await verifyGoogleIdToken(t, CLIENT, getJwks, NOW); ok(false, m); } catch { ok(true, m); } };

const u = await verifyGoogleIdToken(await mint(), CLIENT, getJwks, NOW);
ok(u.email === 'sara@example.com' && u.name === 'سارة أحمد' && u.sub === '123', 'valid token accepted (email lowercased, Arabic name intact)');
await rejects(await mint({ aud: 'someone-else' }), 'wrong audience rejected');
await rejects(await mint({ exp: NOW - 1000 }), 'expired token rejected');
await rejects(await mint({ iss: 'https://evil.example' }), 'wrong issuer rejected');
await rejects(await mint({ email_verified: false }), 'unverified email rejected');
await rejects(await mint({}, { kid: 'nope' }), 'unknown key id rejected');
await rejects(await mint({}, { alg: 'none' }), 'non-RS256 rejected');
const other = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
await rejects(await mint({}, { key: other.privateKey }), 'token signed by a different key rejected');
const good = await mint(); const [h, p, s] = good.split('.');
await rejects(`${h}.${b64u(enc.encode(JSON.stringify({ iss: 'accounts.google.com', aud: CLIENT, exp: NOW + 999, email: 'admin@x.com', email_verified: true })))}.${s}`, 'tampered payload rejected');
await rejects('garbage', 'garbage rejected');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
