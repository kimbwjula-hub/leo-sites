// Nitro Vendas — API de dados (Cloudflare Pages Functions + D1, binding "DB")
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
let ready = false;
async function init(db) {
  if (ready) return;
  await db.prepare("CREATE TABLE IF NOT EXISTS docs (ws TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (ws, k))").run();
  ready = true;
}
// Acesso aberto: quem abre o site usa sempre o mesmo banco (o principal, com mais empresas).
const PUB = "publico0000000000000000000000000";
let SHARED = "";
async function sharedWs(db) {
  if (SHARED) return SHARED;
  const c = await db.prepare("SELECT v FROM docs WHERE ws = '_cfg' AND k = 'shared'").first();
  if (c && c.v) return (SHARED = c.v);
  const r = await db.prepare("SELECT ws, SUM(LENGTH(v)) n FROM docs WHERE k LIKE 'chunk:%' AND ws <> '_cfg' GROUP BY ws ORDER BY n DESC LIMIT 1").first();
  const w = r && r.ws ? r.ws : PUB;
  await db.prepare("INSERT OR REPLACE INTO docs (ws, k, v, updated) VALUES ('_cfg', 'shared', ?, ?)").bind(w, Date.now()).run();
  return (SHARED = w);
}
export async function onRequest({ request, env, params }) {
  const db = env.DB;
  if (!db) return J({ error: "sem_banco" }, 500);
  let ws = request.headers.get("x-key") || "";
  if (!/^[a-z0-9]{24,64}$/.test(ws)) return J({ error: "chave" }, 401);
  if (ws === PUB) { await init(db); ws = await sharedWs(db); }
  const u = new URL(request.url), o = request.headers.get("origin");
  if (request.method !== "GET" && o && o !== u.origin && !/^(chrome|moz)-extension:\/\//.test(o)) return J({ error: "origem" }, 403);
  await init(db);
  const p = params.path || [], m = request.method, t = Date.now();
  try {
    if (p[0] === "state" && m === "GET") {
      const r = await db.prepare("SELECT k, v FROM docs WHERE ws = ?").bind(ws).all();
      const out = { main: {}, chunks: {} };
      for (const row of r.results || []) {
        if (row.k === "main") out.main = JSON.parse(row.v);
        else if (row.k.startsWith("chunk:")) out.chunks[row.k.slice(6)] = JSON.parse(row.v);
      }
      return J(out);
    }
    if (p[0] === "main" && m === "GET") {
      const cur = await db.prepare("SELECT v FROM docs WHERE ws = ? AND k = 'main'").bind(ws).first();
      return J(cur ? JSON.parse(cur.v) : {});
    }
    if (p[0] === "main" && m === "PUT") {
      const patch = await request.json();
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) return J({ error: "dados" }, 400);
      const cur = await db.prepare("SELECT v FROM docs WHERE ws = ? AND k = 'main'").bind(ws).first();
      const next = Object.assign(cur ? JSON.parse(cur.v) : {}, patch);
      const s = JSON.stringify(next);
      if (s.length > 500000) return J({ error: "tamanho" }, 413);
      await db.prepare("INSERT OR REPLACE INTO docs (ws, k, v, updated) VALUES (?, 'main', ?, ?)").bind(ws, s, t).run();
      return J({ ok: true });
    }
    if (p[0] === "chunk" && /^[A-Za-z0-9_-]{1,64}$/.test(p[1] || "")) {
      const k = "chunk:" + p[1];
      if (m === "PUT") {
        const body = await request.text();
        if (body.length > 900000) return J({ error: "tamanho" }, 413);
        const d = JSON.parse(body);
        if (!d || !Array.isArray(d.items)) return J({ error: "dados" }, 400);
        await db.prepare("INSERT OR REPLACE INTO docs (ws, k, v, updated) VALUES (?, ?, ?, ?)").bind(ws, k, body, t).run();
        return J({ ok: true });
      }
      if (m === "DELETE") {
        await db.prepare("DELETE FROM docs WHERE ws = ? AND k = ?").bind(ws, k).run();
        return J({ ok: true });
      }
    }
    if (p[0] === "mark" && m === "POST") {
      const b = await request.json();
      const id = String(b && b.id || "");
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return J({ error: "id" }, 400);
      const ok = { stage: ["novos", "contato", "perdido"], };
      const patch = {};
      const q = b.patch || {};
      if (q.stage && ok.stage.includes(q.stage)) patch.stage = q.stage;
      if (Number.isFinite(q.contacted)) patch.contacted = Math.floor(q.contacted);
      if (q.incTries) patch.__inc = 1;
      if (typeof q.wa_invalid === "boolean") patch.wa_invalid = q.wa_invalid;
      if (typeof q.sent_auto === "boolean") patch.sent_auto = q.sent_auto;
      if (Number.isFinite(q.replied)) patch.replied = Math.floor(q.replied);
      if (Number.isFinite(q.replied2)) patch.replied2 = Math.floor(q.replied2);
      if (typeof q.funnel === "string") patch.funnel = q.funnel.slice(0, 40);
      const r = await db.prepare("SELECT k, v FROM docs WHERE ws = ? AND k LIKE 'chunk:%'").bind(ws).all();
      for (const row of r.results || []) {
        const d = JSON.parse(row.v), it = (d.items || []).find(x => x.id === id);
        if (!it) continue;
        if (patch.__inc) { it.tries = (it.tries || 0) + 1; delete patch.__inc; }
        Object.assign(it, patch); it.updated = Math.floor(t / 1000);
        await db.prepare("INSERT OR REPLACE INTO docs (ws, k, v, updated) VALUES (?, ?, ?, ?)").bind(ws, row.k, JSON.stringify(d), t).run();
        return J({ ok: true, item: { id: it.id, stage: it.stage, tries: it.tries } });
      }
      return J({ error: "nao_achei" }, 404);
    }
    return J({ error: "rota" }, 404);
  } catch (e) {
    return J({ error: "falha", detail: String(e && e.message || e).slice(0, 200) }, 500);
  }
}
