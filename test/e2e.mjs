// End to end against a running Obscurify server (default: the dev server on :8097):
//   OBSCURIFY_E2E_API=http://127.0.0.1:8097 npm test
// A recording proxy sits between the CLI and the server, so the test sees every
// byte that left this machine and can check the account code was never among them.
import { execFile } from 'node:child_process';
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
  const r = await fetch(upstream + req.url, { method: req.method, headers: { 'content-type': 'application/json' }, body: body || undefined });
  res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json', ...(r.headers.get('retry-after') ? { 'retry-after': r.headers.get('retry-after') } : {}) });
  res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise((ok) => proxy.listen(0, '127.0.0.1', ok));
const api = `http://127.0.0.1:${proxy.address().port}`;

async function obscurify(args, input) {
  const child = execFile('node', [cli, ...args, '--api', api], { timeout: 120_000 });
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

// 2. The code never left this machine; only a 64-hex login key did.
const code = made.account_code || 'none';
const everything = sent.join('\n');
check('the account code was never sent', !everything.includes(code) && !everything.includes(code.replace(/-/g, '')));
check('only a login key was sent', /"account_key":"[0-9a-f]{64}"/.test(everything) && !everything.includes('account_number'), everything.slice(0, 300));

// 3. The API key comes back from the code, however it's typed.
for (const typed of [code, code.toLowerCase().replace(/-/g, ''), code.replace(/-/g, ' ')]) {
  const again = await obscurify(['api-key'], typed + '\n');
  check(`api-key from "${typed}"`, again.code === 0 && again.out === made.api_key, again.out + again.err);
}

// 4. The key works on the API.
const balance = await fetch(upstream + '/get_user_balance', { headers: { Authorization: `Bearer ${made.api_key}` } });
check('the API key works', balance.ok, String(balance.status));

// 5. A typo is caught here, before anything is sent.
const before = sent.length;
const last = code.at(-1);
const typo = code.slice(0, -1) + (last === 'A' ? 'B' : 'A');
const wrong = await obscurify(['api-key'], typo + '\n');
check('a mistyped code is caught on this machine', wrong.code === 1 && /Check each character/.test(wrong.err) && sent.length === before, wrong.err);

// 6. Without a terminal, signing up needs --accept-terms.
const noTerms = await obscurify(['signup']);
check('signup needs the terms accepted', noTerms.code === 1 && /--accept-terms/.test(noTerms.err), noTerms.err);

proxy.close();
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
