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

// fetch 디자인 시스템 (fetch/ui.css와 같은 토큰). 라이트/다크는 OS를 따른다.
const FONT_LINK = '<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">';
const BASE_CSS = `
  :root{--bg:#fff;--surface:#f5f4f0;--line:#e8e6e0;--line-strong:#949189;--ink:#17160f;--ink-2:#5e5c55;--ink-3:#6f6c64;
    --ball:#d4f542;--on-ball:#17160f;--ball-subtle:#f1fac8;--ball-ink:#4d6100;--focus:#17160f;
    --sans:"Pretendard Variable",Pretendard,-apple-system,"Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif;
    --radius-md:8px;--radius-lg:14px;color-scheme:light dark}
  @media (prefers-color-scheme:dark){:root{--bg:#141412;--surface:#1e1d1a;--line:#2c2b27;--line-strong:#6b6862;--ink:#f3f1ea;--ink-2:#b4b1a8;--ink-3:#8e8b83;
    --ball-subtle:#2a3110;--ball-ink:#d4f542;--focus:#d4f542}}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--surface);color:var(--ink);
    font:400 14px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
  :focus-visible{outline:2px solid var(--focus);outline-offset:2px}
  main{background:var(--bg);border-radius:20px;padding:24px 22px 22px;max-width:400px;width:100%;text-align:center;box-shadow:0 1px 0 var(--line)}
  .brand{display:inline-flex;align-items:center;gap:6px;font:700 15px/1 var(--sans);letter-spacing:-.03em;color:var(--ink)}
  .brand i{width:8px;height:8px;border-radius:50%;background:var(--ball);box-shadow:0 0 0 1.5px var(--ink)}
  .dog{width:112px;height:112px;margin:10px auto 0;display:block}
  .dog .tail{transform-box:fill-box;transform-origin:0 100%;animation:wag .32s ease-in-out infinite alternate}
  .dog .head{transform-box:fill-box;transform-origin:50% 90%;animation:tilt 2.4s ease-in-out infinite}
  .dog .eyes{transform-box:fill-box;transform-origin:50% 50%;animation:blink 3.8s ease-in-out infinite}
  .dog .sweat{animation:sweat 1.6s ease-in infinite}
  @keyframes wag{from{transform:rotate(-16deg)}to{transform:rotate(20deg)}}
  @keyframes blink{0%,88%,100%{transform:scaleY(1)}91%{transform:scaleY(.08)}94%{transform:scaleY(1)}}
  @keyframes sweat{0%{opacity:0;transform:translate(0,-2px) scale(.7)}25%{opacity:1;transform:none}80%{opacity:1;transform:translate(2px,6px)}100%{opacity:0;transform:translate(3px,10px)}}
  @keyframes tilt{0%,30%{transform:rotate(0)}45%,75%{transform:rotate(-8deg)}90%,100%{transform:rotate(0)}}
  h1{font:800 22px/1.3 var(--sans);letter-spacing:-.03em;margin:6px 0 4px}
  p{color:var(--ink-2);margin:6px 0}
  .caption{font-size:12px;color:var(--ink-3)}
  .send{display:block;margin-top:16px;background:var(--ball);color:var(--on-ball);text-decoration:none;border-radius:var(--radius-lg);
    padding:16px;font:800 17px/1.2 var(--sans);letter-spacing:-.02em}
  .send:hover{filter:brightness(.96)}
  .sub{color:var(--ink-2);text-decoration:underline;text-underline-offset:3px}
  @media (prefers-reduced-motion:reduce){*{animation:none!important}}
`;

