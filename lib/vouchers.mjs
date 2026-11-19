// Blind vouchers from the terminal: pay without tying the payment to your account.
//
// buy:     start an order (no account, no key), show where to pay, wait for it.
// collect: blind fresh vouchers here, have the server sign them blind, unblind
//          them here. The server never sees the finished vouchers before they
//          are redeemed, so it can't tell which payment they came from.
// redeem:  add vouchers to an account (needs its API key), each after a random
//          wait, so the time of payment and the time of credit can't be matched.
import { createRequire } from 'node:module';
import { load, save, walletPath } from './wallet.mjs';
import { client, ApiError } from './http.mjs';

const V = createRequire(import.meta.url)('./blind-voucher.cjs');
const MAX_PER_SIGN = 64;
const MAX_PER_REDEEM = 20;
const MIN_DELAY_MS = 5 * 60 * 1000;
const MAX_DELAY_MS = 60 * 60 * 1000;
const POLL_MS = 10 * 1000;
const METHODS = { btc: 'BTC', lightning: 'Lightning', xmr: 'XMR', eth: 'ETH', usdc: 'USDC', usdt: 'USDT' };

const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
const delay = () => MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);

/** Largest values first; the 1-2-5 series makes this exact. */
function split(cents, keys) {
  const parts = [];
  for (const key of [...keys].sort((a, b) => b.denomination_cents - a.denomination_cents)) {
    while (cents >= key.denomination_cents) {
      parts.push(key);
      cents -= key.denomination_cents;
    }
  }
  if (cents > 0) throw new Error(`${dollars(cents)} can't be made from voucher values.`);
  return parts;
}

async function blindBatch(cents, keys) {
  return Promise.all(split(cents, keys).map(async (key) => {
    const b = await V.blind({ n: key.n, e: key.e });
    return { cents: key.denomination_cents, keyId: key.key_id, key: { n: key.n, e: key.e }, secret: b.secret, blinded: b.blindedMessage };
  }));
}

/** Sign a saved batch in chunks and unblind it; returns finished voucher codes. */
async function signBatch(call, path, batch) {
  const codes = [];
  for (const part of chunks(batch, MAX_PER_SIGN)) {
    const res = await call('POST', path, {
      vouchers: part.map((p) => ({ denomination_cents: p.cents, key_id: p.keyId, blinded_message: p.blinded })),
    });
    part.forEach((p, i) => {
      const sig = V.finalize(p.key, p.secret, res.blind_signatures[i]);
      codes.push({ code: V.voucherCode(p.cents, p.keyId, p.secret, sig), cents: p.cents });
    });
  }
  return codes;
}

function addVouchers(wallet, codes, source) {
  for (const v of codes) wallet.vouchers.push({ ...v, source, redeem_after: Date.now() + delay() });
}

export function context(api, out) {
  const path = walletPath(api);
  // Order calls carry no account: no key, no cookie.
  return { api, path, out, call: client(api) };
}

/** Start an order and print where to pay. */
export async function buy(ctx, { method, amount, network }) {
  const payment_method = METHODS[String(method || '').toLowerCase()];
  if (!payment_method) {
    throw new Error(`Pay with one of: ${Object.keys(METHODS).join(', ')}. (Card vouchers are on ${ctx.api}/account.)`);
  }
  const body = { payment_method };
  if (amount != null) body.amount_cents = Math.round(amount * 100);
  if (network) body.network = network;
  if (payment_method === 'Lightning' && body.amount_cents == null) throw new Error('Lightning needs an amount, such as `vouchers buy 20 --pay lightning`.');
  const order = await ctx.call('POST', '/vouchers/orders', body);
  const wallet = load(ctx.path);
  wallet.orders.push({
    order_id: order.order_id, method: payment_method, amount_cents: order.amount_cents ?? null,
    addresses: order.addresses || null, amounts: order.amounts || null, network: order.network || null,
    created_at: Date.now(),
  });
  save(ctx.path, wallet);
  return order;
}

/** Check open orders; collect vouchers for whatever has been paid. Returns what was collected. */
export async function collect(ctx, { only } = {}) {
  const wallet = load(ctx.path);
  let keys = null;
  let total = 0;
  const states = [];
  for (const order of wallet.orders.filter((o) => !only || o.order_id === only)) {
    let status;
    try {
      status = await ctx.call('GET', `/vouchers/orders/${encodeURIComponent(order.order_id)}`);
    } catch (e) {
      if (e.status === 404) { order.gone = true; continue; }
      throw e;
    }
    order.funded_cents = status.funded_cents;
    order.status = status.status;
    states.push({ order, status });
    if (!wallet.batches[order.order_id] && status.available_cents > 0) {
      keys ||= (await ctx.call('GET', '/vouchers/keys')).keys;
      wallet.batches[order.order_id] = await blindBatch(status.available_cents, keys);
      save(ctx.path, wallet); // kept before sending, so a lost reply can be sent again
    }
    const batch = wallet.batches[order.order_id];
    if (!batch) continue;
    try {
      const codes = await signBatch(ctx.call, `/vouchers/orders/${encodeURIComponent(order.order_id)}/sign`, batch);
      addVouchers(wallet, codes, order.order_id);
      total += codes.reduce((s, v) => s + v.cents, 0);
    } catch (e) {
      // A rejected batch (keys changed, already collected) is rebuilt next time.
      if (!(e instanceof ApiError) || ![400, 409].includes(e.status)) { save(ctx.path, wallet); throw e; }
    }
    delete wallet.batches[order.order_id];
    save(ctx.path, wallet);
  }
  // Orders that can't take payments any more and have nothing left go.
  wallet.orders = wallet.orders.filter((o) => !o.gone && !(o.status === 'expired' && !wallet.batches[o.order_id]));
  save(ctx.path, wallet);
  return { total, states };
}

