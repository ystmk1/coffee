// Runs worker.js on this PC.
//   node test/local.mjs          → checks the donation link page
//   node test/local.mjs --serve  → serves the worker on http://localhost:8787
import { createServer } from 'node:http';
import worker from '../worker.js';

const env = { BANK: '카카오뱅크', ACCOUNT: '3333000000000' };
const call = (path) => worker.fetch(new Request('https://coffee.test' + path), env);

if (process.argv.includes('--serve')) {
  createServer(async (req, res) => {
    const r = await worker.fetch(new Request('http://localhost:8787' + req.url), env);
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
  }).listen(8787, () => console.log('worker on http://localhost:8787'));
} else {
  let fails = 0;
  const check = (label, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`); if (!ok) fails++; };
  const html = await (await call('/go?amount=3000')).text();
  check('/go 송금 페이지', html.includes('supertoss://send?amount=3000') && html.includes('3,000원 보내기'));
  check('잘못된 금액은 거절', (await call('/go?amount=-1')).status === 400);
  check('다른 주소는 404', (await call('/pro/order')).status === 404);
  console.log(fails ? `\n${fails}개 실패` : '\n모두 통과');
  process.exit(fails ? 1 : 0);
}
