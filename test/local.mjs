// Runs worker.js on this PC.
//   node test/local.mjs          → checks the donation pages
//   node test/local.mjs --serve  → serves the worker on http://localhost:8787
import { createServer } from 'node:http';
import worker from '../worker.js';

// in-memory stand-in for the COUPONS KV namespace
const kv = new Map();
const COUPONS = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } };
const env = { BANK: '토스뱅크', ACCOUNT: '0000-0000-0000', COUPONS };
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

  // ---- coupons: license.mjs registers through a local copy of the worker ----
  const { execFile } = await import('node:child_process');
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await worker.fetch(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((ok) => server.listen(0, ok));
  const SERVER = 'http://localhost:' + server.address().port;
  // async: the worker answering it runs in this same process
  const lic = (...a) => new Promise((ok, no) => execFile('node', ['../license/license.mjs', ...a], { encoding: 'utf8', env: { ...process.env, COUPON_SERVER: SERVER } }, (e, out, err) => (e ? no(new Error(err || e.message)) : ok(out))));
  const out = await lic('issue', '--coupon', 'cre8 쿠폰', '--code', 'cre8', '--months', '2');
  check('발급하면 짧은 코드 등록', /쿠폰 코드:\s+CRE8/.test(out) && kv.has('CRE8'));
  const got = await (await call('/coupon?code=cre8')).json();
  check('짧은 코드 → 긴 쿠폰 (대소문자 무관)', got.token === kv.get('CRE8'));
  const cors = await call('/coupon?code=CRE8');
  check('피그마 창에서 읽을 수 있게 CORS', cors.headers.get('access-control-allow-origin') === '*');
  check('없는 코드는 404', (await call('/coupon?code=NOPE1')).status === 404);
  const rnd = (await lic('issue', '--coupon', '인친쿠폰', '--months', '1')).match(/쿠폰 코드:\s+(\S+)/);
  check('코드 안 정하면 9자 랜덤 (XXXX-XXXX)', rnd && /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/.test(rnd[1]) && kv.has(rnd[1]), rnd && rnd[1]);
  const postTok = (token) => worker.fetch(new Request('https://coffee.test/coupon', { method: 'POST', body: JSON.stringify({ token }) }), env);
  const [body, sig] = got.token.split('.');
  const p = JSON.parse(Buffer.from(body, 'base64url'));
  const forged = Buffer.from(JSON.stringify({ ...p, k: 'HIJACK' })).toString('base64url') + '.' + sig;
  check('서명 없는(위조) 쿠폰은 등록 못 함', (await postTok(forged)).status === 403 && !kv.has('HIJACK'));
  p.iat -= 11 * 60e3;
  check('받아 간 쿠폰을 나중에 다시 올려도 안 됨', (await postTok(Buffer.from(JSON.stringify(p)).toString('base64url') + '.' + sig)).status === 403);
  await lic('revoke', '--code', 'CRE8');
  check('취소하면 코드가 사라짐', !kv.has('CRE8') && (await call('/coupon?code=CRE8')).status === 404);
  server.close();
  console.log(fails ? `\n${fails}개 실패` : '\n모두 통과');
  process.exit(fails ? 1 : 0);
}
