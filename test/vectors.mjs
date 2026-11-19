// Known answers, from the Rust library (unlinkable-inference) and obscurify.ai:
// the same code or number must always give the same login key.
import { loginKey, readCredential, newAccountCode } from '../lib/account.mjs';
let failed = 0;
const check = (name, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) failed++; };
const code = '5d5e923630b2d631d4a9adc0ed11d01d605bd03d862c3c2cf61cb70e099344d2';
check('an account code', loginKey('RJQDX-WM6PR-2QV5M-8BX5G') === code);
check('typed loosely', loginKey('rjqdx wm6pr 2qv5m 8bx5g') === code);
check('O for 0 and l for 1', readCredential('RJQDX-WM6PR-2QV5M-8BX5G')?.value === readCredential('RJQDX-WM6PR-2QV5M-8BX5G'.replace(/0/g, 'O'))?.value);
check('a 16-digit number', loginKey('1234 5678 9012 3456') === '30e33070b4d4d4e04b7a3ad81d1b6b475690073b6b2b58e343a8d8a984f4c35b');
check('a typo is caught', readCredential('RJQDX-WM6PR-2QV5M-8BX5H') === null);
const made = Array.from({ length: 200 }, newAccountCode);
check('new codes pass their own check', made.every((c) => readCredential(c)?.kind === 'code'));
check('new codes differ', new Set(made).size === made.length);
process.exit(failed ? 1 : 0);
