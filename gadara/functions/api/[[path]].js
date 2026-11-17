// API da loja Gadara Móveis (Cloudflare Pages Functions + KV "CAT", senha em ADMIN_PASS)
// produto: { id, cat, name, desc, media:[{id,type,mime,size,chunks,chunkSize,poster,w,h}], ts }
const SEED = {
  v: 2,
  settings: { whatsapp: "", instagram: "gadara_moveis" },
  cats: [
    { id: "estofados", name: "Sofás e estofados" },
    { id: "jantar", name: "Salas de jantar" },
    { id: "quartos", name: "Quartos" },
    { id: "guarda-roupas", name: "Guarda-roupas" },
    { id: "racks", name: "Racks e painéis" },
    { id: "poltronas", name: "Poltronas" }
  ],
  items: []
};
const CHUNK_MAX = 24 * 1024 * 1024;
const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const slug = (t) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || rid();

async function load(env) {
  const c = await env.CAT.get("catalog", "json");
  if (!c || c.v !== 2) return JSON.parse(JSON.stringify(SEED));
  return c;
}
const save = (env, c) => env.CAT.put("catalog", JSON.stringify(c));
const authed = (req, env) => { const p = req.headers.get("x-admin-pass") || ""; return !!env.ADMIN_PASS && p.length > 0 && p === env.ADMIN_PASS; };

function cleanMedia(m) {
  return { id: String(m.id || "").replace(/[^a-z0-9]/g, ""), type: m.type === "video" ? "video" : "image", mime: String(m.mime || "").slice(0, 40), size: +m.size || 0, chunks: +m.chunks || 1, chunkSize: +m.chunkSize || 0, poster: !!m.poster, w: +m.w || 0, h: +m.h || 0 };
}
async function delMedia(env, m) {
  const ops = [];
  for (let i = 0; i < (m.chunks || 1); i++) ops.push(env.CAT.delete(`m:${m.id}:${i}`));
  if (m.poster) ops.push(env.CAT.delete(`m:${m.id}p:0`));
  await Promise.all(ops);
}

export async function onRequest({ request: req, env, params }) {
  if (!env.CAT) return j({ error: "Armazenamento não configurado" }, 500);
  const path = (params.path || []).join("/");
  const m = req.method;

  if (path === "catalog" && m === "GET") return j(await load(env));
  if (!authed(req, env)) return j({ error: "Senha incorreta" }, 401);
  if (path === "login" && m === "POST") return j({ ok: true });
  if (path === "newid" && m === "POST") return j({ id: rid() });

  let mm = path.match(/^chunk\/([a-z0-9]+p?)\/(\d+)$/);
  if (mm && m === "PUT") {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > CHUNK_MAX) return j({ error: "Arquivo grande demais" }, 413);
    await env.CAT.put(`m:${mm[1]}:${mm[2]}`, buf);
    return j({ ok: true });
  }

  const c = await load(env);
  const findCat = (id) => c.cats.find((x) => x.id === id);

  if (path === "item" && m === "POST") {
    const b = await req.json();
    if (!findCat(b.cat)) return j({ error: "Categoria inválida" }, 400);
    const media = (b.media || []).map(cleanMedia).filter((x) => x.id);
    if (!media.length) return j({ error: "Envie ao menos uma foto ou vídeo" }, 400);
    const it = { id: rid(), cat: b.cat, name: String(b.name || "").slice(0, 90), desc: String(b.desc || "").slice(0, 600), media, ts: Date.now() };
    c.items.unshift(it);
    await save(env, c);
    return j({ ok: true, item: it });
  }

  mm = path.match(/^item\/([a-z0-9]+)$/);
  if (mm) {
    const it = c.items.find((x) => x.id === mm[1]);
    if (!it) return j({ error: "Produto não encontrado" }, 404);
    if (m === "DELETE") {
      c.items = c.items.filter((x) => x !== it);
      await save(env, c);
      for (const md of it.media) await delMedia(env, md);
      return j({ ok: true });
    }
    if (m === "PATCH") {
      const b = await req.json();
      if (typeof b.name === "string") it.name = b.name.slice(0, 90);
      if (typeof b.desc === "string") it.desc = b.desc.slice(0, 600);
      if (b.cat && findCat(b.cat)) it.cat = b.cat;
      if (b.top) c.items = [it, ...c.items.filter((x) => x !== it)];
      if (Array.isArray(b.addMedia)) it.media.push(...b.addMedia.map(cleanMedia).filter((x) => x.id));
      let gone = null;
      if (b.removeMedia) {
        gone = it.media.find((x) => x.id === b.removeMedia);
        if (gone && it.media.length > 1) it.media = it.media.filter((x) => x !== gone); else gone = null;
      }
      if (b.coverMedia) { const cv = it.media.find((x) => x.id === b.coverMedia); if (cv) it.media = [cv, ...it.media.filter((x) => x !== cv)]; }
      await save(env, c);
      if (gone) await delMedia(env, gone);
      return j({ ok: true });
    }
  }

  if (path === "cat" && m === "POST") {
    const b = await req.json();
    const name = String(b.name || "").trim().slice(0, 40);
    if (!name) return j({ error: "Nome vazio" }, 400);
    let id = slug(name);
    while (findCat(id)) id += "-" + Math.random().toString(36).slice(2, 4);
    c.cats.push({ id, name });
    await save(env, c);
    return j({ ok: true, id });
  }
  mm = path.match(/^cat\/([a-z0-9-]+)$/);
  if (mm) {
    const ct = findCat(mm[1]);
    if (!ct) return j({ error: "Categoria não encontrada" }, 404);
    if (m === "PATCH") {
      const b = await req.json();
      if (b.name) ct.name = String(b.name).trim().slice(0, 40);
      if (b.move) { const i = c.cats.indexOf(ct), k = i + (b.move < 0 ? -1 : 1); if (k >= 0 && k < c.cats.length) { c.cats.splice(i, 1); c.cats.splice(k, 0, ct); } }
      await save(env, c);
      return j({ ok: true });
    }
    if (m === "DELETE") {
      const gone = c.items.filter((x) => x.cat === ct.id);
      c.cats = c.cats.filter((x) => x !== ct);
      c.items = c.items.filter((x) => x.cat !== ct.id);
      await save(env, c);
      for (const it of gone) for (const md of it.media) await delMedia(env, md);
      return j({ ok: true });
    }
  }

  if (path === "settings" && m === "POST") {
    const b = await req.json();
    c.settings = c.settings || {};
    if (typeof b.whatsapp === "string") c.settings.whatsapp = b.whatsapp.replace(/\D/g, "").slice(0, 15);
    if (typeof b.instagram === "string") c.settings.instagram = b.instagram.replace(/[^a-zA-Z0-9._]/g, "").slice(0, 40);
    await save(env, c);
    return j({ ok: true });
  }

  return j({ error: "Rota inválida" }, 404);
}