/** Poll one order until something is collected, it expires, or the time runs out. */
export async function waitAndCollect(ctx, orderId, { minutes = 120, onTick } = {}) {
  const until = Date.now() + minutes * 60 * 1000;
  while (Date.now() < until) {
    const { total, states } = await collect(ctx, { only: orderId });
    if (total > 0) return total;
    const status = states[0]?.status;
    if (!status || status.status === 'expired') return 0;
    onTick?.(status);
    await sleep(POLL_MS);
  }
  return 0;
}

export function summary(ctx) {
  const wallet = load(ctx.path);
  const now = Date.now();
  const held = wallet.vouchers.reduce((s, v) => s + v.cents, 0);
  const due = wallet.vouchers.filter((v) => v.redeem_after <= now).reduce((s, v) => s + v.cents, 0);
  const next = wallet.vouchers.filter((v) => v.redeem_after > now).map((v) => v.redeem_after).sort((a, b) => a - b)[0] || null;
  return { path: ctx.path, held_cents: held, ready_cents: due, next_ready_at: next, open_orders: wallet.orders, waiting_batches: Object.keys(wallet.batches).length };
}

/** Redeem vouchers to the account of `apiKey`: the ones whose wait is over, or all with `now`. */
export async function redeem(ctx, apiKey, { now = false } = {}) {
  const call = client(ctx.api, { headers: { Authorization: `Bearer ${apiKey}` } });
  const wallet = load(ctx.path);
  const ready = wallet.vouchers.filter((v) => now || v.redeem_after <= Date.now());
  let credited = 0, already = 0, invalid = 0, balance = null, proUntil = null;
  for (const part of chunks(ready, MAX_PER_REDEEM)) {
    const res = await call('POST', '/vouchers/redeem', { vouchers: part.map((v) => v.code) });
    const done = new Set(part.map((v) => v.code));
    res.results.forEach((r) => {
      if (r.status === 'credited') credited += r.amount_usd;
      else if (r.status === 'already_redeemed') already++;
      else invalid++;
    });
    balance = res.balance;
    proUntil = res.pro_access_until || proUntil;
    const fresh = load(ctx.path);
    fresh.vouchers = fresh.vouchers.filter((v) => !done.has(v.code));
    save(ctx.path, fresh);
  }
  return { redeemed: ready.length, credited_usd: Math.round(credited * 100) / 100, already_redeemed: already, invalid, balance, pro_access_until: proUntil };
}

/** An affiliate's credit payout, as blind vouchers in this wallet. */
export async function affiliateCollect(ctx, affiliateNumber, { amount } = {}) {
  const login = await fetch(ctx.api + '/affiliates/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'obscurify-cli' },
    body: JSON.stringify({ affiliate_number: affiliateNumber }),
  });
  if (!login.ok) {
    const d = await login.json().catch(() => ({}));
    throw new ApiError(d.error || 'Unknown affiliate number', login.status);
  }
  const cookie = (login.headers.getSetCookie?.() || [login.headers.get('set-cookie') || ''])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('affiliate_session='));
  if (!cookie) throw new Error('Signing in as an affiliate started no session.');
  const call = client(ctx.api, { headers: { Cookie: cookie } });
  try {
    const wallet = load(ctx.path);
    const pendingKey = 'affiliate-payout';
    if (!wallet.batches[pendingKey]) {
      const s = await call('GET', '/affiliate/api/summary');
      const available = s.balances?.credit_available_cents ?? 0;
      const cents = amount != null ? Math.round(amount * 100) : available;
      if (cents <= 0) return { total: 0, available };
      if (cents > available) throw new Error(`You can take up to ${dollars(available)} now.`);
      const keys = (await call('GET', '/affiliate/api/voucher-keys')).keys;
      const batch = await blindBatch(cents, keys);
      if (batch.length > MAX_PER_SIGN) throw new Error('That amount needs too many vouchers; take less at a time.');
      wallet.batches[pendingKey] = batch;
      save(ctx.path, wallet);
    }
    let codes;
    try {
      codes = await signBatch(call, '/affiliate/vouchers/sign', wallet.batches[pendingKey]);
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) { delete wallet.batches[pendingKey]; save(ctx.path, wallet); }
      throw e;
    }
    addVouchers(wallet, codes, 'affiliate');
    delete wallet.batches[pendingKey];
    save(ctx.path, wallet);
    return { total: codes.reduce((s, v) => s + v.cents, 0) };
  } finally {
    await call('POST', '/affiliates/logout').catch(() => {});
  }
}

export { dollars };
