// End to end against a running Obscurify server (default: the dev server on :8097):
//   OBSCURIFY_E2E_API=http://127.0.0.1:8097 npm run e2e
// The money steps need to stand in for a confirmed payment, which only the
// server's database can do: set OBSCURIFY_E2E_SQL to a command that runs one SQL
// statement, e.g. "docker exec -i obscurify-postgres-dev psql -U obscurify -d obscurify_sync -tAX -c".
// A recording proxy sits between the CLI and the server, so the test sees every
// byte that left this machine and can check the account code was never among them.
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const upstream = (process.env.OBSCURIFY_E2E_API || 'http://127.0.0.1:8097').replace(/\/+$/, '');
const cli = fileURLToPath(new URL('../bin/obscurify.mjs', import.meta.url));
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' ' + detail}`);
  if (!ok) failed++;
};

const sent = [];
const proxy = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  sent.push(`${req.method} ${req.url} ${JSON.stringify(req.headers)} ${body}`);
  const forward = {};
  for (const h of ['content-type', 'authorization', 'cookie', 'user-agent']) if (req.headers[h]) forward[h] = req.headers[h];
  const r = await fetch(upstream + req.url, { method: req.method, headers: forward, body: body || undefined, redirect: 'manual' });
  const back = { 'content-type': r.headers.get('content-type') || 'application/json' };
  if (r.headers.get('retry-after')) back['retry-after'] = r.headers.get('retry-after');
  const cookies = r.headers.getSetCookie();
  if (cookies.length) back['set-cookie'] = cookies;
  res.writeHead(r.status, back);
  res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise((ok) => proxy.listen(0, '127.0.0.1', ok));
const api = `http://127.0.0.1:${proxy.address().port}`;

const walletDir = mkdtempSync(join(tmpdir(), 'obscurify-e2e-'));
const wallet = join(walletDir, 'vouchers.json');
async function obscurify(args, input, env = {}) {
  const child = execFile('node', [cli, ...args, '--api', api], { timeout: 120_000, env: { ...process.env, OBSCURIFY_WALLET: wallet, ...env } });
  let out = '', err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  const code = await new Promise((ok) => child.on('close', ok));
  return { code, out: out.trim(), err: err.trim() };
}

// 1. Sign up: a code and an API key come back.
const signup = await obscurify(['signup', '--accept-terms', '--json']);
const made = JSON.parse(signup.out || '{}');
check('signup makes an account', signup.code === 0 && /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/.test(made.account_code || ''), signup.out + signup.err);
check('and gives its API key', /^sk-obs1_/.test(made.api_key || ''), signup.out);

// 2. The code never left this machine; only a 64-hex account key did.
const code = made.account_code || 'none';
const everything = sent.join('\n');
check('the account code was never sent', !everything.includes(code) && !everything.includes(code.replace(/-/g, '')));
check('only a account key was sent', /"account_key":"[0-9a-f]{64}"/.test(everything) && !everything.includes('account_number'), everything.slice(0, 300));

// 3. The API key comes back from the code, however it's typed.
for (const typed of [code, code.toLowerCase().replace(/-/g, ''), code.replace(/-/g, ' ')]) {
  const again = await obscurify(['api-key'], typed + '\n');
  check(`api-key from "${typed}"`, again.code === 0 && again.out === made.api_key, again.out + again.err);
}

// 4. The key works on the API.
const balance = await fetch(upstream + '/get_user_balance', { headers: { Authorization: `Bearer ${made.api_key}` } });
check('the API key works', balance.ok, String(balance.status));

// 4b. More keys: one named key made and revoked with the account code (never sent).
const keyMark = sent.length;
const named = await obscurify(['api-key', '--name', 'CLI test', '--json'], code + '\n');
const namedKey = JSON.parse(named.out || '{}');
check('api-key --name makes another key', named.code === 0 && /^sk-obs1_/.test(namedKey.api_key || '') && namedKey.api_key !== made.api_key, named.out + named.err);
const namedWorks = async () => (await fetch(upstream + '/get_user_balance', { headers: { Authorization: `Bearer ${namedKey.api_key}` } })).ok;
check('  it works', await namedWorks());
const listed = await (await fetch(upstream + '/api_keys', { headers: { Authorization: `Bearer ${made.api_key}` } })).json();
check('  and is listed by name', (listed.api_keys || []).some((k) => k.name === 'CLI test' && k.id === namedKey.id), JSON.stringify(listed).slice(0, 200));
const revoked = await obscurify(['api-key', '--revoke', namedKey.id], code + '\n');
check('api-key --revoke stops it', revoked.code === 0 && !(await namedWorks()), revoked.out + revoked.err);
check('  the code was never sent', sent.slice(keyMark).every((r) => !r.includes(code) && !r.includes(code.replace(/-/g, ''))));

