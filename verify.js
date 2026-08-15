#!/usr/bin/env node
/**
 * SAO Verification Script
 * Auto-registers admin if login fails (first user becomes admin)
 * Usage: node verify.js [server_url] [email] [password]
 * Default: http://localhost:3000, admin@sao.system, SAOAdmin2026!
 */

var SERVER = process.argv[2] || 'http://localhost:3000';
var EMAIL = process.argv[3] || process.env.SAO_ADMIN_EMAIL || 'admin@sao.system';
var PASSWORD = process.argv[4] || process.env.SAO_ADMIN_PASSWORD || 'SAOAdmin2026!';

async function check(label, fn) {
  process.stdout.write(label + '... ');
  try {
    var result = await fn();
    if (result.ok) {
      console.log('\u2705 PASS');
      if (result.detail) console.log('   \u2192 ' + result.detail);
      return true;
    } else {
      console.log('\u274C FAIL');
      console.log('   \u2192 ' + (result.detail || 'Unexpected response'));
      return false;
    }
  } catch (err) {
    console.log('\u274C FAIL');
    console.log('   \u2192 ' + err.message);
    return false;
  }
}

async function fetchJSON(p) {
  var res = await fetch(SERVER + p);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function fetchTRPCQuery(path, input, cookie) {
  var inputParam = input ? encodeURIComponent(JSON.stringify(input)) : encodeURIComponent(JSON.stringify({}));
  var url = SERVER + '/api/trpc/' + path + '?input=' + inputParam;
  var headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  var res = await fetch(url, { method: 'GET', headers: headers });
  var data = await res.json();
  if (data.error) throw new Error(data.error.message || 'tRPC error');
  return data.result;
}

function extractCookie(res) {
  var setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    var m = setCookie.match(/sao_session=([^;]+)/);
    if (m) return 'sao_session=' + m[1];
  }
  return null;
}

