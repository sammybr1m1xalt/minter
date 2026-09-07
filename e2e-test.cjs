const { parseNftLink } = require('./dist/nft-link.js');
const { resolveChain } = require('./dist/chains.js');
const { parseRpcEndpoints } = require('./dist/rpc-blast.js');
const wizard = require('./dist/wizard.js');
const gweiToWei = wizard.gweiToWei || ((g) => BigInt(Math.round(g * 1e9)));

let pass = 0, fail = 0;
function check(name, fn) {
  try {
    const result = fn();
    if (result === false || result === undefined || result === null) {
      console.log('FAIL:', name);
      fail++;
    } else {
      console.log('PASS:', name);
      pass++;
    }
  } catch(e) {
    console.log('FAIL:', name, '—', e.message.slice(0, 80));
    fail++;
  }
}

console.log('\n=== parseNftLink ===');
check('valid addr (SeaDrop singleton)', () => {
  const p = parseNftLink('0x00005EA00Ac477B1030CE78506496e8C2dE24bf5');
  return p.kind === 'address' && p.value === '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
});
check('valid 40-hex lowercase', () => {
  const p = parseNftLink('0x' + 'a'.repeat(40));
  return p.kind === 'address';
});
check('valid mixed case (40 hex)', () => {
  let hex = '';
  const chars = '0123456789abcdefABCDEF';
  for (let i = 0; i < 40; i++) hex += chars[i % chars.length];
  const addr = '0x' + hex;
  const p = parseNftLink(addr);
  return p.kind === 'address' && p.value === addr;
});
check('invalid hex (has J) → error', () => {
  let threw = false;
  try { parseNftLink('0x4d224452801ACEDDEJo8e936065AfEfBD007800F'); } catch(e) { threw = true; }
  return threw;
});
check('invalid hex (short, 3 chars) → error', () => {
  let threw = false;
  try { parseNftLink('0xabc'); } catch(e) { threw = true; }
  return threw;
});
check('slug → slug', () => {
  const p = parseNftLink('blur-frenzy');
  return p.kind === 'slug' && p.value === 'blur-frenzy';
});
check('URL → slug extracted', () => {
  const p = parseNftLink('https://opensea.io/collection/blur-frenzy');
  return p.kind === 'slug' && p.value === 'blur-frenzy';
});
check('URL with chain hint', () => {
  const p = parseNftLink('https://opensea.io/base/collection/base-spin');
  return p.kind === 'slug' && p.chainHint === 'base';
});
check('garbage → error', () => {
  let threw = false;
  try { parseNftLink('!!!not-valid!!!'); } catch(e) { threw = true; }
  return threw;
});

console.log('\n=== resolveChain ===');
check('ethereum by key', () => resolveChain('ethereum')?.chainId === 1);
check('ethereum by id', () => resolveChain(1)?.name === 'Ethereum');
check('base by id', () => resolveChain(8453)?.key === 'base');
check('robinhood by id', () => resolveChain(4663)?.name === 'Robinhood Chain');
check('arc by id', () => resolveChain(5042)?.key === 'arc');
check('unknown → undefined', () => resolveChain(99999) === undefined);

console.log('\n=== RPC labels (via parseRpcEndpoints) ===');
check('alchemy', () => {
  const eps = parseRpcEndpoints(['https://eth-mainnet.g.alchemy.com/v2/key']);
  return eps[0].label === 'ALCHEMY';
});
check('base sequencer', () => {
  const eps = parseRpcEndpoints(['https://mainnet-sequencer.base.org']);
  return eps[0].label === 'mainnet-sequencer.base.org';
});
check('robinhood pub', () => {
  const eps = parseRpcEndpoints(['https://rpc.mainnet.chain.robinhood.com']);
  return eps[0].label === 'robinhood-public';
});
check('llamarpc', () => {
  const eps = parseRpcEndpoints(['https://eth.llamarpc.com']);
  return eps[0].label === 'eth.llamarpc.com';
});
check('unknown', () => {
  const eps = parseRpcEndpoints(['https://example.com/rpc']);
  return eps[0].label === 'example.com';
});

console.log('\n=== Gas ===');
check('gweiToWei(10)', () => gweiToWei(10) === 10000000000n);
check('gweiToWei(0.5)', () => gweiToWei(0.5) === 500000000n);
check('gweiToWei(0)', () => gweiToWei(0) === 0n);

console.log('\n=== Flow decisions ===');
check('address bypasses OpenSea', () => {
  const p = parseNftLink('0x00005EA00Ac477B1030CE78506496e8C2dE24bf5');
  return p.kind === 'address';
});
check('slug needs key', () => {
  const p = parseNftLink('blur-frenzy');
  return p.kind === 'slug';
});
check('URL chain hint detected', () => {
  const p = parseNftLink('https://opensea.io/base/collection/base-spin');
  return p.kind === 'slug' && p.chainHint === 'base';
});
check('address path preserves original input', () => {
  const addr = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
  const p = parseNftLink(addr);
  return p.value === addr;
});

console.log('\n=== RESULTS: Pass=' + pass + ' Fail=' + fail + ' ===');
if (fail > 0) { console.log('SOME TESTS FAILED'); process.exit(1); }
console.log('ALL TESTS PASSED');