// fetch 강아지 (확장의 후원 카드와 같은 그림). 대두, 늘어진 귀, 콧잔등, 울망울망 눈이 깜빡이고 땀방울.
const P = { body: "#dba468", ear: "#9a5f34", snout: "#f6dcb2", ink: "#24170f" };
const DOG = `<svg class="dog" id="dog" viewBox="0 0 120 124" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <g class="tail"><path d="M74 104 Q90 102 93 88" stroke="${P.body}" stroke-width="6.5" stroke-linecap="round" fill="none"/></g>
    <path d="M43 84 C43 78 50 75 60 75 C70 75 77 78 77 84 L77 108 C77 114 72 117 60 117 C48 117 43 114 43 108 Z" fill="${P.body}"/>
    <ellipse cx="60" cy="93" rx="9" ry="12" fill="${P.snout}"/>
    <path d="M51 98 L51 115" stroke="${P.ear}" stroke-width="1.4" stroke-linecap="round" opacity=".35"/>
    <path d="M69 98 L69 115" stroke="${P.ear}" stroke-width="1.4" stroke-linecap="round" opacity=".35"/>
    <ellipse cx="50" cy="117.5" rx="7" ry="4.2" fill="${P.ear}"/><ellipse cx="70" cy="117.5" rx="7" ry="4.2" fill="${P.ear}"/>
    <g transform="translate(60 52) scale(1.3) translate(-60 -52)"><g class="head">
      <path d="M39 21 C30 18 21 26 21 43 C21 59 24 71 30 72.5 C36 73.5 38.5 65 38.5 53 Z" fill="${P.ear}"/>
      <path d="M81 21 C90 18 99 26 99 43 C99 59 96 71 90 72.5 C84 73.5 81.5 65 81.5 53 Z" fill="${P.ear}"/>
      <circle cx="60" cy="46" r="29" fill="${P.body}"/>
      <path d="M55.5 17.6 Q60 16.8 64.5 17.6 L62.8 40 Q60 41.2 57.2 40 Z" fill="#e9bd85"/>
      <path d="M57.2 39.5 Q60 38.2 62.8 39.5 L64.6 51 Q72.5 52.5 76.5 60 Q78.5 70.5 60 75 Q41.5 70.5 43.5 60 Q47.5 52.5 55.4 51 Z" fill="${P.snout}"/>
      <path d="M57.6 42 Q56.4 47 55.4 51 M62.4 42 Q63.6 47 64.6 51" stroke="${P.ear}" stroke-width=".9" stroke-linecap="round" fill="none" opacity=".35"/>
      <ellipse cx="38" cy="59" rx="5" ry="3" fill="#ff9aa8" opacity=".5"/><ellipse cx="82" cy="59" rx="5" ry="3" fill="#ff9aa8" opacity=".5"/>
      <path d="M53.6 54.2 Q60 51.4 66.4 54.2 Q65.6 59.6 60 60.8 Q54.4 59.6 53.6 54.2 Z" fill="${P.ink}"/><ellipse cx="58" cy="54.4" rx="2.2" ry="1" fill="#fff" opacity=".35"/>
      <path d="M60 60.8 v2.4 M54.5 64.6 q2.75 2.6 5.5 0 q2.75 2.6 5.5 0" stroke="${P.ink}" stroke-width="1.6" fill="none" stroke-linecap="round"/>
      <g class="brow" stroke="${P.ink}" stroke-width="2" stroke-linecap="round" fill="none"><path d="M37 33 Q43 27 50 30"/><path d="M70 30 Q77 27 83 33"/></g>
      <g class="eyes">
        <circle cx="45.5" cy="44" r="9" fill="${P.ink}"/><circle cx="74.5" cy="44" r="9" fill="${P.ink}"/>
        <circle cx="48.5" cy="40.5" r="3.4" fill="#fff"/><circle cx="43" cy="48" r="1.6" fill="#fff"/>
        <circle cx="77.5" cy="40.5" r="3.4" fill="#fff"/><circle cx="72" cy="48" r="1.6" fill="#fff"/>
      </g>
      <path d="M37 50 q8.5 6 17 0" stroke="#7cc4ff" stroke-width="1.4" fill="none" opacity=".8"/>
      <path d="M66 50 q8.5 6 17 0" stroke="#7cc4ff" stroke-width="1.4" fill="none" opacity=".8"/>
      <g class="sweat"><path d="M90 14 C94.5 20 94.5 24.5 90 24.5 C85.5 24.5 85.5 20 90 14Z" fill="#4aa8ff"/><path d="M97 22 C100 26 100 29 97 29 C94 29 94 26 97 22Z" fill="#4aa8ff" opacity=".8"/></g>
    </g></g>
  </svg>`;

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
<title>토스로 보내기 · fetch</title>
${FONT_LINK}
<style>${BASE_CSS}</style></head>
<body><main>
  <span class="brand"><i></i>fetch</span>
  ${DOG}
  <h1>${won(amount)} 보내기</h1>
  <p>토스가 자동으로 열리지 않으면 아래 버튼을 눌러 주세요.<br>금액은 토스에서 바꿔도 돼요.</p>
  <a class="send" href="${href}">토스로 보내기</a>
  <p class="caption" style="margin-top:16px">토스 앱이 없나요? <a class="sub" href="${store}">토스 설치하기</a><br>
    카카오톡·인스타그램 안에서 열었다면 메뉴의 "다른 브라우저로 열기"를 눌러 주세요.</p>
  <p class="caption" style="margin-top:10px"><a class="sub" href="/?amount=${amount}">다른 금액 고르기</a></p>
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
<title>커피 한 잔 사 주기 · fetch</title>
${FONT_LINK}
<style>${BASE_CSS}
  .cups{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:18px}
  .cup{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:var(--radius-lg);padding:12px 4px;font:inherit;cursor:pointer}
  .cup:hover{background:var(--surface)}
  .cup b{display:block;font:800 17px/1.3 var(--sans);letter-spacing:-.02em}
  .cup span{display:block;font-size:13px;color:var(--ink-3);margin-top:2px}
  .cup[aria-pressed=true]{background:var(--ball-subtle);border-color:var(--ink);box-shadow:inset 0 0 0 1px var(--ink)}
  .cup[aria-pressed=true] span{color:var(--ink-2)}
  .custom{display:flex;align-items:center;gap:8px;margin-top:8px;background:var(--surface);border:1px solid transparent;border-radius:var(--radius-lg);padding:0 16px;text-align:left}
  .custom.on{border-color:var(--ink);box-shadow:inset 0 0 0 1px var(--ink)}
  .custom label{font-size:14px;color:var(--ink-2);white-space:nowrap;font-weight:600}
  .custom input{flex:1;min-width:0;border:0;background:none;color:var(--ink);font:700 17px/1 var(--sans);padding:14px 0;outline:none;text-align:right}
  .custom input::placeholder{color:var(--ink-3)}
  .qrbox{margin-top:18px}
  .qr{display:inline-block;padding:10px;background:#fff;border-radius:var(--radius-lg);border:1px solid var(--line);line-height:0}
  .qr svg{width:196px;height:196px}
  .send[aria-disabled=true]{opacity:.45;pointer-events:none}
</style></head>
<body><main>
  <span class="brand"><i></i>fetch</span>
  ${DOG}
  <h1>개발자에게 커피 한 잔</h1>
  <p>fetch가 마음에 드셨다면 커피 한 잔으로 응원해 주세요.</p>
  <div class="cups" role="group" aria-label="잔 수">${cups}</div>
  <div class="custom" id="customBox"><label for="custom">직접 입력</label><input id="custom" inputmode="numeric" autocomplete="off" placeholder="0"><span>원</span></div>
  <div class="qrbox" ${mobile ? "hidden" : ""}>
    <div class="qr" id="qr"></div>
    <p class="caption">휴대폰 카메라로 찍으면 토스 송금 화면이 열려요</p>
  </div>
  <a class="send" id="send" href="/go?amount=${amount}">토스로 보내기</a>
  <p class="caption" id="note">${mobile ? "토스 앱이 열려요. 금액은 토스에서 바꿔도 돼요." : "버튼은 토스 앱이 있는 휴대폰에서 열려요."}</p>
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
    $("send").setAttribute("aria-disabled", String(!ok));
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
