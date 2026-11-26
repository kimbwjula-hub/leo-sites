// Nitro Vendas — API de dados (Cloudflare Pages Functions + D1, binding "DB")
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
let ready = false;
async function init(db) {
  if (ready) return;
  await db.prepare("CREATE TABLE IF NOT EXISTS docs (ws TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (ws, k))").run();
  ready = true;
}
export async function onRequest({ request, env, params }) {
  const db = env.DB;
  if (!db) return J({ error: "sem_banco" }, 500);
  const ws = request.headers.get("x-key") || "";
  if (!/^[a-z0-9]{24,64}$/.test(ws)) return J({ error: "chave" }, 401);
  const u = new URL(request.url), o = request.headers.get("origin");
  if (request.method !== "GET" && o && o !== u.origin) return J({ error: "origem" }, 403);
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
    return J({ error: "rota" }, 404);
  } catch (e) {
    return J({ error: "falha", detail: String(e && e.message || e).slice(0, 200) }, 500);
  }
}
