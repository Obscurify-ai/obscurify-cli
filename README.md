# @obscurify/cli

Make an [Obscurify](https://obscurify.ai) account and get its API key from your terminal.

```bash
npx -y @obscurify/cli signup
```

It prints a new **account code** and the account's **API key**:

```text
Account code (save it now: it's the only way to sign in, and Obscurify can't show it to you again):
  RJQDX-WM6PR-2QV5M-8BX5G

API key:
  sk-obs1_...
```

Already have an account? Get its API key back:

```bash
npx -y @obscurify/cli api-key
```

## Your account code never leaves your machine

The account code is made here, from your computer's random number generator, and is never sent anywhere. Obscurify only gets its **login key**: Argon2id of the code (salt `obscurify-code-v1`, 64 MiB, 8 passes), then HMAC-SHA256 of the word `login`. The login key can't be turned back into the code. That matters because your encrypted chat history is locked with keys made from the code, so not even Obscurify can open it.

All of it is in [`lib/account.mjs`](lib/account.mjs), about 60 lines, using the audited [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) and nothing else. The test (`npm test`) runs it against a server through a recording proxy and checks that the code is never among the bytes sent.

## Options

| | |
|---|---|
| `--accept-terms` | Accept the [Terms of Service](https://obscurify.ai/terms) without being asked (needed when there's no terminal) |
| `--json` | Print JSON, for scripts |
| `--api URL` | Another Obscurify address, such as the .onion one |

Without a terminal, `api-key` reads the code from standard input:

```bash
echo 'RJQDX-WM6PR-2QV5M-8BX5G' | npx -y @obscurify/cli api-key
```

Accounts made before account codes have a 16-digit account number; `api-key` takes those too.

## Using the key

Any OpenAI- or Anthropic-compatible client: base URL `https://obscurify.ai/v1`, `Authorization: Bearer sk-obs1_...`. API reference: https://obscurify.ai/api-docs. Doing it without this tool: https://obscurify.ai/tutorials/account_keys

## License

MIT
