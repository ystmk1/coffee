// coffee Worker
//   GET /go?amount=4500  → 토스 송금 화면으로 넘겨준다 (후원 QR이 이 주소를 담는다).
//
// 환경변수: BANK, ACCOUNT (secret)  토스 송금 받을 계좌
// 계좌 정보는 코드가 아니라 Cloudflare 환경변수에 둔다. 그래서 확장·웹페이지 소스에는 계좌가 남지 않는다.

const MAX_AMOUNT = 10_000_000;

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

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// 바로 302로 커스텀 스킴에 넘기면 안드로이드 크롬이 막는 경우가 있어서,
// 자동으로 한 번 시도하고 실패하면 누를 수 있는 버튼을 보여주는 작은 페이지를 돌려준다.
function page(link, amount) {
  const href = escapeHtml(link);
  const won = amount.toLocaleString("ko-KR") + "원";
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>토스로 보내기</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    font-family:-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;background:#f4f5f7;color:#191f28;padding:16px;box-sizing:border-box}
  main{background:#fff;border-radius:20px;padding:28px 24px;max-width:360px;width:100%;text-align:center}
  a{display:block;margin-top:20px;background:#0064ff;color:#fff;text-decoration:none;border-radius:14px;padding:16px;font-weight:700;font-size:17px}
  p{color:#6b7684;font-size:14px;line-height:1.5}
  @media (prefers-color-scheme:dark){body{background:#101113;color:#f2f4f6}main{background:#1b1d21}}
</style></head>
<body><main>
  <div style="font-size:44px">☕️</div>
  <h1 style="font-size:20px">${won} 보내기</h1>
  <p>토스가 자동으로 열리지 않으면 아래 버튼을 눌러주세요.<br>토스 앱이 설치된 휴대폰에서만 열려요.<br>금액은 토스에서 바꿔도 돼요.</p>
  <a href="${href}">토스로 보내기</a>
</main>
<script>location.href = ${JSON.stringify(link)};</script>
</body></html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/go") {
      if (!env.BANK || !env.ACCOUNT) return new Response("BANK, ACCOUNT 환경변수가 설정되지 않았어요", { status: 500 });
      const amount = Number(url.searchParams.get("amount"));
      if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_AMOUNT) {
        return new Response("금액이 올바르지 않아요", { status: 400 });
      }
      return new Response(page(tossLink(env, amount), amount), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
};
