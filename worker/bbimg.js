/**
 * ================================================================
 * bbimg — BigBasket Image Search API (Cloudflare Worker)
 * ================================================================
 * DEPLOY (2 min):
 *  1. dash.cloudflare.com → Workers & Pages → Create Application → Create Worker
 *  2. Naam: bbimg → Deploy
 *  3. Edit Code → ye poora code paste karo → Save & Deploy
 *  4. URL copy karo: https://bbimg.<subdomain>.workers.dev
 *  5. GharApp Image Factory app me "BigBasket worker URL" me paste karo
 *
 * ENDPOINT: GET /search?q=lauki → {"items":[{"name","brand","img","w"}]}
 * Free tier: 100,000 requests/day — kaafi hai.
 * ================================================================
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const HOME = "https://www.bigbasket.com/";
const API = (q) => `https://www.bigbasket.com/listing-svc/v2/products?type=ps&slug=${encodeURIComponent(q)}&page=1&bucket_id=1`;
// Delhi NCR location — koi bhi valid pincode chalega
const LOC = "bb_location=110001; bb_pincode=110001; bb_city=New Delhi; bb_lat=28.6139; bb_lon=77.2090";

let jar = ""; // global cookie cache (worker isolate warm rehta hai)

async function refreshJar() {
  const r = await fetch(HOME, { headers: { "User-Agent": UA, Cookie: LOC }, cf: { cacheTtl: 0 } });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  const map = {};
  for (const line of sc) {
    const p = line.split(";")[0];
    const i = p.indexOf("=");
    if (i > 0) map[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  jar = Object.entries(map).map(([k, v]) => `${k}=${v}`).join("; ");
  return jar;
}

async function bbSearch(q) {
  const call = () =>
    fetch(API(q), {
      headers: {
        "User-Agent": UA,
        Cookie: jar + "; " + LOC,
        "x-channel": "BB-WEB",
        "x-entry-context": "bb-b2c",
        "x-entry-context-id": "100",
        Referer: "https://www.bigbasket.com/ps/?q=" + encodeURIComponent(q),
      },
    });
  if (!jar) await refreshJar();
  let r = await call();
  if (r.status !== 200) { await refreshJar(); r = await call(); }
  const d = await r.json();
  const prods = ((d.tabs || [])[0]?.product_info?.products) || [];
  return prods.slice(0, 12)
    .map((p) => ({
      name: (p.desc || "").trim(),
      brand: p.brand?.name || "",
      img: p.images?.[0]?.l || p.images?.[0]?.m || p.images?.[0]?.s || "",
      w: (p.w || "").trim(),
    }))
    .filter((x) => x.name && x.img);
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const u = new URL(req.url);
    try {
      if (u.pathname === "/search") {
        const q = (u.searchParams.get("q") || "").trim();
        if (q.length < 2) return Response.json({ items: [] }, { headers: CORS });
        const items = await bbSearch(q);
        return Response.json({ items, q }, { headers: CORS });
      }
      return Response.json({ ok: true, service: "bbimg", usage: "/search?q=lauki" }, { headers: CORS });
    } catch (e) {
      return Response.json({ error: String(e).slice(0, 300) }, { status: 500, headers: CORS });
    }
  },
};
