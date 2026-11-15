const { env } = await import('./src/env.js');
let flagErr = '';
let flagVal;
try { flagVal = env().TRENCH_DEBT_ENABLED; } catch (e) { flagErr = String(e).slice(0, 120); }
console.log('ENVCHK flag=' + flagVal + ' err=' + flagErr);
const m = await import('./src/nyatos/debt.js');
await m.oweFor(-1002683458784, 42, 0.5);
console.log('ENVCHK after read=' + JSON.stringify(await m.readDebt(-1002683458784)));
