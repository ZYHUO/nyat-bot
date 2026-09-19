const { readDebt } = await import('./src/nyatos/debt.js');
const r = await readDebt(-1004449419602);
console.log('FD3 ' + JSON.stringify(r));
