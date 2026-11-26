// Nitro Vendas — API de dados (Cloudflare Pages Functions + D1, binding "DB")
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
let ready = false;
async function init(db) {
  if (ready) return;
  await db.prepare("CREATE TABLE IF NOT EXISTS docs (ws TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (ws, k))").run();
  ready = true;
}
async function withLive(db, ws, main) {
  const l = await db.prepare("SELECT v FROM docs WHERE ws = ? AND k = 'live'").bind(ws).first();
  if (l) Object.assign(main, JSON.parse(l.v));
  return main;
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
      const r = await db.prepare("SELECT k, v FROM docs WHERE ws = ? AND (k = 'main' OR k LIKE 'chunk:%')").bind(ws).all();
      const out = { main: {}, chunks: {} };
      for (const row of r.results || []) {
        if (row.k === "main") out.main = JSON.parse(row.v);
        else if (row.k.startsWith("chunk:")) out.chunks[row.k.slice(6)] = JSON.parse(row.v);
      }
      await withLive(db, ws, out.main);
      return J(out);
    }
    // Arquivos do funil (áudio/imagem), em partes de até 1,5 MB
    if (p[0] === "media" && /^[a-z0-9]{4,40}$/.test(p[1] || "")) {
      const base = "media:" + p[1], part = p[2];
      if (part != null && !/^\d{1,3}$/.test(part)) return J({ error: "parte" }, 400);
      const k = part == null ? base : base + ":" + part;
      if (m === "GET") {
        const r = await db.prepare("SELECT v FROM docs WHERE ws = ? AND k = ?").bind(ws, k).first();
        return r ? J(JSON.parse(r.v)) : J({ error: "nao_achei" }, 404);
      }
      if (m === "PUT") {
        const b = await request.text();
        if (b.length > 1900000) return J({ error: "tamanho" }, 413);
        JSON.parse(b);
        await db.prepare("INSERT OR REPLACE INTO docs (ws, k, v, updated) VALUES (?, ?, ?, ?)").bind(ws, k, b, t).run();
        return J({ ok: true });
      }
    }
    if (p[0] === "ver" && m === "GET") {
      const r = await db.prepare("SELECT MAX(updated) AS u, COUNT(*) AS n FROM docs WHERE ws = ? AND (k = 'main' OR k LIKE 'chunk:%')").bind(ws).first();
      return J({ v: (r && r.u || 0) + ":" + (r && r.n || 0) });
    }
    if (p[0] === "main" && m === "GET") {
      const cur = await db.prepare("SELECT v FROM docs WHERE ws = ? AND k = 'main'").bind(ws).first();
      return J(await withLive(db, ws, cur ? JSON.parse(cur.v) : {}));
    }
    if (p[0] === "main" && m === "PUT") {
      const patch = await request.json();
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) return J({ error: "dados" }, 400);
      // status da extensão fica separado: muda a cada 3 s e não deve fazer os aparelhos baixarem tudo
      const live = {};
      for (const key of ["ext", "extWatch"]) if (key in patch) { live[key] = patch[key]; delete patch[key]; }
      if (Object.keys(live).length) {
        await db.prepare("INSERT INTO docs (ws, k, v, updated) VALUES (?, 'live', ?, ?) ON CONFLICT(ws, k) DO UPDATE SET v = json_patch(docs.v, excluded.v), updated = excluded.updated").bind(ws, JSON.stringify(live), t).run();
        if (!Object.keys(patch).length) return J({ ok: true });
      }
      const s = JSON.stringify(patch);
      if (s.length > 500000) return J({ error: "tamanho" }, 413);
      // atômico: dois aparelhos (ou a extensão) salvando ao mesmo tempo não se apagam
      await db.prepare("INSERT INTO docs (ws, k, v, updated) VALUES (?, 'main', ?, ?) ON CONFLICT(ws, k) DO UPDATE SET v = json_patch(docs.v, excluded.v), updated = excluded.updated").bind(ws, s, t).run();
      return J({ ok: true });
    }
    if (p[0] === "chunk" && /^[A-Za-z0-9_-]{1,64}$/.test(p[1] || "")) {
      const k = "chunk:" + p[1];
      if (m === "PUT") {
        const body = await request.text();
        if (body.length > 900000) return J({ error: "tamanho" }, 413);
        const d = JSON.parse(body);
        if (!d || !Array.isArray(d.items)) return J({ error: "dados" }, 400);
        // Junta com o que já está salvo, empresa por empresa, para um aparelho não apagar
        // o que a extensão (ou outro aparelho) acabou de marcar.
        const cur = await db.prepare("SELECT v FROM docs WHERE ws = ? AND k = ?").bind(ws, k).first();
        const old = cur ? (JSON.parse(cur.v).items || []) : [];
        const del = new Set(Array.isArray(d.del) ? d.del.map(String) : []);
        const byOld = new Map(old.map(x => [x.id, x]));
        const seen = new Set();
        const EXT = ["replied", "replied2", "funnel"];
        const items = d.items.map(n => {
          seen.add(n.id);
          const o = byOld.get(n.id);
          if (!o) return n;
          if ((o.updated || 0) > (n.updated || 0)) return o;                 // o salvo é mais novo
          if (o.markAt && !(n.reset && n.reset >= o.markAt)) {               // não apaga o que a extensão marcou
            for (const f of EXT) if (o[f] && !n[f]) n[f] = o[f];
            if ((o.tries || 0) > (n.tries || 0)) n.tries = o.tries;
            if (o.markAt > (n.markAt || 0)) n.markAt = o.markAt;
          }
          return n;
        });
        for (const o of old) if (!seen.has(o.id) && !del.has(o.id)) items.push(o);
        const out = JSON.stringify({ items });
        if (!items.length) { await db.prepare("DELETE FROM docs WHERE ws = ? AND k = ?").bind(ws, k).run(); return J({ ok: true }); }
        await db.prepare("INSERT OR REPLACE INTO docs (ws, k, v, updated) VALUES (?, ?, ?, ?)").bind(ws, k, out, t).run();
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
        Object.assign(it, patch); it.updated = Math.floor(t / 1000); it.markAt = it.updated;
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
