# @obscurify/cli

The [Obscurify](https://obscurify.ai) jobs that have to run on your own machine. Everything else is a plain API request: https://obscurify.ai/api-docs

```bash
npx -y @obscurify/cli signup                      # a new account: its account code and API key
npx -y @obscurify/cli api-key                     # the API key of an account you have
npx -y @obscurify/cli vouchers buy 20 --pay xmr   # deposit privately with blind vouchers
npx -y @obscurify/cli vouchers redeem             # put them on an account
npx -y @obscurify/cli affiliate collect           # affiliate credit, as blind vouchers
```

## Account

`signup` makes a new account and prints its **account code** (what you sign in with) and its **API key** (`sk-obs1_...`). `api-key` asks for an account code and prints that account's API key; it takes the 16-digit numbers of older accounts too.

The account code is made here and never sent anywhere. Obscurify only gets a one-way key made from it: Argon2id of the code (salt `obscurify-code-v1`, 64 MiB, 8 passes), then HMAC-SHA256 of the word `login`. That matters because your encrypted chat history is locked with keys made from the code, so not even Obscurify can open it. Making that key is the only reason this needs a tool: with the key, getting the API key is one `POST /generate_token`.

## Private deposits

`POST /deposits` puts a payment straight on your account, so we know which account it funded. Blind vouchers don't:

1. `vouchers buy [DOLLARS] --pay btc|lightning|xmr|eth|usdc|usdt` opens an order with no account attached and shows where to send the payment. It waits, and once the payment confirms it makes fresh vouchers here, has Obscurify sign them **blind** (it signs without seeing them), and unblinds them here. Obscurify never sees a finished voucher before it is redeemed, so it can't tell which payment it came from.
2. `vouchers redeem` deposits them into an account (its API key from `OBSCURIFY_API_KEY`, or typed when asked). Each voucher waits a random 5 to 60 minutes after it was made, so the payment and the deposit can't be matched by time; `--wait` keeps going until all are in, `--now` skips the wait.

`vouchers collect` picks up payments made later (an address takes any number of payments for an hour) or a `buy` you stopped waiting for. `vouchers list` shows what you hold. Card vouchers need Stripe's card form, so they're on https://obscurify.ai/account.

Vouchers are money. They are kept in `~/.local/share/obscurify/<site>/vouchers.json` (readable only by you; `OBSCURIFY_WALLET` moves it). Don't lose or share it before redeeming. For the most privacy, buy and redeem over Tor (`--api` with the .onion address, through `torsocks`).

## Affiliates

`affiliate collect [DOLLARS]` takes your affiliate credit (with its bonus) as blind vouchers, which `vouchers redeem` then deposits into any account. It asks for your affiliate number, or reads `OBSCURIFY_AFFILIATE_NUMBER`. Your totals and statement are plain API requests with a read-only affiliate key (`POST /affiliates/token`).

## Options

| | |
|---|---|
| `--json` | Print JSON, for scripts |
| `--api URL` | Another Obscurify address, such as the .onion one |
| `--accept-terms` | `signup`: accept the [Terms of Service](https://obscurify.ai/terms) without being asked |

## Checking it

The code that matters is in `lib/`: `account.mjs` (account codes and keys, using the audited [`@noble/hashes`](https://github.com/paulmillr/noble-hashes)), `blind-voucher.cjs` (RFC 9474 blind RSA, the same code obscurify.ai runs in the browser) and `vouchers.mjs`. `npm test` checks known answers. `npm run e2e` runs everything against a server through a recording proxy and checks what leaves the machine: the account code never does, orders carry no account, and finished vouchers are never sent before they are redeemed.

## License

MIT
