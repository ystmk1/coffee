// coffee Worker
//   GET /                → 후원 페이지: 잔 수(1잔 2,000원 / 5잔 / 10잔) 또는 직접 입력 → QR + "토스로 보내기"
//   GET /go?amount=4500  → 휴대폰: 토스 송금 화면을 바로 연다. PC: 그 금액이 골라진 후원 페이지를 보여 준다.
//   GET /coffee-qr.js    → 후원 페이지가 QR을 그릴 때 쓰는 스크립트
//
// 환경변수: BANK, ACCOUNT (secret)  토스 송금 받을 계좌
// 계좌 정보는 코드가 아니라 Cloudflare 환경변수에 둔다. 후원 페이지에는 계좌가 들어가지 않고,
// 실제로 토스를 여는 /go 페이지에만 들어간다.
import QR_LIB from "./qr-lib.js";

const MAX_AMOUNT = 10_000_000;
const CUP_PRICE = 2000;
const CUPS = [1, 5, 10];

// ---------- 토스 송금 링크 ----------
function tossLink(env, amount) {
  const q = new URLSearchParams({
    amount: String(amount),
    bank: env.BANK,
    accountNo: String(env.ACCOUNT).replace(/\D/g, ""),
    origin: "qr",
  });
  return "supertoss://send?" + q.toString();
}

