/**
 * Automated Security Test Suite for OAuth 2.0 / OpenID Connect Implementation
 * Covers:
 * - A: Exact Redirect URI matching, wildcard rejection, HTTPS enforcement
 * - B: Cryptographic state generation, timing-safe validation, single-use anti-replay, PKCE S256
 * - C: Open Redirect defense: external URLs, protocol-relative URLs, backslashes, CRLF, safe fallback
 * - D: Session signing, signature tampering defense, session rotation
 * - E: End-to-end HTTP integration tests
 */

const assert = require('assert');
const crypto = require('crypto');
const {
  validateRedirectUri,
  getSafeReturnDestination,
  generateCryptographicState,
  generateCryptographicNonce,
  generatePkcePair,
  saveOAuthTransaction,
  validateAndConsumeOAuthTransaction,
  signValue,
  unsignValue,
  rotateAndEstablishSession,
  _oauthTransactions,
  _activeSessions
} = require('../auth/oauth');

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err.message}`);
  }
}

async function runAsyncTest(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err.message}`);
  }
}

async function runAllSecurityTests() {
  console.log('===============================================================');
  console.log('  OAUTH 2.0 / OIDC SECURITY VERIFICATION & COMPLIANCE TEST SUITE');
  console.log('===============================================================\n');

  // -------------------------------------------------------------------------
  // GROUP 1: PROVIDER REDIRECT URI SECURITY (Section A)
  // -------------------------------------------------------------------------
  console.log('[+] Group 1: Redirect URI Strict Validation & Matching');

  runTest('Accepts exact configured redirect URI (development localhost)', () => {
    const configured = 'http://localhost:3000/api/auth/oauth/callback';
    assert.strictEqual(validateRedirectUri(configured, 'http://localhost:3000/api/auth/oauth/callback'), true);
  });

  runTest('Rejects URI with different port or path', () => {
    const configured = 'http://localhost:3000/api/auth/oauth/callback';
    assert.strictEqual(validateRedirectUri(configured, 'http://localhost:8080/api/auth/oauth/callback'), false);
    assert.strictEqual(validateRedirectUri(configured, 'http://localhost:3000/api/auth/oauth/other'), false);
  });

  runTest('Rejects wildcard or regex matching attempts', () => {
    const configured = 'https://login.malibangroup.lk/api/auth/oauth/callback';
    assert.strictEqual(validateRedirectUri(configured, 'https://evil.malibangroup.lk/api/auth/oauth/callback'), false);
    assert.strictEqual(validateRedirectUri(configured, 'https://login.malibangroup.lk.attacker.com/callback'), false);
  });

  runTest('Rejects prefix matching (startsWith bypasses)', () => {
    const configured = 'https://login.malibangroup.lk/api/auth/oauth/callback';
    assert.strictEqual(validateRedirectUri(configured, 'https://login.malibangroup.lk/api/auth/oauth/callback/extra'), false);
    assert.strictEqual(validateRedirectUri(configured, 'https://login.malibangroup.lk/api/auth/oauth/callback?param=1'), false);
  });

  runTest('Enforces HTTPS in production mode', () => {
    const originalEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const httpsUri = 'https://login.malibangroup.lk/api/auth/oauth/callback';
      const httpUri = 'http://login.malibangroup.lk/api/auth/oauth/callback';
      assert.strictEqual(validateRedirectUri(httpsUri, httpsUri), true);
      assert.strictEqual(validateRedirectUri(httpUri, httpUri), false);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  runTest('Rejects missing or non-string inputs', () => {
    assert.strictEqual(validateRedirectUri(null, 'http://localhost'), false);
    assert.strictEqual(validateRedirectUri('http://localhost', undefined), false);
    assert.strictEqual(validateRedirectUri('', ''), false);
  });

  // -------------------------------------------------------------------------
  // GROUP 2: OAUTH STATE, PKCE & ANTI-REPLAY (Section B)
  // -------------------------------------------------------------------------
  console.log('\n[+] Group 2: State, Nonce, PKCE & Single-Use Anti-Replay');

  runTest('Generates high-entropy cryptographic state and nonce', () => {
    const state1 = generateCryptographicState();
    const state2 = generateCryptographicState();
    const nonce1 = generateCryptographicNonce();
    assert.strictEqual(typeof state1, 'string');
    assert.strictEqual(state1.length >= 40, true);
    assert.notStrictEqual(state1, state2);
    assert.strictEqual(typeof nonce1, 'string');
    assert.strictEqual(nonce1.length >= 30, true);
  });

  runTest('Generates valid PKCE S256 verifier and challenge pair', () => {
    const pkce = generatePkcePair();
    assert.strictEqual(typeof pkce.codeVerifier, 'string');
    assert.strictEqual(typeof pkce.codeChallenge, 'string');
    // Verify S256 calculation
    const expectedChallenge = crypto.createHash('sha256').update(pkce.codeVerifier).digest('base64url');
    assert.strictEqual(pkce.codeChallenge, expectedChallenge);
  });

  runTest('Consumes state successfully on first valid attempt', () => {
    const state = generateCryptographicState();
    saveOAuthTransaction(state, { test: 'context', returnTo: '/admin' });

    const retrieved = validateAndConsumeOAuthTransaction(state);
    assert.ok(retrieved);
    assert.strictEqual(retrieved.test, 'context');
    assert.strictEqual(retrieved.returnTo, '/admin');
  });

  runTest('Prevents Replay Attacks: immediate second attempt fails', () => {
    const state = generateCryptographicState();
    saveOAuthTransaction(state, { test: 'single_use' });

    const first = validateAndConsumeOAuthTransaction(state);
    assert.ok(first);

    // Replay attempt with same state
    const replay = validateAndConsumeOAuthTransaction(state);
    assert.strictEqual(replay, null, 'State replay MUST be rejected');
  });

  runTest('Rejects mismatched or non-existent state values', () => {
    const state = generateCryptographicState();
    saveOAuthTransaction(state, { test: 'valid' });

    assert.strictEqual(validateAndConsumeOAuthTransaction('completely-wrong-state'), null);
    assert.strictEqual(validateAndConsumeOAuthTransaction(''), null);
    assert.strictEqual(validateAndConsumeOAuthTransaction(null), null);
  });

  runTest('Rejects expired state transactions', () => {
    const state = generateCryptographicState();
    // Simulate expired state by backdating expiresAt
    _oauthTransactions.set(state, {
      test: 'expired',
      createdAt: Date.now() - 20000,
      expiresAt: Date.now() - 1000 // already expired
    });

    const result = validateAndConsumeOAuthTransaction(state);
    assert.strictEqual(result, null, 'Expired state transaction must be rejected');
  });

  // -------------------------------------------------------------------------
  // GROUP 3: OPEN REDIRECT DEFENSE & RETURN DESTINATION (Section C)
  // -------------------------------------------------------------------------
  console.log('\n[+] Group 3: Open Redirect Defense & Path Canonicalization');

  runTest('Permits valid allowlisted internal paths (/ and /admin)', () => {
    assert.strictEqual(getSafeReturnDestination('/'), '/');
    assert.strictEqual(getSafeReturnDestination('/admin'), '/admin');
    assert.strictEqual(getSafeReturnDestination('/admin?tab=locations'), '/admin?tab=locations');
  });

  runTest('Rejects external absolute URLs and falls back to /', () => {
    assert.strictEqual(getSafeReturnDestination('https://attacker.com'), '/');
    assert.strictEqual(getSafeReturnDestination('http://evil.org/phish'), '/');
    assert.strictEqual(getSafeReturnDestination('ftp://server/file'), '/');
  });

  runTest('Rejects protocol-relative URLs (//attacker.com)', () => {
    assert.strictEqual(getSafeReturnDestination('//attacker.com'), '/');
    assert.strictEqual(getSafeReturnDestination('//attacker.com/admin'), '/');
    assert.strictEqual(getSafeReturnDestination('///attacker.com'), '/');
  });

  runTest('Rejects backslash parser-confusion variants', () => {
    assert.strictEqual(getSafeReturnDestination('/\\attacker.com'), '/');
    assert.strictEqual(getSafeReturnDestination('\\\\attacker.com'), '/');
    assert.strictEqual(getSafeReturnDestination('/admin\\something'), '/');
  });

  runTest('Rejects CRLF and control character injections', () => {
    assert.strictEqual(getSafeReturnDestination('/admin\r\nSet-Cookie: evil=1'), '/');
    assert.strictEqual(getSafeReturnDestination('/admin\u0000evil'), '/');
    assert.strictEqual(getSafeReturnDestination('/admin%0d%0aattacker.com'), '/');
  });

  runTest('Rejects unapproved internal paths and returns default /', () => {
    assert.strictEqual(getSafeReturnDestination('/api/secret/keys'), '/');
    assert.strictEqual(getSafeReturnDestination('/hidden-console'), '/');
  });

  runTest('Rejects null, undefined, and non-string inputs safely', () => {
    assert.strictEqual(getSafeReturnDestination(null), '/');
    assert.strictEqual(getSafeReturnDestination(undefined), '/');
    assert.strictEqual(getSafeReturnDestination(''), '/');
    assert.strictEqual(getSafeReturnDestination(12345), '/');
  });

  // -------------------------------------------------------------------------
  // GROUP 4: SESSION MANAGEMENT & TAMPER PROOFING (Section D)
  // -------------------------------------------------------------------------
  console.log('\n[+] Group 4: Session Signing, Tamper-Resistance & Rotation');

  const secret = 'super-secret-key-32-chars-minimum-length-for-hmac-sha256';

  runTest('Signs and verifies session cookie values with HMAC-SHA256', () => {
    const original = 'session-id-123456';
    const signed = signValue(original, secret);
    assert.ok(signed.startsWith(original + '.'));
    const verified = unsignValue(signed, secret);
    assert.strictEqual(verified, original);
  });

  runTest('Rejects tampered cookie signatures', () => {
    const signed = signValue('session-id-123456', secret);
    const tamperedPayload = signed.replace('123456', '999999');
    assert.strictEqual(unsignValue(tamperedPayload, secret), null);

    const tamperedSig = signed.slice(0, -4) + 'abcd';
    assert.strictEqual(unsignValue(tamperedSig, secret), null);
  });

  runTest('Rotates session identifier upon authentication', () => {
    const mockReq = { headers: {}, secure: false };
    const mockRes = {
      cookieMap: {},
      cookie(name, val, opts) { this.cookieMap[name] = { val, opts }; }
    };

    const user = { uid: 1, name: 'Admin User', role: 'admin' };
    const sid1 = rotateAndEstablishSession(mockReq, mockRes, user, secret);
    assert.ok(sid1);
    assert.ok(mockRes.cookieMap['app_session']);
    assert.strictEqual(mockRes.cookieMap['app_session'].opts.httpOnly, true);
    assert.strictEqual(mockRes.cookieMap['app_session'].opts.sameSite, 'Lax');

    // Simulate second login - new session ID must be generated
    const sid2 = rotateAndEstablishSession(mockReq, mockRes, user, secret);
    assert.notStrictEqual(sid1, sid2, 'Session ID MUST be rotated upon authentication');
  });

  // -------------------------------------------------------------------------
  // GROUP 5: HTTP INTEGRATION TESTS (Running Server)
  // -------------------------------------------------------------------------
  console.log('\n[+] Group 5: HTTP Integration Tests');

  await runAsyncTest('GET /api/auth/oauth/login initiates authorization with state, PKCE and sanitized returnTo', async () => {
    const res = await fetch('http://localhost:3000/api/auth/oauth/login?returnTo=https://attacker.com', {
      redirect: 'manual'
    });
    // Must return redirect to authUrl (302)
    assert.strictEqual(res.status, 302);
    const location = res.headers.get('location');
    assert.ok(location, 'Location header must be present');

    const authUrl = new URL(location);
    const state = authUrl.searchParams.get('state');
    assert.ok(state, 'State param must be present');
    assert.ok(authUrl.searchParams.get('code_challenge'), 'code_challenge must be present');
    assert.strictEqual(authUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(authUrl.searchParams.get('nonce'), 'Nonce must be present');

    // Verify sanitization: when callback is executed with this state, destination must be / (not attacker.com)
    const cookieHeader = res.headers.get('set-cookie');
    const callbackRes = await fetch(`http://localhost:3000/api/auth/oauth/callback?state=${state}&code=sample_code`, {
      redirect: 'manual',
      headers: { 'Cookie': cookieHeader || '' }
    });
    assert.strictEqual(callbackRes.status, 302);
    assert.strictEqual(callbackRes.headers.get('location'), '/', 'Unsafe return destination MUST be sanitized to /');
  });

  await runAsyncTest('GET /api/auth/oauth/callback rejects missing state and code with 400', async () => {
    const res = await fetch('http://localhost:3000/api/auth/oauth/callback');
    assert.strictEqual(res.status, 400);
  });

  await runAsyncTest('GET /api/auth/oauth/callback rejects invalid or forged state with 400', async () => {
    const res = await fetch('http://localhost:3000/api/auth/oauth/callback?state=forged_state_123&code=sample_code');
    assert.strictEqual(res.status, 400);
  });

  await runAsyncTest('GET /api/auth/oauth/callback completes valid flow, rotates session, and redirects safely', async () => {
    // 1. Initiate login
    const loginRes = await fetch('http://localhost:3000/api/auth/oauth/login?returnTo=/admin', {
      redirect: 'manual'
    });
    const location = loginRes.headers.get('location');
    const authUrl = new URL(location);
    const state = authUrl.searchParams.get('state');
    const cookieHeader = loginRes.headers.get('set-cookie');

    // 2. Simulate callback with valid state & code
    const callbackRes = await fetch(`http://localhost:3000/api/auth/oauth/callback?state=${state}&code=valid_auth_code_999&mock_email=test.supervisor@malibangroup.lk&mock_name=TestSupervisor`, {
      redirect: 'manual',
      headers: {
        'Cookie': cookieHeader || ''
      }
    });

    // Must redirect to /admin (sanitized returnTo)
    assert.strictEqual(callbackRes.status, 302);
    assert.strictEqual(callbackRes.headers.get('location'), '/admin');

    // Verify app_session cookie was issued
    const sessionCookieHeader = callbackRes.headers.get('set-cookie');
    assert.ok(sessionCookieHeader.includes('app_session='));
    assert.ok(sessionCookieHeader.toLowerCase().includes('httponly'));

    // 3. Test replay attack on callback with the exact same state - MUST FAIL (400)
    const replayRes = await fetch(`http://localhost:3000/api/auth/oauth/callback?state=${state}&code=valid_auth_code_999`, {
      redirect: 'manual',
      headers: {
        'Cookie': cookieHeader || ''
      }
    });
    assert.strictEqual(replayRes.status, 400, 'Replayed callback MUST be rejected');
  });

  console.log('\n===============================================================');
  console.log(`  TEST RESULTS: ${passedTests} / ${totalTests} TESTS PASSED (${totalTests - passedTests} FAILED)`);
  console.log('===============================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runAllSecurityTests().catch(err => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