// 5. A typo is caught here, before anything is sent.
const before = sent.length;
const last = code.at(-1);
const typo = code.slice(0, -1) + (last === 'A' ? 'B' : 'A');
const wrong = await obscurify(['api-key'], typo + '\n');
check('a mistyped code is caught on this machine', wrong.code === 1 && /Check each character/.test(wrong.err) && sent.length === before, wrong.err);

// 6. Without a terminal, signing up needs --accept-terms.
const noTerms = await obscurify(['signup']);
check('signup needs the terms accepted', noTerms.code === 1 && /--accept-terms/.test(noTerms.err), noTerms.err);

// 7. Private deposits with blind vouchers.
const sqlCommand = process.env.OBSCURIFY_E2E_SQL;
if (!sqlCommand) {
  console.log('skip voucher and affiliate money steps (set OBSCURIFY_E2E_SQL)');
} else {
  const [bin, ...pre] = sqlCommand.split(' ');
  const sql = (q) => execFileSync(bin, [...pre, q]).toString().trim();
  const mark = sent.length;
  const bought = await obscurify(['vouchers', 'buy', '--pay', 'usdc', '--no-wait', '--json']);
  const order = JSON.parse(bought.out.split('\n')[0] || '{}');
  check('vouchers buy opens an order and shows where to pay', bought.code === 0 && /^0x[0-9a-fA-F]{40}$/.test(order.addresses?.USDC || ''), bought.out + bought.err);
  check('the order carries no account', sent.slice(mark).every((r) => !/authorization|cookie|sk-obs1_/i.test(r)), sent.slice(mark).join('\n').slice(0, 300));

  // Stand in for a confirmed $7.00 USDC payment.
  sql(`INSERT INTO voucher_order_payments (provider_payment_id, order_id, cents) VALUES ('e2e-${order.order_id}', '${order.order_id}', 700)`);
  sql(`UPDATE voucher_orders SET funded_cents = funded_cents + 700 WHERE id = '${order.order_id}'`);
  const signMark = sent.length;
  const collected = await obscurify(['vouchers', 'collect', '--json']);
  check('vouchers collect gets the paid amount', JSON.parse(collected.out || '{}').collected_cents === 700, collected.out + collected.err);
  const held = JSON.parse(readFileSync(wallet, 'utf8')).vouchers;
  check('as vouchers in the wallet ($5 + $2)', held.map((v) => v.cents).sort().join() === '200,500', JSON.stringify(held.map((v) => v.cents)));
  const signRequests = sent.slice(signMark).join('\n');
  check('the finished vouchers were never sent while collecting', held.every((v) => !signRequests.includes(v.code.split('.')[3]) && !signRequests.includes(v.code.split('.')[4])));
  check('the wallet file is private (0600)', (await import('node:fs')).statSync(wallet).mode % 0o1000 === 0o600);

  // Redeeming waits 5 to 60 minutes per voucher unless told not to.
  const env = { OBSCURIFY_API_KEY: made.api_key };
  const early = await obscurify(['vouchers', 'redeem', '--json'], undefined, env);
  check('redeem waits before depositing', JSON.parse(early.out.split('\n').pop() || '{}').deposited_usd === 0, early.out + early.err);
  const copy = readFileSync(wallet, 'utf8');
  const before = await (await fetch(upstream + '/get_user_balance', { headers: { Authorization: `Bearer ${made.api_key}` } })).json();
  const now = await obscurify(['vouchers', 'redeem', '--now', '--json'], undefined, env);
  check('redeem --now deposits $7.00', JSON.parse(now.out.split('\n').pop() || '{}').deposited_usd === 7, now.out + now.err);
  const after = await (await fetch(upstream + '/get_user_balance', { headers: { Authorization: `Bearer ${made.api_key}` } })).json();
  check('the balance went up by $7.00', Math.round((Number(after.balance) - Number(before.balance)) * 100) === 700, JSON.stringify([before, after]));
  writeFileSync(wallet, copy);
  const again = await obscurify(['vouchers', 'redeem', '--now'], undefined, env);
  check('a voucher can only be spent once', /2 vouchers were already used/.test(again.err), again.err);
  // Redeeming by account code instead of API key: same account, the code isn't sent.
  writeFileSync(wallet, copy);
  const byCodeMark = sent.length;
  const byCode = await obscurify(['vouchers', 'redeem', '--now'], undefined, { OBSCURIFY_ACCOUNT_CODE: made.account_code });
  check('redeem takes the account code too', /already used/.test(byCode.err) && /Account balance/.test(byCode.err), byCode.out + byCode.err);
  check('without sending the code', sent.slice(byCodeMark).every((r) => !r.includes(made.account_code) && !r.includes(made.account_code.replace(/-/g, ''))));

  // The usual way: buy waits, and collects as soon as the payment confirms.
  writeFileSync(wallet, JSON.stringify({ orders: [], batches: {}, vouchers: [] }));
  const waiting = obscurify(['vouchers', 'buy', '3', '--pay', 'usdc', '--json']);
  let waitingOrder = null;
  for (let i = 0; i < 100 && !waitingOrder; i++) {
    await new Promise((ok) => setTimeout(ok, 200));
    try { waitingOrder = JSON.parse(readFileSync(wallet, 'utf8')).orders[0]?.order_id || null; } catch {}
  }
  sql(`INSERT INTO voucher_order_payments (provider_payment_id, order_id, cents) VALUES ('e2e-${waitingOrder}', '${waitingOrder}', 300)`);
  sql(`UPDATE voucher_orders SET funded_cents = funded_cents + 300 WHERE id = '${waitingOrder}'`);
  const waited = await waiting;
  check('buy waits for the payment and collects it', waited.code === 0 && JSON.parse(waited.out.split('\n').pop() || '{}').collected_cents === 300, waited.out + waited.err);

  // 8. An affiliate takes credit as blind vouchers.
  const code = `e2e${Date.now().toString(36)}`;
  const joined = await (await fetch(upstream + '/affiliates/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, us_person: false, accept_terms: true }) })).json();
  check('an affiliate joined', !!joined.affiliate_number, JSON.stringify(joined));
  const none = await obscurify(['affiliate', 'collect'], undefined, { OBSCURIFY_AFFILIATE_NUMBER: joined.affiliate_number });
  check('nothing to take before any commission', none.code === 0 && /No affiliate credit/.test(none.out), none.out + none.err);
  sql(`INSERT INTO affiliate_accruals (affiliate_id, day, commission, available_at, status) SELECT id, CURRENT_DATE, 3, CURRENT_DATE, 'available' FROM affiliates WHERE code = '${code}'`);
  writeFileSync(wallet, JSON.stringify({ orders: [], batches: {}, vouchers: [] }));
  // Payouts may be switched off on this server; on for this step only.
  const payoutsWere = sql("SELECT value FROM platform_settings WHERE key = 'affiliate_payouts_enabled'");
  sql("UPDATE platform_settings SET value = 'true' WHERE key = 'affiliate_payouts_enabled'");
  let took;
  try {
    took = await obscurify(['affiliate', 'collect', '2', '--json'], undefined, { OBSCURIFY_AFFILIATE_NUMBER: joined.affiliate_number });
  } finally {
    sql(`UPDATE platform_settings SET value = '${payoutsWere.replace(/'/g, "''")}' WHERE key = 'affiliate_payouts_enabled'`);
  }
  const tookData = JSON.parse(took.out || '{}');
  check('affiliate collect takes $2 as vouchers', took.code === 0 && tookData.total === 200, took.out + took.err);
  const paid = await obscurify(['vouchers', 'redeem', '--now', '--json'], undefined, env);
  check('and they deposit into an account', JSON.parse(paid.out.split('\n').pop() || '{}').deposited_usd === 2, paid.out + paid.err);
  const wrongNumber = await obscurify(['affiliate', 'collect'], undefined, { OBSCURIFY_AFFILIATE_NUMBER: '0000 0000 0000 0000' });
  check('a wrong affiliate number is refused', wrongNumber.code === 1, wrongNumber.out + wrongNumber.err);
}

proxy.close();
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
