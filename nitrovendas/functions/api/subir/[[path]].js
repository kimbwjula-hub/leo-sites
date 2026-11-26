// Nitro · Subir sites
// Recebe os arquivos do navegador e publica no Cloudflare Pages (Direct Upload).
// Segredos no projeto: CF_TOKEN (token da API) e SENHA (senha da página).

const ACC = "f9a358d0b14d705a0247ce97a870e3fb";
const ZONA = "agencianitro.com.br";
const API = "https://api.cloudflare.com/client/v4";
const RESERVADOS = new Set(["subir", "www", "sitegratis", "api", "mail", "admin", "painel"]);
const NOME_OK = /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/;

const j = (d, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function cf(env, path, opt = {}) {
  const h = { Authorization: "Bearer " + env.CF_TOKEN, ...(opt.headers || {}) };
  if (opt.json !== undefined) { h["content-type"] = "application/json"; opt.body = JSON.stringify(opt.json); }
  const r = await fetch(API + path, { method: opt.method || "GET", headers: h, body: opt.body });
  let d; try { d = await r.json(); } catch { d = { success: false, errors: [{ message: "HTTP " + r.status }] }; }
  return { status: r.status, ...d };
}
async function jwtFetch(jwt, path, body) {
  const r = await fetch(API + path, { method: "POST", headers: { Authorization: "Bearer " + jwt, "content-type": "application/json" }, body: JSON.stringify(body) });
  let d; try { d = await r.json(); } catch { d = { success: false, errors: [{ message: "HTTP " + r.status }] }; }
  return { status: r.status, ...d };
}
const erroDe = (d) => (d.errors && d.errors[0] && d.errors[0].message) || "erro " + d.status;

let zonaId = null;
async function pegarZona(env) {
  if (zonaId) return zonaId;
  const d = await cf(env, "/zones?name=" + ZONA);
  if (!d.success || !d.result || !d.result[0]) throw new Error("Token sem acesso à zona " + ZONA + ": " + erroDe(d));
  return (zonaId = d.result[0].id);
}

async function tirarDominio(env, nome, host) {
  const zid = await pegarZona(env);
  await cf(env, `/accounts/${ACC}/pages/projects/${nome}/domains/${host}`, { method: "DELETE" });
  const ex = await cf(env, "/zones/" + zid + "/dns_records?name=" + host);
  for (const r of (ex.success && ex.result) || []) {
    if (r.type === "CNAME" && r.content === nome + ".pages.dev") await cf(env, `/zones/${zid}/dns_records/${r.id}`, { method: "DELETE" });
  }
}
const subsDe = (pr) => ((pr.result && pr.result.domains) || []).filter((d) => d.endsWith("." + ZONA));
async function pegarProjeto(env, nome) {
  if (!NOME_OK.test(nome)) return { erro: "Nome inválido.", st: 400 };
  const pr = await cf(env, `/accounts/${ACC}/pages/projects/${nome}`);
  if (!pr.success) return { erro: pr.status === 404 ? "Esse site não existe." : erroDe(pr), st: pr.status === 404 ? 404 : 502 };
  if (pr.result.source && pr.result.source.type === "github") return { erro: "Esse site é ligado ao GitHub; não mexo nele por aqui.", st: 409 };
  return { pr };
}

async function ligarSubdominio(env, nome, label = nome) {
  const host = label + "." + ZONA;
  const alvo = nome + ".pages.dev";
  const zid = await pegarZona(env);
  const ex = await cf(env, "/zones/" + zid + "/dns_records?name=" + host);
  const rec = ex.success && ex.result && ex.result[0];
  if (rec) {
    if (rec.type !== "CNAME" || rec.content !== alvo) return { ok: false, aviso: host + " já está em uso por outro site; não mexi." };
  } else {
    const c = await cf(env, "/zones/" + zid + "/dns_records", { method: "POST", json: { type: "CNAME", name: host, content: alvo, proxied: true, ttl: 1 } });
    if (!c.success) return { ok: false, aviso: "DNS: " + erroDe(c) };
  }
  const dm = await cf(env, `/accounts/${ACC}/pages/projects/${nome}/domains`, { method: "POST", json: { name: host } });
  if (!dm.success && !/already|exist/i.test(erroDe(dm))) return { ok: false, aviso: "Domínio: " + erroDe(dm) };
  return { ok: true, host };
}

export async function onRequest({ request, env, params }) {
  const rota = [].concat(params.path || []).join("/");
  if (!env.CF_TOKEN || !env.SENHA) return j({ ok: false, erro: "config", falta: [!env.CF_TOKEN && "CF_TOKEN", !env.SENHA && "SENHA"].filter(Boolean) }, 503);
  if (request.headers.get("x-senha") !== env.SENHA) return j({ ok: false, erro: "senha" }, 401);
  const url = new URL(request.url);
  let b = {};
  if (request.method === "POST") { try { b = await request.json(); } catch { return j({ ok: false, erro: "corpo inválido" }, 400); } }

  try {
    // Lista de sites da conta
    if (rota === "sites") {
      const out = [];
      for (let p = 1; p <= 20; p++) {
        const d = await cf(env, `/accounts/${ACC}/pages/projects?page=${p}`);
        if (!d.success) return j({ ok: false, erro: erroDe(d) }, 502);
        for (const x of d.result || []) {
          if (x.source && x.source.type === "github") continue; // os do GitHub ficam de fora
          out.push({ nome: x.name, pages: x.subdomain, dominios: x.domains || [], quando: (x.latest_deployment && x.latest_deployment.created_on) || x.created_on });
        }
        const ri = d.result_info || {};
        if (!ri.total_pages || p >= ri.total_pages) break;
      }
      out.sort((a, c) => String(c.quando).localeCompare(String(a.quando)));
      return j({ ok: true, sites: out });
    }

    // Prepara: cria o projeto se não existir e devolve o token de upload
    if (rota === "preparar") {
      const nome = String(b.nome || "").toLowerCase();
      if (!NOME_OK.test(nome)) return j({ ok: false, erro: "Nome inválido. Use letras minúsculas, números e hífen." }, 400);
      if (RESERVADOS.has(nome)) return j({ ok: false, erro: "Esse nome é reservado. Escolha outro." }, 400);
      let pr = await cf(env, `/accounts/${ACC}/pages/projects/${nome}`);
      let novo = false;
      if (!pr.success) {
        if (pr.status !== 404) return j({ ok: false, erro: erroDe(pr) }, 502);
        pr = await cf(env, `/accounts/${ACC}/pages/projects`, { method: "POST", json: { name: nome, production_branch: "main" } });
        if (!pr.success) return j({ ok: false, erro: "Não criou o projeto: " + erroDe(pr) }, 502);
        novo = true;
        if (pr.result.subdomain !== nome + ".pages.dev") {
          await cf(env, `/accounts/${ACC}/pages/projects/${nome}`, { method: "DELETE" });
          return j({ ok: false, erro: `"${nome}.pages.dev" já é de outra pessoa no Cloudflare. Escolha outro nome.`, ocupado: true }, 409);
        }
      } else if (pr.result.source && pr.result.source.type === "github") {
        return j({ ok: false, erro: "Esse nome é de um site ligado ao GitHub. Escolha outro." }, 409);
      }
      const t = await cf(env, `/accounts/${ACC}/pages/projects/${nome}/upload-token`);
      if (!t.success) return j({ ok: false, erro: "Token de upload: " + erroDe(t) }, 502);
      return j({ ok: true, jwt: t.result.jwt, novo });
    }

    // Quais arquivos faltam no Cloudflare
    if (rota === "faltando") {
      const d = await jwtFetch(b.jwt, "/pages/assets/check-missing", { hashes: b.hashes || [] });
      if (!d.success) return j({ ok: false, erro: erroDe(d) }, 502);
      return j({ ok: true, faltando: d.result || [] });
    }

    // Envia um lote de arquivos
    if (rota === "enviar") {
      const d = await jwtFetch(b.jwt, "/pages/assets/upload", b.itens || []);
      if (!d.success) return j({ ok: false, erro: erroDe(d) }, 502);
      return j({ ok: true });
    }

    // Publica
    if (rota === "publicar") {
      const nome = String(b.nome || "").toLowerCase();
      if (!NOME_OK.test(nome)) return j({ ok: false, erro: "Nome inválido." }, 400);
      const up = await jwtFetch(b.jwt, "/pages/assets/upsert-hashes", { hashes: b.hashes || [] });
      if (!up.success) return j({ ok: false, erro: erroDe(up) }, 502);
      const fd = new FormData();
      fd.append("manifest", JSON.stringify(b.manifest || {}));
      fd.append("branch", "main");
      if (b.headers) fd.append("_headers", new Blob([b.headers]), "_headers");
      if (b.redirects) fd.append("_redirects", new Blob([b.redirects]), "_redirects");
      const dp = await cf(env, `/accounts/${ACC}/pages/projects/${nome}/deployments`, { method: "POST", body: fd });
      if (!dp.success) return j({ ok: false, erro: "Publicação: " + erroDe(dp) }, 502);
      let sub = null;
      if (b.sub) { try { sub = await ligarSubdominio(env, nome); } catch (e) { sub = { ok: false, aviso: String(e.message || e) }; } }
      return j({ ok: true, id: dp.result.id, pages: "https://" + nome + ".pages.dev", sub });
    }

    // Liga ou desliga o endereço nome.agencianitro.com.br
    if (rota === "dominio") {
      const nome = String(b.nome || "").toLowerCase();
      const g = await pegarProjeto(env, nome); if (g.erro) return j({ ok: false, erro: g.erro }, g.st);
      if (b.acao === "desligar") {
        for (const h of subsDe(g.pr)) await tirarDominio(env, nome, h);
        return j({ ok: true });
      }
      if (RESERVADOS.has(nome)) return j({ ok: false, erro: "Esse nome é reservado." }, 400);
      const r = await ligarSubdominio(env, nome);
      return r.ok ? j({ ok: true, host: r.host }) : j({ ok: false, erro: r.aviso }, 409);
    }

    // Troca o nome do endereço agencianitro.com.br (o .pages.dev não muda)
    if (rota === "renomear") {
      const nome = String(b.nome || "").toLowerCase(), novo = String(b.novo || "").toLowerCase();
      const g = await pegarProjeto(env, nome); if (g.erro) return j({ ok: false, erro: g.erro }, g.st);
      if (!NOME_OK.test(novo)) return j({ ok: false, erro: "Nome inválido. Use letras minúsculas, números e hífen." }, 400);
      if (RESERVADOS.has(novo)) return j({ ok: false, erro: "Esse nome é reservado. Escolha outro." }, 400);
      const antigos = subsDe(g.pr).filter((h) => h !== novo + "." + ZONA);
      if (antigos.length === 0 && subsDe(g.pr).length) return j({ ok: true, host: novo + "." + ZONA, igual: true });
      const r = await ligarSubdominio(env, nome, novo);
      if (!r.ok) return j({ ok: false, erro: r.aviso }, 409);
      for (const h of antigos) await tirarDominio(env, nome, h);
      return j({ ok: true, host: r.host });
    }

    // Exclui o site (e o endereço agencianitro.com.br dele)
    if (rota === "excluir") {
      const nome = String(b.nome || "").toLowerCase();
      if (b.confirmar !== nome) return j({ ok: false, erro: "Confirmação faltando." }, 400);
      const g = await pegarProjeto(env, nome); if (g.erro) return j({ ok: false, erro: g.erro }, g.st);
      for (const h of subsDe(g.pr)) await tirarDominio(env, nome, h);
      let del = await cf(env, `/accounts/${ACC}/pages/projects/${nome}`, { method: "DELETE" });
      if (!del.success) {
        const ls = await cf(env, `/accounts/${ACC}/pages/projects/${nome}/deployments?per_page=25`);
        let n = 0;
        for (const d of (ls.success && ls.result) || []) {
          if (n++ >= 25) break;
          await cf(env, `/accounts/${ACC}/pages/projects/${nome}/deployments/${d.id}?force=true`, { method: "DELETE" });
        }
        del = await cf(env, `/accounts/${ACC}/pages/projects/${nome}`, { method: "DELETE" });
        if (!del.success) return j({ ok: false, parcial: true, erro: "Ainda limpando as publicações antigas: " + erroDe(del) }, 202);
      }
      return j({ ok: true });
    }

    // Situação da publicação
    if (rota === "status") {
      const nome = String(url.searchParams.get("nome") || "").toLowerCase();
      const id = url.searchParams.get("id");
      const d = await cf(env, `/accounts/${ACC}/pages/projects/${nome}/deployments/${id}`);
      if (!d.success) return j({ ok: false, erro: erroDe(d) }, 502);
      const s = d.result.latest_stage || {};
      return j({ ok: true, etapa: s.name, estado: s.status });
    }

    return j({ ok: false, erro: "rota" }, 404);
  } catch (e) {
    return j({ ok: false, erro: String((e && e.message) || e) }, 500);
  }
}
