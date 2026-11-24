// API da plataforma de vendas de sites (Cloudflare Pages Functions + D1 "DB")
const STAGES = ["novos", "contato", "feito", "pagamento", "pagos"];
const DAY = 86400;
const SESSION_DAYS = 60;

const J = (d, s = 200, h = {}) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...h },
  });
const err = (msg, s = 400) => J({ error: msg }, s);
const now = () => Math.floor(Date.now() / 1000);
const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);
const S = (v, max = 2000) => (v == null ? "" : String(v)).trim().slice(0, max);

// ---------- cripto ----------
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function sha256(s) {
  return b64(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}
async function pbkdf2(pass, salt, iter) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveBits"]);
  return b64(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
}
async function hashPass(pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iter = 100000;
  return `pbkdf2$${iter}$${b64(salt)}$${await pbkdf2(pass, salt, iter)}`;
}
async function checkPass(pass, stored) {
  if (!stored) return false;
  const [, iter, salt, hash] = stored.split("$");
  const got = await pbkdf2(pass, unb64(salt), +iter);
  if (got.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}
function recoveryCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const r = crypto.getRandomValues(new Uint8Array(12));
  let s = "";
  for (let i = 0; i < 12; i++) s += A[r[i] % A.length] + (i % 4 === 3 && i < 11 ? "-" : "");
  return s;
}
const normCode = (c) => S(c, 40).toUpperCase().replace(/[^A-Z0-9]/g, "");
const normEmail = (e) => S(e, 200).toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// ---------- banco ----------
let ready = false;
async function setup(db) {
  if (ready) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE, pw TEXT, rec TEXT, created INTEGER)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, uid TEXT, exp INTEGER)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS settings(uid TEXT PRIMARY KEY, wa TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS niches(id TEXT PRIMARY KEY, uid TEXT, name TEXT, prompt TEXT, wa TEXT, created INTEGER)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS companies(id TEXT PRIMARY KEY, uid TEXT, k TEXT, name TEXT, category TEXT, phone TEXT, wa TEXT, address TEXT, city TEXT, state TEXT, rating TEXT, reviews_count TEXT, reviews TEXT, hours TEXT, description TEXT, site_current TEXT, niche_id TEXT, stage TEXT, link TEXT, value REAL, created INTEGER, updated INTEGER)`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS companies_uk ON companies(uid, k)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS sessions_uid ON sessions(uid)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS niches_uid ON niches(uid)`),
  ]);
  ready = true;
}

