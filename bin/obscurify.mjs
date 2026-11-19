#!/usr/bin/env node
// obscurify: the Obscurify jobs that have to run on your own machine.
// Everything else is a plain API request: https://obscurify.ai/api-docs
import { createInterface } from 'node:readline';
import { newAccountCode, loginKey } from '../lib/account.mjs';
import { client } from '../lib/http.mjs';
import * as vouchers from '../lib/vouchers.mjs';

const HELP = `obscurify: the Obscurify jobs that have to run on your own machine.

Account
  signup                 Make a new account. Prints its account code (what you sign in
                         with: keep it) and its API key (sk-obs1_...). The code is made
                         here and never sent.
  api-key                Print the API key (sk-obs1_...) of an account you have. Asks for
                         the account code; the code isn't sent.

Private deposits (blind vouchers: we can't tell which payment funded which account)
  vouchers buy [DOLLARS] --pay btc|lightning|xmr|eth|usdc|usdt [--network NAME]
                         Start a payment, show where to send it, and wait for it. The
                         paid amount comes back as blind vouchers saved on this machine.
                         Lightning needs an amount; the rest take any amount.
                         --network: base, arbitrum, optimism, bsc or tron (default ethereum)
                         --no-wait: show where to pay and stop; collect later
  vouchers collect       Collect vouchers for payments made since (same address, later
                         payments, or a buy you stopped waiting for).
  vouchers list          What this machine holds, and when it can be redeemed.
  vouchers redeem        Deposit the vouchers into an account (asks for its API key, or
                         set OBSCURIFY_API_KEY). Each voucher waits 5 to 60 minutes after
                         it was collected, so the payment and the deposit can't be matched
                         by time. --now skips the wait; --wait stays until all are in.

Affiliates
  affiliate collect [DOLLARS]
                         Take your affiliate credit as blind vouchers (asks for your
                         affiliate number, or set OBSCURIFY_AFFILIATE_NUMBER). Then
                         \`vouchers redeem\` deposits them into any account.

Options
  --json                 Print JSON instead of text
  --api URL              Another Obscurify address, such as the .onion one
  --accept-terms         signup: accept the Terms (https://obscurify.ai/terms) without asking
  -h, --help             This help

Vouchers are money: they live in ~/.local/share/obscurify/<site>/vouchers.json
(OBSCURIFY_WALLET to move it). Don't lose or share that file before redeeming.

Use the API key with any OpenAI- or Anthropic-compatible client:
  base URL https://obscurify.ai/v1, Authorization: Bearer sk-obs1_...
Everything else: https://obscurify.ai/api-docs`;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const VALUE_OPTIONS = ['--api', '--pay', '--network'];
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const words = args.filter((a, i) => !a.startsWith('-') && !VALUE_OPTIONS.includes(args[i - 1]));
const [command, sub, third] = words;
const api = (option('--api') || process.env.OBSCURIFY_API || 'https://obscurify.ai').replace(/\/+$/, '');
const json = flag('--json');

function fail(message) {
  if (json) console.log(JSON.stringify({ error: message }));
  else console.error(message);
  process.exit(1);
}
const note = (s) => { if (!json) console.error(s); };
const print = (text, data) => console.log(json ? JSON.stringify(data) : text);

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) process.stderr.write(s); };
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stderr.write('\n');
      resolve(answer.trim());
    });
  });
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text.trim();
}

/** A secret from the environment, the terminal (not echoed) or standard input. */
async function secret(envName, prompt) {
  if (process.env[envName]) return process.env[envName].trim();
  const value = process.stdin.isTTY ? await ask(prompt, { hidden: true }) : await readStdin();
  if (!value) fail(`Nothing given. Set ${envName} or type it when asked.`);
  return value;
}

const amountArg = (word) => {
  if (word === undefined) return undefined;
  const n = Number(String(word).replace(/^\$/, ''));
  if (!(n > 0)) fail(`"${word}" isn't an amount in dollars.`);
  return n;
};

async function signup() {
  if (!flag('--accept-terms')) {
    if (!process.stdin.isTTY) fail('Accept the Terms of Service (https://obscurify.ai/terms) with --accept-terms.');
    const yes = await ask('Do you accept the Terms of Service (https://obscurify.ai/terms)? [y/N] ');
    if (!/^y(es)?$/i.test(yes)) fail('Not signed up: the terms were not accepted.');
  }
  const call = client(api);
  const code = newAccountCode();
  note('Making your account code (a few seconds)...');
  const key = loginKey(code);
  const made = await call('POST', '/create_account', { accept_tos: true, account_key: key });
  const { token } = await call('POST', '/generate_token', { account_key: key });
  print(`
Account code (save it now: it's the only way to sign in, and Obscurify can't show it to you again):
  ${code}

API key:
  ${token}
${made.starter_credit ? `\nStarter credit: $${made.starter_credit}\n` : ''}
Deposit funds at ${api}/account (sign in with the account code), with POST /deposits,
or privately with \`npx -y @obscurify/cli vouchers buy\`.
Use the key with any OpenAI-compatible client: base URL ${api}/v1`,
  { account_code: code, api_key: token, starter_credit: made.starter_credit ?? null });
}

async function apiKey() {
  const typed = await secret('OBSCURIFY_ACCOUNT_CODE', 'Account code: ');
  let key;
  try { key = loginKey(typed); } catch (e) { fail(e.message); }
  const { token } = await client(api)('POST', '/generate_token', { account_key: key });
  print(token, { api_key: token });
}

function when(ms) {
  const mins = Math.max(1, Math.round((ms - Date.now()) / 60000));
  return `in about ${mins} minute${mins === 1 ? '' : 's'}`;
}

