// Verifies a Google Sign-In ID token (a JWT) using Google's public keys.
// No client secret is needed: only the public OAuth client ID.

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64u(s) {
  const b = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
}

export class TokenError extends Error {}

/**
 * @param {string} token       the credential returned by Google Identity Services
 * @param {string} clientId    our OAuth client ID (must equal the token's `aud`)
 * @param {(force?:boolean)=>Promise<{keys:object[]}>} getJwks
 * @param {number} nowSec      current unix time in seconds
 * @returns {Promise<{email:string,name:string,sub:string}>}
 */
export async function verifyGoogleIdToken(token, clientId, getJwks, nowSec) {
  if (typeof token !== 'string' || token.length > 4096) throw new TokenError('Invalid token.');
  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenError('Invalid token.');

  let header, payload;
  try {
    header = JSON.parse(dec.decode(b64u(parts[0])));
    payload = JSON.parse(dec.decode(b64u(parts[1])));
  } catch { throw new TokenError('Invalid token.'); }
  if (header.alg !== 'RS256' || !header.kid) throw new TokenError('Unsupported token.');

  let jwk = ((await getJwks(false)).keys || []).find((k) => k.kid === header.kid && k.kty === 'RSA');
  if (!jwk) jwk = ((await getJwks(true)).keys || []).find((k) => k.kid === header.kid && k.kty === 'RSA'); // key rotation
  if (!jwk) throw new TokenError('Unknown signing key.');

  const key = await crypto.subtle.importKey(
    'jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64u(parts[2]), enc.encode(parts[0] + '.' + parts[1]));
  if (!valid) throw new TokenError('Bad signature.');

  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') throw new TokenError('Wrong issuer.');
  if (payload.aud !== clientId) throw new TokenError('Wrong audience.');
  if (!payload.exp || payload.exp < nowSec - 30) throw new TokenError('Token expired.');
  if (payload.iat && payload.iat > nowSec + 300) throw new TokenError('Token issued in the future.');
  if (payload.email_verified !== true && payload.email_verified !== 'true') throw new TokenError('Google email is not verified.');
  if (typeof payload.email !== 'string' || !payload.email.includes('@')) throw new TokenError('No email in token.');

  const email = payload.email.toLowerCase();
  return { email, name: String(payload.name || email.split('@')[0]), sub: String(payload.sub || '') };
}