function cookie(token, maxAge) {
  return `s=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
async function newSession(db, userId) {
  const raw = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[^A-Za-z0-9]/g, "");
  await db.prepare(`INSERT INTO sessions(token, uid, exp) VALUES(?,?,?)`).bind(await sha256(raw), userId, now() + SESSION_DAYS * DAY).run();
  return cookie(raw, SESSION_DAYS * DAY);
}
async function currentUser(db, req) {
  const m = /(?:^|;\s*)s=([A-Za-z0-9]+)/.exec(req.headers.get("cookie") || "");
  if (!m) return null;
  const row = await db
    .prepare(`SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.uid WHERE s.token = ? AND s.exp > ?`)
    .bind(await sha256(m[1]), now())
    .first();
  return row ? { ...row, tokenHash: await sha256(m[1]) } : null;
}
const pub = (u) => ({ id: u.id, name: u.name, email: u.email });

// chave para não duplicar empresas
function keyOf(c) {
  let d = (c.wa || c.phone || "").replace(/\D/g, "");
  if (d.startsWith("55") && d.length >= 12) d = d.slice(2);
  d = d.replace(/^0+/, "");
  if (d.length >= 8) return "p" + d.slice(-11);
  const n = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
  return "n" + n(c.name) + "|" + n(c.city);
}
const COMPANY_FIELDS = {
  name: 300, category: 200, phone: 60, wa: 60, address: 400, city: 120, state: 60, rating: 20,
  reviews_count: 20, reviews: 8000, hours: 1500, description: 3000, site_current: 500,
};

async function readJSON(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

export async function onRequest({ request, env, params }) {
  const db = env.DB;
  if (!db) return err("Banco de dados não configurado (binding DB).", 500);
  const path = (params.path || []).join("/");
  const method = request.method;

  // proteção contra envio de outro site
  if (method !== "GET") {
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).host !== new URL(request.url).host) return err("Origem inválida.", 403);
  }

  try {
    await setup(db);

    if (path === "health") {
      const r = await db.prepare("SELECT 1 AS ok").first();
      return J({ ok: r.ok === 1 });
    }

    // ---------- conta: rotas sem login ----------
    if (path === "signup" && method === "POST") {
      const b = await readJSON(request);
      const name = S(b.name, 120), email = normEmail(b.email), pass = String(b.password || "");
      if (!name) return err("Informe seu nome.");
      if (!validEmail(email)) return err("E-mail inválido.");
      if (pass.length < 8) return err("A senha precisa ter pelo menos 8 caracteres.");
      if (await db.prepare(`SELECT 1 FROM users WHERE email = ?`).bind(email).first()) return err("Já existe uma conta com este e-mail.");
      const id = uid(), rec = recoveryCode();
      await db.prepare(`INSERT INTO users(id, name, email, pw, rec, created) VALUES(?,?,?,?,?,?)`)
        .bind(id, name, email, await hashPass(pass), await sha256(normCode(rec)), now()).run();
      return J({ user: { id, name, email }, recovery: rec }, 200, { "set-cookie": await newSession(db, id) });
    }
    if (path === "login" && method === "POST") {
      const b = await readJSON(request);
      const u = await db.prepare(`SELECT * FROM users WHERE email = ?`).bind(normEmail(b.email)).first();
      if (!u || !(await checkPass(String(b.password || ""), u.pw))) return err("E-mail ou senha incorretos.", 401);
      await db.prepare(`DELETE FROM sessions WHERE exp < ?`).bind(now()).run();
      return J({ user: pub(u) }, 200, { "set-cookie": await newSession(db, u.id) });
    }
    if (path === "recover" && method === "POST") {
      const b = await readJSON(request);
      const u = await db.prepare(`SELECT * FROM users WHERE email = ?`).bind(normEmail(b.email)).first();
      const pass = String(b.password || "");
      if (!u || u.rec !== (await sha256(normCode(b.code)))) return err("E-mail ou código de recuperação incorretos.", 401);
      if (pass.length < 8) return err("A nova senha precisa ter pelo menos 8 caracteres.");
      const rec = recoveryCode();
      await db.batch([
        db.prepare(`UPDATE users SET pw = ?, rec = ? WHERE id = ?`).bind(await hashPass(pass), await sha256(normCode(rec)), u.id),
        db.prepare(`DELETE FROM sessions WHERE uid = ?`).bind(u.id),
      ]);
      return J({ user: pub(u), recovery: rec }, 200, { "set-cookie": await newSession(db, u.id) });
    }
    if (path === "logout" && method === "POST") {
      const u = await currentUser(db, request);
      if (u) await db.prepare(`DELETE FROM sessions WHERE token = ?`).bind(u.tokenHash).run();
      return J({ ok: true }, 200, { "set-cookie": cookie("x", 0) });
    }

    // ---------- daqui para baixo precisa de login ----------
    const me = await currentUser(db, request);
    if (!me) return err("Entre na sua conta.", 401);

    if (path === "me" && method === "GET") return J({ user: pub(me) });

    if (path === "data" && method === "GET") {
      const [c, n, s] = await db.batch([
        db.prepare(`SELECT * FROM companies WHERE uid = ? ORDER BY created DESC, rowid DESC`).bind(me.id),
        db.prepare(`SELECT id, name, prompt, wa, created FROM niches WHERE uid = ? ORDER BY name COLLATE NOCASE`).bind(me.id),
        db.prepare(`SELECT wa FROM settings WHERE uid = ?`).bind(me.id),
      ]);
      return J({ user: pub(me), companies: c.results, niches: n.results, settings: { wa: s.results[0]?.wa || "" } });
    }

    if (path === "me" && method === "PUT") {
      const b = await readJSON(request);
      const name = S(b.name, 120), email = normEmail(b.email);
      if (!name) return err("Informe seu nome.");
      if (!validEmail(email)) return err("E-mail inválido.");
      const other = await db.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first();
      if (other && other.id !== me.id) return err("Este e-mail já está em uso.");
      await db.prepare(`UPDATE users SET name = ?, email = ? WHERE id = ?`).bind(name, email, me.id).run();
      return J({ user: { id: me.id, name, email } });
    }
    if (path === "password" && method === "POST") {
      const b = await readJSON(request);
      const u = await db.prepare(`SELECT pw FROM users WHERE id = ?`).bind(me.id).first();
      if (!(await checkPass(String(b.current || ""), u.pw))) return err("Senha atual incorreta.", 401);
      if (String(b.password || "").length < 8) return err("A nova senha precisa ter pelo menos 8 caracteres.");
      await db.batch([
        db.prepare(`UPDATE users SET pw = ? WHERE id = ?`).bind(await hashPass(String(b.password)), me.id),
        db.prepare(`DELETE FROM sessions WHERE uid = ? AND token <> ?`).bind(me.id, me.tokenHash),
      ]);
      return J({ ok: true });
    }
    if (path === "recovery-code" && method === "POST") {
      const b = await readJSON(request);
      const u = await db.prepare(`SELECT pw FROM users WHERE id = ?`).bind(me.id).first();
      if (!(await checkPass(String(b.password || ""), u.pw))) return err("Senha incorreta.", 401);
      const rec = recoveryCode();
      await db.prepare(`UPDATE users SET rec = ? WHERE id = ?`).bind(await sha256(normCode(rec)), me.id).run();
      return J({ recovery: rec });
    }
    if (path === "me" && method === "DELETE") {
      const b = await readJSON(request);
      const u = await db.prepare(`SELECT pw FROM users WHERE id = ?`).bind(me.id).first();
      if (!(await checkPass(String(b.password || ""), u.pw))) return err("Senha incorreta.", 401);
      await db.batch([
        db.prepare(`DELETE FROM companies WHERE uid = ?`).bind(me.id),
        db.prepare(`DELETE FROM niches WHERE uid = ?`).bind(me.id),
        db.prepare(`DELETE FROM settings WHERE uid = ?`).bind(me.id),
        db.prepare(`DELETE FROM sessions WHERE uid = ?`).bind(me.id),
        db.prepare(`DELETE FROM users WHERE id = ?`).bind(me.id),
      ]);
      return J({ ok: true }, 200, { "set-cookie": cookie("x", 0) });
    }

    if (path === "settings" && method === "PUT") {
      const b = await readJSON(request);
      await db.prepare(`INSERT INTO settings(uid, wa) VALUES(?, ?) ON CONFLICT(uid) DO UPDATE SET wa = excluded.wa`)
        .bind(me.id, S(b.wa, 4000)).run();
      return J({ ok: true });
    }

    // ---------- empresas ----------
    if (path === "companies/import" && method === "POST") {
      const b = await readJSON(request);
      const items = Array.isArray(b.items) ? b.items.slice(0, 5000) : [];
      let nicheOk = null;
      if (b.niche_id) {
        const n = await db.prepare(`SELECT id FROM niches WHERE id = ? AND uid = ?`).bind(String(b.niche_id), me.id).first();
        nicheOk = n ? n.id : null;
      }
      const myNiches = (await db.prepare(`SELECT id, name FROM niches WHERE uid = ?`).bind(me.id).all()).results;
      const byName = Object.fromEntries(myNiches.map((n) => [n.name.toLowerCase().trim(), n.id]));
      const t = now();
      const stmts = [];
      const ids = [];
      for (const raw of items) {
        const c = {};
        for (const [f, max] of Object.entries(COMPANY_FIELDS)) c[f] = S(raw[f], max);
        if (!c.name && !c.phone && !c.wa) continue;
        if (!c.name) c.name = "Empresa sem nome";
        const niche = nicheOk || byName[S(raw.niche, 120).toLowerCase()] || null;
        const id = uid();
        ids.push(id);
        stmts.push(
          db.prepare(
            `INSERT OR IGNORE INTO companies(id, uid, k, name, category, phone, wa, address, city, state, rating, reviews_count, reviews, hours, description, site_current, niche_id, stage, link, value, created, updated)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'novos','',NULL,?,?)`
          ).bind(id, me.id, keyOf(c), c.name, c.category, c.phone, c.wa, c.address, c.city, c.state, c.rating, c.reviews_count, c.reviews, c.hours, c.description, c.site_current, niche, t, t)
        );
      }
      let added = 0;
      for (let i = 0; i < stmts.length; i += 80) {
        const res = await db.batch(stmts.slice(i, i + 80));
        for (const r of res) added += r.meta?.changes || 0;
      }
      return J({ added, skipped: stmts.length - added, ignored: items.length - stmts.length });
    }

    let m;
    if ((m = /^companies\/([a-f0-9]+)$/.exec(path))) {
      const id = m[1];
      const row = await db.prepare(`SELECT * FROM companies WHERE id = ? AND uid = ?`).bind(id, me.id).first();
      if (!row) return err("Empresa não encontrada.", 404);
      if (method === "DELETE") {
        await db.prepare(`DELETE FROM companies WHERE id = ? AND uid = ?`).bind(id, me.id).run();
        return J({ ok: true });
      }
      if (method === "PATCH") {
        const b = await readJSON(request);
        const up = {};
        if ("stage" in b) {
          if (!STAGES.includes(b.stage)) return err("Etapa inválida.");
          up.stage = b.stage;
          if (b.stage !== "pagos") up.value = null;
        }
        if ("link" in b) {
          const l = S(b.link, 600);
          if (l && !/^https?:\/\/\S+$/i.test(l)) return err("O link precisa começar com http:// ou https://");
          up.link = l;
        }
        if ("value" in b && b.value !== null) {
          const v = Number(b.value);
          if (!(v > 0) || v > 1e8) return err("Valor inválido.");
          up.value = Math.round(v * 100) / 100;
        }
        if ("niche_id" in b) {
          if (b.niche_id) {
            const n = await db.prepare(`SELECT id FROM niches WHERE id = ? AND uid = ?`).bind(String(b.niche_id), me.id).first();
            if (!n) return err("Nicho não encontrado.");
            up.niche_id = n.id;
          } else up.niche_id = null;
        }
        if (up.stage === "pagos" && !(up.value > 0)) return err("Digite o valor recebido.");
        const keys = Object.keys(up);
        if (!keys.length) return J({ company: row });
        await db.prepare(`UPDATE companies SET ${keys.map((k) => k + " = ?").join(", ")}, updated = ? WHERE id = ? AND uid = ?`)
          .bind(...keys.map((k) => up[k]), now(), id, me.id).run();
        return J({ company: await db.prepare(`SELECT * FROM companies WHERE id = ?`).bind(id).first() });
      }
    }

    // ---------- nichos ----------
    if (path === "niches" && method === "POST") {
      const b = await readJSON(request);
      const name = S(b.name, 120);
      if (!name) return err("Dê um nome ao nicho.");
      const id = uid();
      await db.prepare(`INSERT INTO niches(id, uid, name, prompt, wa, created) VALUES(?,?,?,?,?,?)`)
        .bind(id, me.id, name, String(b.prompt || "").slice(0, 900000), S(b.wa, 4000), now()).run();
      return J({ niche: { id, name, prompt: String(b.prompt || "").slice(0, 900000), wa: S(b.wa, 4000) } });
    }
    if ((m = /^niches\/([a-f0-9]+)$/.exec(path))) {
      const id = m[1];
      const n = await db.prepare(`SELECT id FROM niches WHERE id = ? AND uid = ?`).bind(id, me.id).first();
      if (!n) return err("Nicho não encontrado.", 404);
      if (method === "PUT") {
        const b = await readJSON(request);
        const name = S(b.name, 120);
        if (!name) return err("Dê um nome ao nicho.");
        await db.prepare(`UPDATE niches SET name = ?, prompt = ?, wa = ? WHERE id = ? AND uid = ?`)
          .bind(name, String(b.prompt || "").slice(0, 900000), S(b.wa, 4000), id, me.id).run();
        return J({ ok: true });
      }
      if (method === "DELETE") {
        await db.batch([
          db.prepare(`UPDATE companies SET niche_id = NULL WHERE niche_id = ? AND uid = ?`).bind(id, me.id),
          db.prepare(`DELETE FROM niches WHERE id = ? AND uid = ?`).bind(id, me.id),
        ]);
        return J({ ok: true });
      }
    }

    return err("Não encontrado.", 404);
  } catch (e) {
    return err("Erro no servidor. Tente de novo.", 500);
  }
}