async function voucherCommand() {
  const ctx = vouchers.context(api);
  if (sub === 'buy') {
    const order = await vouchers.buy(ctx, { method: option('--pay'), amount: amountArg(third), network: option('--network') });
    const lines = [`Order ${order.order_id}${order.amount_cents ? ` for ${vouchers.dollars(order.amount_cents)}` : ''}. Send the payment to:`];
    for (const [coin, where] of Object.entries(order.addresses || {})) {
      const howMuch = order.amounts?.[coin];
      lines.push(`  ${coin}${howMuch ? ` (${howMuch})` : ''}: ${where}`);
    }
    if (order.accepts?.length) lines.push(`  Networks: ${order.accepts.map((n) => `${n.label} (${n.tokens.join(', ')})`).join('; ')}`);
    lines.push(order.amount_cents ? '' : '  Any amount, any number of times, for the next hour.');
    if (json) console.log(JSON.stringify(order));
    else console.error(lines.join('\n'));
    if (flag('--no-wait')) { note('Collect it once paid: npx -y @obscurify/cli vouchers collect'); return; }
    note('Waiting for the payment (Ctrl-C to stop; `vouchers collect` picks it up later)...');
    let last = '';
    const got = await vouchers.waitAndCollect(ctx, order.order_id, {
      onTick: (s) => {
        const line = s.funded_cents ? `received ${vouchers.dollars(s.funded_cents)}, confirming...` : 'waiting for the payment...';
        if (line !== last) note(`  ${line}`);
        last = line;
      },
    });
    const w = vouchers.summary(ctx);
    if (got > 0) {
      note(`Collected ${vouchers.dollars(got)} in blind vouchers, saved in ${w.path}.`);
      note(`Deposit them with \`npx -y @obscurify/cli vouchers redeem\` ${w.next_ready_at ? when(w.next_ready_at) : 'now'} (a random wait, so the payment and the deposit can't be matched by time).`);
    } else {
      note('Nothing collected yet. Run `npx -y @obscurify/cli vouchers collect` once the payment confirms.');
    }
    if (json) console.log(JSON.stringify({ collected_cents: got }));
    return;
  }
  if (sub === 'collect') {
    const { total, states } = await vouchers.collect(ctx);
    const open = states.filter((s) => s.status.status !== 'expired').length;
    print(total > 0 ? `Collected ${vouchers.dollars(total)} in blind vouchers.` : `Nothing new to collect${open ? ` (${open} order${open === 1 ? '' : 's'} still open)` : ''}.`,
      { collected_cents: total, open_orders: open });
    return;
  }
  if (sub === 'list') {
    const s = vouchers.summary(ctx);
    print([
      `Vouchers: ${vouchers.dollars(s.held_cents)} (${vouchers.dollars(s.ready_cents)} ready to redeem${s.next_ready_at ? `; the rest ${when(s.next_ready_at)}` : ''})`,
      `Open orders: ${s.open_orders.length}`,
      `Wallet: ${s.path}`,
    ].join('\n'), s);
    return;
  }
  if (sub === 'redeem') {
    let s = vouchers.summary(ctx);
    if (!s.held_cents) { print('No vouchers to redeem.', { redeemed: 0 }); return; }
    const key = await secret('OBSCURIFY_API_KEY', 'API key of the account to deposit into: ');
    if (!key.startsWith('sk-obs1_')) fail('That is not an API key (sk-obs1_...).');
    if (flag('--now')) note('Redeeming now: the deposit can be matched to the payment by time.');
    let total = 0;
    for (;;) {
      const r = await vouchers.redeem(ctx, key, { now: flag('--now') });
      total += r.credited_usd;
      if (r.redeemed) note(`Deposited $${r.credited_usd.toFixed(2)}${r.already_redeemed ? `, ${r.already_redeemed} already used` : ''}${r.invalid ? `, ${r.invalid} invalid` : ''}. Balance: $${Number(r.balance).toFixed(2)}`);
      s = vouchers.summary(ctx);
      if (!s.held_cents || !flag('--wait')) break;
      note(`Waiting to deposit the next voucher ${when(s.next_ready_at)}...`);
      await new Promise((ok) => setTimeout(ok, Math.max(1000, s.next_ready_at - Date.now() + 1000)));
    }
    if (s.held_cents) note(`${vouchers.dollars(s.held_cents)} more can be deposited ${when(s.next_ready_at)} (or now with --now, or keep this running with --wait).`);
    if (json) console.log(JSON.stringify({ deposited_usd: Math.round(total * 100) / 100, still_held_cents: s.held_cents }));
    return;
  }
  fail('vouchers: buy, collect, list or redeem. Run with --help.');
}

async function affiliateCommand() {
  if (sub !== 'collect') fail('affiliate: collect. (Your totals and statement are plain API requests: POST /affiliates/token.)');
  const number = await secret('OBSCURIFY_AFFILIATE_NUMBER', 'Affiliate number: ');
  const ctx = vouchers.context(api);
  const r = await vouchers.affiliateCollect(ctx, number, { amount: amountArg(third) });
  if (!r.total) { print(`No affiliate credit to take${r.available !== undefined ? ` (available: ${vouchers.dollars(r.available)})` : ''}.`, r); return; }
  print(`Took ${vouchers.dollars(r.total)} as blind vouchers. Deposit them into any account with \`npx -y @obscurify/cli vouchers redeem\`.`, r);
}

if (!command || flag('-h') || flag('--help')) {
  console.log(HELP);
  process.exit(command || flag('-h') || flag('--help') ? 0 : 1);
}
try {
  if (command === 'signup') await signup();
  else if (command === 'api-key') await apiKey();
  else if (command === 'vouchers') await voucherCommand();
  else if (command === 'affiliate') await affiliateCommand();
  else fail(`Unknown command "${command}". Run with --help.`);
} catch (e) {
  fail(e.message);
}