// 안드로이드는 intent:// 로 열면 크롬이 더 잘 열어 주고, 토스가 없으면 플레이스토어로 보내 준다.
// (https://docs.tosspayments.com/resources/glossary/deep-link 의 Intent 스킴)
const TOSS_PACKAGE = "viva.republica.toss";
const TOSS_STORE = {
  android: "https://play.google.com/store/apps/details?id=" + TOSS_PACKAGE,
  ios: "https://apps.apple.com/kr/app/id839333328",
};
function androidIntent(link) {
  return link.replace(/^supertoss:\/\//, "intent://") + "#Intent;scheme=supertoss;package=" + TOSS_PACKAGE + ";end";
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const won = (n) => n.toLocaleString("ko-KR") + "원";

function deviceOf(request) {
  const ua = request.headers.get("user-agent") || "";
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  return "desktop";
}

const BASE_CSS = `
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;
    font-family:-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;background:#f4f5f7;color:#191f28}
  main{background:#fff;border-radius:24px;padding:28px 24px;max-width:400px;width:100%;text-align:center}
  h1{font-size:21px;margin:8px 0 4px;letter-spacing:-.02em}
  p{color:#6b7684;font-size:14px;line-height:1.5;margin:6px 0}
  .send{display:block;margin-top:16px;background:#0064ff;color:#fff;text-decoration:none;border-radius:14px;padding:16px;font-weight:700;font-size:17px}
  .sub{color:#6b7684;font-size:13px;text-decoration:underline}
  @media (prefers-color-scheme:dark){body{background:#101113;color:#f2f4f6}main{background:#1b1d21}}
`;

// ---------- 휴대폰: 토스를 바로 연다 ----------
// 바로 302로 커스텀 스킴에 넘기면 브라우저가 막는 경우가 있어서,
// 자동으로 한 번 시도하고 실패하면 누를 수 있는 버튼을 보여주는 작은 페이지를 돌려준다.
function openPage(link, amount, device) {
  if (device === "android") link = androidIntent(link);
  const href = escapeHtml(link);
  const store = device === "android" ? TOSS_STORE.android : TOSS_STORE.ios;
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>토스로 보내기</title>
<style>${BASE_CSS}</style></head>
<body><main>
  <div style="font-size:44px">☕️</div>
  <h1>${won(amount)} 보내기</h1>
  <p>토스가 자동으로 열리지 않으면 아래 버튼을 눌러주세요.<br>금액은 토스에서 바꿔도 돼요.</p>
  <a class="send" href="${href}">토스로 보내기</a>
  <p style="margin-top:16px">토스 앱이 없나요? <a class="sub" href="${store}">토스 설치하기</a><br>
    카카오톡·인스타그램 안에서 열었다면 메뉴의 "다른 브라우저로 열기"를 눌러 주세요.</p>
  <p style="margin-top:12px"><a class="sub" href="/?amount=${amount}">다른 금액 고르기</a></p>
</main>
<script>location.href = ${JSON.stringify(link)};</script>
</body></html>`;
}

// ---------- 후원 페이지: 잔 수 / 직접 입력 → QR + 토스로 보내기 ----------
// 계좌는 넣지 않는다. QR과 버튼은 모두 /go?amount= 를 가리키고, 휴대폰에서 열면 그 페이지가 토스를 연다.
function choosePage(amount, device) {
  const mobile = device !== "desktop";
  const cups = CUPS.map((n) => `<button type="button" class="cup" data-amount="${n * CUP_PRICE}"><b>${n}잔</b><span>${won(n * CUP_PRICE)}</span></button>`).join("");
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>커피 한 잔 사 주기</title>
<style>${BASE_CSS}
  .cups{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:18px}
  .cup{border:2px solid #e5e8eb;background:#fff;color:inherit;border-radius:14px;padding:12px 4px;font:inherit;cursor:pointer}
  .cup b{display:block;font-size:16px}
  .cup span{display:block;font-size:13px;color:#6b7684;margin-top:2px}
  .cup[aria-pressed=true]{border-color:#0064ff;background:#e8f3ff}
  .custom{display:flex;align-items:center;gap:8px;margin-top:8px;border:2px solid #e5e8eb;border-radius:14px;padding:0 14px;text-align:left}
  .custom.on{border-color:#0064ff}
  .custom label{font-size:14px;color:#6b7684;white-space:nowrap}
  .custom input{flex:1;min-width:0;border:0;background:none;color:inherit;font:inherit;font-size:16px;padding:12px 0;outline:none;text-align:right}
  .qrbox{margin-top:18px}
  .qr{display:inline-block;padding:10px;background:#fff;border-radius:16px;border:1px solid #e5e8eb;line-height:0}
  .qr svg{width:200px;height:200px}
  .err{color:#f04452}
  @media (prefers-color-scheme:dark){
    .cup{background:#25282d;border-color:#33363b}.cup[aria-pressed=true]{background:#13294b;border-color:#3182f6}
    .custom{border-color:#33363b}.custom.on{border-color:#3182f6}.qr{border-color:#33363b}
  }
</style></head>
<body><main>
  <div style="font-size:44px">☕️</div>
  <h1>개발자에게 커피 한 잔</h1>
  <p>마음에 드셨다면 커피 한 잔으로 응원해 주세요.</p>
  <div class="cups" role="group" aria-label="잔 수">${cups}</div>
  <div class="custom" id="customBox"><label for="custom">직접 입력</label><input id="custom" inputmode="numeric" autocomplete="off" placeholder="0"><span>원</span></div>
  <div class="qrbox" ${mobile ? "hidden" : ""}>
    <div class="qr" id="qr"></div>
    <p>휴대폰 카메라로 찍으면 토스 송금 화면이 열려요</p>
  </div>
  <a class="send" id="send" href="/go?amount=${amount}">토스로 보내기</a>
  <p id="note">${mobile ? "토스 앱이 열려요. 금액은 토스에서 바꿔도 돼요." : "버튼은 토스 앱이 있는 휴대폰에서 열려요."}</p>
</main>
<script src="/coffee-qr.js"></script>
<script>
  const MAX = ${MAX_AMOUNT};
  let amount = ${amount};
  const $ = (id) => document.getElementById(id);
  const cups = [...document.querySelectorAll(".cup")];
  const fmt = (n) => n.toLocaleString("ko-KR") + "원";
  function render() {
    const ok = Number.isInteger(amount) && amount > 0 && amount <= MAX;
    cups.forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.amount === amount)));
    $("customBox").classList.toggle("on", !cups.some((b) => +b.dataset.amount === amount));
    $("send").textContent = ok ? "토스로 " + fmt(amount) + " 보내기" : "금액을 입력해 주세요";
    $("send").style.opacity = ok ? "" : ".4";
    $("send").href = ok ? "/go?amount=" + amount : "#";
    if (window.CoffeeQR && ok) $("qr").innerHTML = CoffeeQR.svg({ text: location.origin + "/go?amount=" + amount, size: 200 });
    history.replaceState(null, "", "/?amount=" + amount);
  }
  cups.forEach((b) => (b.onclick = () => { amount = +b.dataset.amount; $("custom").value = ""; render(); }));
  $("custom").oninput = (e) => {
    const digits = e.target.value.replace(/\\D/g, "").slice(0, 8);
    e.target.value = digits ? Number(digits).toLocaleString("ko-KR") : "";
    amount = digits ? Number(digits) : 0;
    render();
  };
  if (!cups.some((b) => +b.dataset.amount === amount)) $("custom").value = amount.toLocaleString("ko-KR");
  render();
</script>
</body></html>`;
}

const HTML = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" };
const parseAmount = (v, fallback) => {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= MAX_AMOUNT ? n : null;
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const device = deviceOf(request);

    if (url.pathname === "/coffee-qr.js") {
      return new Response(QR_LIB, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400" } });
    }

    if (url.pathname === "/") {
      const amount = parseAmount(url.searchParams.get("amount"), CUP_PRICE) || CUP_PRICE;
      return new Response(choosePage(amount, device), { headers: HTML });
    }

    if (url.pathname === "/go") {
      const amount = parseAmount(url.searchParams.get("amount"), null);
      if (!amount) return new Response("금액이 올바르지 않아요", { status: 400 });
      // PC에서 열면 토스를 열 수 없으니 QR이 있는 후원 페이지를 보여 준다.
      if (device === "desktop") return new Response(choosePage(amount, device), { headers: HTML });
      if (!env.BANK || !env.ACCOUNT) return new Response("BANK, ACCOUNT 환경변수가 설정되지 않았어요", { status: 500 });
      return new Response(openPage(tossLink(env, amount), amount, device), { headers: HTML });
    }

    return new Response("Not found", { status: 404 });
  },
};