async function tryLogin() {
  var res = await fetch(SERVER + '/api/trpc/auth.login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  var data = await res.json();
  if (data.error) return { ok: false, error: data.error.message };
  var cookie = extractCookie(res);
  return { ok: !!cookie, cookie: cookie };
}

async function tryRegister() {
  var res = await fetch(SERVER + '/api/trpc/auth.register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  var data = await res.json();
  if (data.error) return { ok: false, error: data.error.message };
  var cookie = extractCookie(res);
  return { ok: !!cookie, cookie: cookie };
}

async function getAuthCookie() {
  // Step 1: Try login
  console.log('   Trying login with ' + EMAIL + '...');
  var loginResult = await tryLogin();
  if (loginResult.ok && loginResult.cookie) {
    console.log('   \u2705 Login successful');
    return loginResult.cookie;
  }

  // Step 2: Login failed, try register (first user becomes admin)
  console.log('   \u26A0\uFE0F  Login failed: ' + (loginResult.error || 'no cookie'));
  console.log('   Trying register (first user auto-becomes admin)...');
  var regResult = await tryRegister();
  if (regResult.ok && regResult.cookie) {
    console.log('   \u2705 Registered new admin user');
    return regResult.cookie;
  }

  // Step 3: Both failed
  console.log('   \u274C Register also failed: ' + (regResult.error || 'no cookie'));
  console.log('   Server: ' + SERVER);
  console.log('   Email: ' + EMAIL);
  console.log('   Make sure your database is migrated and the server is running.');
  return null;
}

async function main() {
  console.log('\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
  console.log('\u2551           SAO Verification System               \u2551');
  console.log('\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D');
  console.log('Server: ' + SERVER);
  console.log('Credentials: ' + EMAIL + '\n');

  console.log('Authenticating...');
  var authCookie = await getAuthCookie();
  console.log('');
  if (authCookie) {
    console.log('\u2705 Ready to run checks\n');
  } else {
    console.log('\u26A0\uFE0F  Running without auth \u2014 protected routes will fail\n');
  }

  var passed = 0;
  var total = 0;

  // 1. Health & readiness endpoints (no auth needed)
  total++;
  if (await check('1. Server health and readiness endpoints', async function() {
    var health = await fetchJSON('/api/health');
    var ready = await fetchJSON('/api/ready');
    if (!health || health.status !== 'healthy') {
      return { ok: false, detail: 'Health endpoint returned non-healthy status' };
    }
    if (!ready || ready.status !== 'ready') {
      return { ok: false, detail: 'Ready endpoint returned non-ready status' };
    }
    return { ok: true, detail: 'Health: healthy (uptime ' + Math.round(health.uptime) + 's), Ready: ' + (ready.database || 'ready') };
  })) passed++;

  // 2. Core loop state
  total++;
  if (await check('2. Core loop state (coreLoop.status)', async function() {
    var result = await fetchTRPCQuery('coreLoop.status', null, authCookie);
    var state = result && result.data;
    if (!state) return { ok: false, detail: 'No core loop state returned' };
    return { ok: true, detail: 'Running: ' + state.isRunning + ', Gaps: ' + (state.totalGapsProcessed || 0) + ', Deployments: ' + (state.totalDeploymentsCreated || 0) };
  })) passed++;

  // 3. Gaps table
  total++;
  if (await check('3. Gaps table (gaps.list)', async function() {
    var result = await fetchTRPCQuery('gaps.list', { limit: 5, skip: 0 }, authCookie);
    var gaps = (result && result.data) || [];
    return { ok: Array.isArray(gaps), detail: gaps.length + ' gaps in database' };
  })) passed++;

  // 4. Queue table
  total++;
  if (await check('4. Queue table (queue.list)', async function() {
    var result = await fetchTRPCQuery('queue.list', null, authCookie);
    var items = (result && result.data) || [];
    return { ok: Array.isArray(items), detail: items.length + ' queue items' };
  })) passed++;

  // 5. Deployments table
  total++;
  if (await check('5. Deployments table (deployments.list)', async function() {
    var result = await fetchTRPCQuery('deployments.list', null, authCookie);
    var deps = (result && result.data) || [];
    return { ok: Array.isArray(deps), detail: deps.length + ' deployments' };
  })) passed++;

  // 6. Policies table
  total++;
  if (await check('6. Policies table (policies.list)', async function() {
    var result = await fetchTRPCQuery('policies.list', null, authCookie);
    var policies = (result && result.data) || [];
    return { ok: Array.isArray(policies), detail: policies.length + ' policies' };
  })) passed++;

  // 7. Analytics overview
  total++;
  if (await check('7. Analytics overview (analytics.overview)', async function() {
    var result = await fetchTRPCQuery('analytics.overview', null, authCookie);
    var data = result && result.data;
    return { ok: !!data, detail: 'Analytics retrieved successfully' };
  })) passed++;

  // 8. Deployments stats
  total++;
  if (await check('8. Deployments stats (deployments.stats)', async function() {
    var result = await fetchTRPCQuery('deployments.stats', null, authCookie);
    var stats = result && result.data;
    return { ok: !!stats, detail: 'Total: ' + (stats && stats.total || 0) + ', Active: ' + (stats && stats.active || 0) };
  })) passed++;

  console.log('\n\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
  var scoreStr = passed + '/' + total + ' checks passed';
  var padding = 28 - scoreStr.length;
  console.log('\u2551  Results: ' + scoreStr + ' '.repeat(padding > 0 ? padding : 0) + '\u2551');
  console.log('\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D');

  if (passed === total) {
    console.log('\n\uD83C\uDF89 All systems operational! Open http://localhost:5173');
  } else if (passed >= 6) {
    console.log('\n\u26A0\uFE0F  Minor issues detected. Check failed items above.');
  } else if (passed >= 1) {
    console.log('\n\u26A0\uFE0F  Server is running. Some checks failed \u2014 see details above.');
  } else {
    console.log('\n\u274C Server not responding. Start it with: pnpm start');
  }

  process.exit(passed === total ? 0 : 1);
}

main().catch(function(err) {
  console.error('\n\u274C Verification failed: ' + err.message);
  console.error('   Is the server running? Start it with: pnpm start');
  process.exit(1);
});
