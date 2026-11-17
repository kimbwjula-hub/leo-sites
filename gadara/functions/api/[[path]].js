// API do catálogo da Gadara Móveis (Cloudflare Pages Functions + KV "CAT")
// Senha: variável de ambiente ADMIN_PASS
const SEED = {
  settings: { whatsapp: "", instagram: "gadara_moveis" },
  cats: [
    { id: "estofados", name: "Estofados" },
    { id: "jantar", name: "Salas de jantar" },
    { id: "quartos", name: "Quartos" },
    { id: "guarda-roupas", name: "Guarda-roupas" },
    { id: "estar", name: "Salas de estar" },
    { id: "poltronas", name: "Poltronas" }
  ],
  items: [
    { id: "s1", cat: "estofados", name: "Sofá retrátil", type: "image", src: "/img/c_sofa.jpg", ts: 6 },
    { id: "s2", cat: "jantar", name: "Mesa de jantar com cadeiras", type: "image", src: "/img/c_jantar.jpg", ts: 5 },
    { id: "s3", cat: "quartos", name: "Cama com cabeceira estofada", type: "image", src: "/img/c_quarto.jpg", ts: 4 },
    { id: "s4", cat: "guarda-roupas", name: "Guarda-roupa", type: "image", src: "/img/c_guarda.jpg", ts: 3 },
    { id: "s5", cat: "estar", name: "Rack e painel", type: "image", src: "/img/c_rack.jpg", ts: 2 },
    { id: "s6", cat: "poltronas", name: "Poltrona", type: "image", src: "/img/c_poltrona.jpg", ts: 1 }
  ]
};
const CHUNK_MAX = 24 * 1024 * 1024;
const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const slug = (t) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || rid();

async function load(env) {
  const c = await env.CAT.get("catalog", "json");
  return c || JSON.parse(JSON.stringify(SEED));
}
const save = (env, c) => env.CAT.put("catalog", JSON.stringify(c));

function authed(req, env) {
  const p = req.headers.get("x-admin-pass") || "";
  return env.ADMIN_PASS && p.length > 0 && p === env.ADMIN_PASS;
}

async function delMedia(env, it) {
  if (it.src) return;
  const n = it.chunks || 1;
  const ops = [];
  for (let i = 0; i < n; i++) ops.push(env.CAT.delete(`m:${it.id}:${i}`));
  if (it.poster) ops.push(env.CAT.delete(`m:${it.id}p:0`));
  await Promise.all(ops);
}

export async function onRequest({ request: req, env, params }) {
  if (!env.CAT) return j({ error: "KV não configurado" }, 500);
  const path = (params.path || []).join("/");
  const m = req.method;

  if (path === "catalog" && m === "GET") return j(await load(env));

  if (!authed(req, env)) return j({ error: "Senha incorreta" }, 401);

  if (path === "login" && m === "POST") return j({ ok: true });

  // envio de um pedaço de arquivo: PUT /api/chunk/<id>/<n>
  let mm = path.match(/^chunk\/([a-z0-9]+p?)\/(\d+)$/);
  if (mm && m === "PUT") {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > CHUNK_MAX) return j({ error: "Pedaço grande demais" }, 413);
    await env.CAT.put(`m:${mm[1]}:${mm[2]}`, buf);
    return j({ ok: true });
  }

  if (path === "newid" && m === "POST") return j({ id: rid() });

  const c = await load(env);

  // registra um item já enviado
  if (path === "item" && m === "POST") {
    const b = await req.json();
    if (!c.cats.find((x) => x.id === b.cat)) return j({ error: "Categoria inválida" }, 400);
    const it = { id: b.id, cat: b.cat, name: (b.name || "").slice(0, 80), type: b.type === "video" ? "video" : "image", mime: b.mime || "", size: b.size || 0, chunks: b.chunks || 1, chunkSize: b.chunkSize || 0, w: b.w || 0, h: b.h || 0, poster: !!b.poster, ts: Date.now() };
    c.items.unshift(it);
    await save(env, c);
    return j({ ok: true, item: it });
  }

  mm = path.match(/^item\/([a-z0-9]+)$/);
  if (mm && m === "DELETE") {
    const it = c.items.find((x) => x.id === mm[1]);
    if (!it) return j({ error: "Não encontrado" }, 404);
    c.items = c.items.filter((x) => x.id !== mm[1]);
    await save(env, c);
    await delMedia(env, it);
    return j({ ok: true });
  }
  if (mm && m === "PATCH") {
    const b = await req.json();
    const it = c.items.find((x) => x.id === mm[1]);
    if (!it) return j({ error: "Não encontrado" }, 404);
    if (typeof b.name === "string") it.name = b.name.slice(0, 80);
    if (b.cat && c.cats.find((x) => x.id === b.cat)) it.cat = b.cat;
    if (b.top) { c.items = [it, ...c.items.filter((x) => x !== it)]; }
    await save(env, c);
    return j({ ok: true });
  }

  if (path === "cat" && m === "POST") {
    const b = await req.json();
    const name = (b.name || "").trim().slice(0, 40);
    if (!name) return j({ error: "Nome vazio" }, 400);
    let id = slug(name);
    while (c.cats.find((x) => x.id === id)) id += "-" + Math.random().toString(36).slice(2, 4);
    c.cats.push({ id, name });
    await save(env, c);
    return j({ ok: true, id });
  }
  mm = path.match(/^cat\/([a-z0-9-]+)$/);
  if (mm && m === "PATCH") {
    const b = await req.json();
    const ct = c.cats.find((x) => x.id === mm[1]);
    if (!ct) return j({ error: "Não encontrada" }, 404);
    if (b.name) ct.name = b.name.trim().slice(0, 40);
    if (b.move) { const i = c.cats.indexOf(ct), k = i + (b.move < 0 ? -1 : 1); if (k >= 0 && k < c.cats.length) { c.cats.splice(i, 1); c.cats.splice(k, 0, ct); } }
    await save(env, c);
    return j({ ok: true });
  }
  if (mm && m === "DELETE") {
    const gone = c.items.filter((x) => x.cat === mm[1]);
    c.cats = c.cats.filter((x) => x.id !== mm[1]);
    c.items = c.items.filter((x) => x.cat !== mm[1]);
    await save(env, c);
    for (const it of gone) await delMedia(env, it);
    return j({ ok: true });
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
