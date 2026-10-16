// Runs worker.js on this PC.
//   node test/local.mjs          → checks the donation pages
//   node test/local.mjs --serve  → serves the worker on http://localhost:8787
import { createServer } from 'node:http';
import worker from '../worker.js';

const env = { BANK: '토스뱅크', ACCOUNT: '0000-0000-0000' };
const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14) Chrome/131 Mobile',
  pc: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131',
};
const call = (path, ua = UA.pc) => worker.fetch(new Request('https://coffee.test' + path, { headers: { 'user-agent': ua } }), env);

if (process.argv.includes('--serve')) {
  createServer(async (req, res) => {
    const r = await worker.fetch(new Request('http://localhost:8787' + req.url, { headers: req.headers }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
  }).listen(8787, () => console.log('worker on http://localhost:8787'));
} else {
  let fails = 0;
  const check = (label, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`); if (!ok) fails++; };
  const home = await (await call('/')).text();
  check('후원 페이지: 1잔·5잔·10잔', ['1잔', '5잔', '10잔', '2,000원', '10,000원', '20,000원', '직접 입력'].every((s) => home.includes(s)));
  check('후원 페이지에는 계좌가 없음', !home.includes('accountNo') && !home.includes('supertoss') && !home.includes('0000-0000'));
  check('PC에서 /go → 후원 페이지 (QR)', (await (await call('/go?amount=3000')).text()).includes('id="qr"'));
  check('아이폰 /go → 토스 바로 열기', (await (await call('/go?amount=3000', UA.iphone)).text()).includes('supertoss://send?amount=3000'));
  check('안드로이드 /go → intent', (await (await call('/go?amount=3000', UA.android)).text()).includes('intent://send?amount=3000'));
  check('잘못된 금액은 거절', (await call('/go?amount=-1', UA.iphone)).status === 400);
  check('QR 스크립트', (await (await call('/coffee-qr.js')).text()).includes('CoffeeQR'));
  check('다른 주소는 404', (await call('/pro/order')).status === 404);
  console.log(fails ? `\n${fails}개 실패` : '\n모두 통과');
  process.exit(fails ? 1 : 0);
}
