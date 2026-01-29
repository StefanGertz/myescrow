#!/usr/bin/env node
const API_BASE = process.env.SMOKE_API_BASE ?? 'http://localhost:4000';
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'demo1234';
const USER_NAME = process.env.SMOKE_USER_NAME ?? 'Smoke Tester';
const AMOUNT = Number(process.env.SMOKE_ESCROW_AMOUNT ?? 1500);

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const url = `${API_BASE}${path}`;
  const init = { method, headers: { ...headers }, body };
  if (body && !init.headers['Content-Type']) {
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = new Error(`Request to ${path} failed with ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

async function signup(email) {
  return request('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ name: USER_NAME, email, password: PASSWORD })
  });
}

const authHeaders = (token) => ({ Authorization: `Bearer ${token}` });

async function overview(token) {
  return request('/api/dashboard/overview', {
    headers: authHeaders(token)
  });
}

async function createEscrow(token, payload) {
  return request('/api/dashboard/escrows/create', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload)
  });
}

async function releaseEscrow(token, reference) {
  return request(`/api/dashboard/escrows/${reference}/release`, {
    method: 'POST',
    headers: authHeaders(token)
  });
}

async function walletAction(token, path, amount) {
  return request(`/api/dashboard/wallet/${path}`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ amount })
  });
}

async function listDisputes(token) {
  return request('/api/dashboard/disputes', {
    headers: authHeaders(token)
  });
}

async function listNotifications(token) {
  return request('/api/dashboard/notifications', {
    headers: authHeaders(token)
  });
}

function ensure(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

(async () => {
  const email = `smoke+${Date.now()}@example.com`;
  console.log(`Using API base ${API_BASE}`);
  console.log(`Signing up smoke user ${email}`);
  const signupResult = await signup(email);
  const token = signupResult.token;
  ensure(token, 'Signup response missing token');

  console.log('Fetching overview before creating escrow');
  const before = await overview(token);
  console.log(`Found ${before.activeEscrows?.length ?? 0} active escrows before smoke run`);

  console.log('Creating escrow via /api/dashboard/escrows/create');
  const escrowPayload = {
    title: 'Smoke Contract',
    counterpart: 'Smoke Corp',
    amount: AMOUNT,
    category: 'Automation',
    description: 'Automated smoke test'
  };
  const createResult = await createEscrow(token, escrowPayload);
  ensure(createResult?.reference, 'Escrow creation missing reference');

  console.log('Fetching overview after creating escrow');
  const after = await overview(token);

  const match = after.activeEscrows?.find((escrow) => escrow.id === createResult.reference || escrow.reference === createResult.reference);
  ensure(match, 'Created escrow not present in overview response');

  console.log('Triggering release on created escrow');
  const releaseResult = await releaseEscrow(token, createResult.reference);
  ensure(releaseResult?.success, 'Release endpoint did not return success');

  console.log('Testing wallet top-up and withdraw flows');
  const topupAmount = 250;
  const withdrawAmount = 100;
  const topup = await walletAction(token, 'topup', topupAmount);
  ensure(topup?.success, 'Wallet topup should succeed');
  const withdraw = await walletAction(token, 'withdraw', withdrawAmount);
  ensure(withdraw?.success, 'Wallet withdraw should succeed');

  console.log('Fetching notifications after wallet actions');
  const notifications = await listNotifications(token);
  ensure(Array.isArray(notifications.notifications), 'Notifications response missing list');

  console.log('Listing disputes');
  const disputes = await listDisputes(token);
  ensure(Array.isArray(disputes.disputes), 'Disputes response missing list');

  console.log('Smoke test passed. Created escrow', createResult.reference);
})().catch((error) => {
  console.error('Smoke test failed:', error.message);
  if (error.body) {
    console.error(JSON.stringify(error.body, null, 2));
  }
  process.exit(1);
});
