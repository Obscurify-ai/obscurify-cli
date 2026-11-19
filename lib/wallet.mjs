// The voucher wallet: open orders, blinded batches waiting for a signature,
// and finished vouchers. Vouchers are bearer money, so the file is private to
// this user (0600). One file per Obscurify address.
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function walletPath(api) {
  if (process.env.OBSCURIFY_WALLET) return process.env.OBSCURIFY_WALLET;
  const base = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  const host = new URL(api).host.replace(/[^a-zA-Z0-9.-]/g, '_');
  return join(base, 'obscurify', host, 'vouchers.json');
}

export function load(path) {
  try {
    const w = JSON.parse(readFileSync(path, 'utf8'));
    return { orders: w.orders || [], batches: w.batches || {}, vouchers: w.vouchers || [] };
  } catch (e) {
    if (e.code === 'ENOENT') return { orders: [], batches: {}, vouchers: [] };
    throw new Error(`Can't read the voucher wallet at ${path}: ${e.message}`);
  }
}

/** Written to a temporary file and renamed, so a crash never leaves half a wallet. */
export function save(path, wallet) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(wallet, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
