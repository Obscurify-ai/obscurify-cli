#!/usr/bin/env node
// obscurify: make an Obscurify account and get its API key from a terminal.
// Your account code is made here and never leaves this machine; only its login key is sent.
import { createInterface } from 'node:readline';
import { newAccountCode, loginKey } from '../lib/account.mjs';

const HELP = `obscurify: make an Obscurify account and get its API key.

Your account code is made on this machine and never sent anywhere. Obscurify only
gets its login key, a one-way key made from it.

Usage:
  npx -y @obscurify/cli signup     Make a new account. Prints its account code (what you
                                   sign in with: keep it) and its API key (sk-obs1_...)
  npx -y @obscurify/cli api-key    Print the API key (sk-obs1_...) of an account you have.
                                   Asks for the account's code; the code isn't sent

Options:
  --accept-terms   Accept the Terms of Service (https://obscurify.ai/terms) without asking
  --json           Print JSON instead of text
  --api URL        Another Obscurify address (default https://obscurify.ai)
  -h, --help       This help

The account code is read from standard input when it isn't a terminal:
  echo 'XXXXX-XXXXX-XXXXX-XXXXX' | npx -y @obscurify/cli api-key

Then use the API key with any OpenAI- or Anthropic-compatible client:
  base URL https://obscurify.ai/v1, Authorization: Bearer sk-obs1_...
Docs: https://obscurify.ai/api-docs`;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const command = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '--api');
const api = (option('--api') || process.env.OBSCURIFY_API || 'https://obscurify.ai').replace(/\/+$/, '');
const json = flag('--json');

function fail(message) {
  if (json) console.log(JSON.stringify({ error: message }));
  else console.error(message);
  process.exit(1);
}

async function post(path, body) {
  let res;
  try {
    res = await fetch(api + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'obscurify-cli' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    fail(`Couldn't reach ${api}: ${e.cause?.message || e.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const wait = res.headers.get('retry-after');
    fail((data.error || data.message || `${path} answered ${res.status}`) + (wait ? ` (try again in ${wait} s)` : ''));
  }
  return data;
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) process.stderr.write(s); };
    }
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

const note = (s) => { if (!json) console.error(s); };

async function signup() {
  if (!flag('--accept-terms')) {
    if (!process.stdin.isTTY) fail('Accept the Terms of Service (https://obscurify.ai/terms) with --accept-terms.');
    const yes = await ask('Do you accept the Terms of Service (https://obscurify.ai/terms)? [y/N] ');
    if (!/^y(es)?$/i.test(yes)) fail('Not signed up: the terms were not accepted.');
  }
  const code = newAccountCode();
  note('Making your account code and its login key (a few seconds)...');
  const key = loginKey(code);
  const made = await post('/create_account', { accept_tos: true, account_key: key });
  const { token } = await post('/generate_token', { account_key: key });
  if (json) {
    console.log(JSON.stringify({ account_code: code, api_key: token, starter_credit: made.starter_credit ?? null }));
    return;
  }
  console.log(`
Account code (save it now: it's the only way to sign in, and Obscurify can't show it to you again):
  ${code}

API key:
  ${token}
${made.starter_credit ? `\nStarter credit: $${made.starter_credit}\n` : ''}
Add funds at ${api}/account (sign in with the account code), or with POST /top_ups.
Use the key with any OpenAI-compatible client: base URL ${api}/v1`);
}

async function apiKey() {
  const typed = process.stdin.isTTY ? await ask('Account code: ', { hidden: true }) : await readStdin();
  if (!typed) fail('No account code given.');
  let key;
  try {
    key = loginKey(typed);
  } catch (e) {
    fail(e.message);
  }
  const { token } = await post('/generate_token', { account_key: key });
  console.log(json ? JSON.stringify({ api_key: token }) : token);
}

if (!command || flag('-h') || flag('--help')) {
  console.log(HELP);
  process.exit(command || flag('-h') || flag('--help') ? 0 : 1);
}
if (command === 'signup') await signup();
else if (command === 'api-key') await apiKey();
else fail(`Unknown command "${command}". Run with --help.`);
