const EV = { visit: "visits", play: "play", meio: "meio", fim: "fim", click: "click", form: "form", share: "share" };
let ready = false;
async function setup(db) {
  if (ready) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, first INTEGER, last INTEGER, city TEXT, region TEXT, country TEXT, device TEXT, visits INTEGER DEFAULT 0, play INTEGER DEFAULT 0, meio INTEGER DEFAULT 0, fim INTEGER DEFAULT 0, click INTEGER DEFAULT 0, form INTEGER DEFAULT 0, share INTEGER DEFAULT 0, nome TEXT, nicho TEXT)`).run();
  ready = true;
}
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const cut = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : null) || null;

export async function onRequest({ request, env, params }) {
  const db = env.DB;
  if (!db) return json({ error: "banco não configurado" }, 500);
  await setup(db);
  const path = (params.path || []).join("/");

  if (path === "t" && request.method === "POST") {
    let b; try { b = await request.json(); } catch { return json({ ok: false }, 400); }
    const id = cut(b.id, 40), col = EV[b.e];
    if (!id || !/^[a-z0-9-]+$/i.test(id) || !col) return json({ ok: false }, 400);
    const cf = request.cf || {}, now = Date.now();
    const ua = request.headers.get("user-agent") || "";
    const dev = /iphone|ipad/i.test(ua) ? "iPhone" : /android/i.test(ua) ? "Android" : /mobile/i.test(ua) ? "Celular" : "Computador";
    await db.prepare(`INSERT INTO devices (id, first, last, city, region, country, device, ${col}) VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, 1)
      ON CONFLICT(id) DO UPDATE SET last = ?2, ${col} = ${col} + 1`).bind(id, now, cut(cf.city, 60), cut(cf.region, 60), cut(cf.country, 4), dev).run();
    if (col === "form" && (b.nome || b.nicho)) await db.prepare("UPDATE devices SET nome = ?2, nicho = ?3 WHERE id = ?1").bind(id, cut(b.nome, 60), cut(b.nicho, 80)).run();
    return json({ ok: true });
  }

  if (path === "stats" && request.method === "GET") {
    if (!env.ADMIN_PASS || request.headers.get("x-admin-pass") !== env.ADMIN_PASS) return json({ error: "senha" }, 401);
    const since = Date.now() - 86400000;
    const tot = await db.prepare(`SELECT COUNT(*) devices, SUM(visits) visits, SUM(play>0) play, SUM(meio>0) meio, SUM(fim>0) fim, SUM(click>0) click, SUM(form>0) form, SUM(share>0) share FROM devices`).first();
    const hoje = await db.prepare(`SELECT COUNT(*) devices, SUM(play>0) play, SUM(click>0) click, SUM(form>0) form FROM devices WHERE first >= ?1`).bind(since).first();
    const cidades = (await db.prepare(`SELECT COALESCE(city,'?') city, COALESCE(region,'') region, COUNT(*) n FROM devices GROUP BY city, region ORDER BY n DESC LIMIT 10`).all()).results;
    const ultimos = (await db.prepare(`SELECT first, last, city, region, device, visits, play, meio, fim, click, form, share, nome, nicho FROM devices ORDER BY last DESC LIMIT 100`).all()).results;
    return json({ tot, hoje, cidades, ultimos });
  }
  return json({ error: "não encontrado" }, 404);
}
