// Nitro · Subir sites
// Recebe os arquivos do navegador e publica no Cloudflare Pages (Direct Upload).
// Segredos no projeto: CF_TOKEN (token da API) e SENHA (senha da página).

/* BLAKE3 (hash de 32 bytes), implementação compacta em JS puro */
var B3 = (function () {
  var IV = new Uint32Array([0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19]);
  var P = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];
  var CS = 1, CE = 2, PAR = 4, ROOT = 8;
  var st = new Uint32Array(16), mm = new Uint32Array(16), tm = new Uint32Array(16);
  function g(a, b, c, d, x, y) {
    st[a] = (st[a] + st[b] + x) | 0; st[d] ^= st[a]; st[d] = (st[d] >>> 16) | (st[d] << 16);
    st[c] = (st[c] + st[d]) | 0; st[b] ^= st[c]; st[b] = (st[b] >>> 12) | (st[b] << 20);
    st[a] = (st[a] + st[b] + y) | 0; st[d] ^= st[a]; st[d] = (st[d] >>> 8) | (st[d] << 24);
    st[c] = (st[c] + st[d]) | 0; st[b] ^= st[c]; st[b] = (st[b] >>> 7) | (st[b] << 25);
  }
  function compress(cv, m, ctr, len, fl, out) {
    for (var i = 0; i < 8; i++) st[i] = cv[i];
    st[8] = IV[0]; st[9] = IV[1]; st[10] = IV[2]; st[11] = IV[3];
    st[12] = ctr >>> 0; st[13] = Math.floor(ctr / 4294967296) >>> 0; st[14] = len; st[15] = fl;
    for (i = 0; i < 16; i++) mm[i] = m[i];
    for (var r = 0; r < 7; r++) {
      g(0, 4, 8, 12, mm[0], mm[1]); g(1, 5, 9, 13, mm[2], mm[3]); g(2, 6, 10, 14, mm[4], mm[5]); g(3, 7, 11, 15, mm[6], mm[7]);
      g(0, 5, 10, 15, mm[8], mm[9]); g(1, 6, 11, 12, mm[10], mm[11]); g(2, 7, 8, 13, mm[12], mm[13]); g(3, 4, 9, 14, mm[14], mm[15]);
      if (r < 6) { for (i = 0; i < 16; i++) tm[i] = mm[P[i]]; mm.set(tm); }
    }
    for (i = 0; i < 8; i++) { out[i] = st[i] ^ st[i + 8]; out[i + 8] = st[i + 8] ^ cv[i]; }
    return out;
  }
  function words(bytes, off, len, w) {
    w.fill(0);
    for (var i = 0; i < len; i++) w[i >> 2] |= bytes[off + i] << ((i & 3) * 8);
    return w;
  }
  return function (bytes) {
    var n = bytes.length, stack = [], w = new Uint32Array(16), o = new Uint32Array(16);
    var nChunks = Math.max(1, Math.ceil(n / 1024));
    var last = null; // {cv,m,ctr,len,fl} saída pendente
    for (var c = 0; c < nChunks; c++) {
      var cs = c * 1024, ce = Math.min(n, cs + 1024), cv = IV.slice(), blocks = Math.max(1, Math.ceil((ce - cs) / 64));
      for (var b = 0; b < blocks; b++) {
        var bs = cs + b * 64, bl = Math.min(64, ce - bs), fl = (b === 0 ? CS : 0);
        words(bytes, bs, bl, w);
        if (b < blocks - 1) { compress(cv, w, c, 64, fl, o); cv = o.slice(0, 8); }
        else last = { cv: cv, m: w.slice(), ctr: c, len: bl, fl: fl | CE };
      }
      if (c < nChunks - 1) {
        var ccv = compress(last.cv, last.m, last.ctr, last.len, last.fl, o).slice(0, 8), tot = c + 1;
        while ((tot & 1) === 0) {
          var left = stack.pop(), pm = new Uint32Array(16); pm.set(left, 0); pm.set(ccv, 8);
          ccv = compress(IV, pm, 0, 64, PAR, o).slice(0, 8); tot >>= 1;
        }
        stack.push(ccv);
      }
    }
    while (stack.length) {
      var rcv = compress(last.cv, last.m, last.ctr, last.len, last.fl, o).slice(0, 8), lm = new Uint32Array(16);
      lm.set(stack.pop(), 0); lm.set(rcv, 8);
      last = { cv: IV, m: lm, ctr: 0, len: 64, fl: PAR };
    }
    var r = compress(last.cv, last.m, last.ctr, last.len, last.fl | ROOT, o), hex = "";
    for (var k = 0; k < 8; k++) for (var j = 0; j < 4; j++) hex += ((r[k] >>> (j * 8)) & 255).toString(16).padStart(2, "0");
    return hex;
  };
})();

const ACC = "f9a358d0b14d705a0247ce97a870e3fb";
const ZONA = "agencianitro.com.br";
const API = "https://api.cloudflare.com/client/v4";
const RESERVADOS = new Set(["subir", "www", "sitegratis", "api", "mail", "admin", "painel"]);
const OFF = "nitro:offline";
const PAG_OFF = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Fora do ar</title><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#f6f6f6;color:#333;font-family:system-ui,sans-serif;text-align:center;padding:24px}h1{font-size:22px;margin:0 0 8px}p{margin:0;color:#777}</style></head><body><div><h1>Este site está temporariamente fora do ar</h1><p>Volte em breve.</p></div></body></html>`;
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
          const cd = x.canonical_deployment || x.latest_deployment, msg = (cd && cd.deployment_trigger && cd.deployment_trigger.metadata && cd.deployment_trigger.metadata.commit_message) || "";
          out.push({ nome: x.name, ativo: msg !== OFF, pages: x.subdomain, dominios: x.domains || [], quando: (x.latest_deployment && x.latest_deployment.created_on) || x.created_on });
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
      fd.append("commit_message", "nitro:site");
      if (b.headers) fd.append("_headers", new Blob([b.headers]), "_headers");
      if (b.redirects) fd.append("_redirects", new Blob([b.redirects]), "_redirects");
      const dp = await cf(env, `/accounts/${ACC}/pages/projects/${nome}/deployments`, { method: "POST", body: fd });
      if (!dp.success) return j({ ok: false, erro: "Publicação: " + erroDe(dp) }, 502);
      return j({ ok: true, id: dp.result.id, pages: "https://" + nome + ".pages.dev" });
    }

    // Tira o site do ar (publica uma página "fora do ar") ou volta ele (restaura a versão anterior)
    if (rota === "ar") {
      const nome = String(b.nome || "").toLowerCase();
      const g = await pegarProjeto(env, nome); if (g.erro) return j({ ok: false, erro: g.erro }, g.st);
      if (b.acao === "desligar") {
        const t = await cf(env, `/accounts/${ACC}/pages/projects/${nome}/upload-token`);
        if (!t.success) return j({ ok: false, erro: "Token de upload: " + erroDe(t) }, 502);
        const jwt = t.result.jwt, dados = new TextEncoder().encode(PAG_OFF);
        let bin = ""; for (const c of dados) bin += String.fromCharCode(c);
        const b64 = btoa(bin);
        const hash = B3(new TextEncoder().encode(b64 + "html")).slice(0, 32);
        const miss = await jwtFetch(jwt, "/pages/assets/check-missing", { hashes: [hash] });
        if (!miss.success) return j({ ok: false, erro: erroDe(miss) }, 502);
        if ((miss.result || []).length) {
          const up = await jwtFetch(jwt, "/pages/assets/upload", [{ key: hash, value: b64, metadata: { contentType: "text/html" }, base64: true }]);
          if (!up.success) return j({ ok: false, erro: erroDe(up) }, 502);
        }
        const uh = await jwtFetch(jwt, "/pages/assets/upsert-hashes", { hashes: [hash] });
        if (!uh.success) return j({ ok: false, erro: erroDe(uh) }, 502);
        const fd = new FormData();
        fd.append("manifest", JSON.stringify({ "/index.html": hash }));
        fd.append("branch", "main");
        fd.append("commit_message", OFF);
        const dp = await cf(env, `/accounts/${ACC}/pages/projects/${nome}/deployments`, { method: "POST", body: fd });
        if (!dp.success) return j({ ok: false, erro: "Não consegui tirar do ar: " + erroDe(dp) }, 502);
        return j({ ok: true, id: dp.result.id });
      }
      // ligar: acha a última versão de verdade e restaura
      const ls = await cf(env, `/accounts/${ACC}/pages/projects/${nome}/deployments?env=production&per_page=25`);
      if (!ls.success) return j({ ok: false, erro: erroDe(ls) }, 502);
      const alvo = (ls.result || []).find((d) => {
        const m = (d.deployment_trigger && d.deployment_trigger.metadata && d.deployment_trigger.metadata.commit_message) || "";
        return m !== OFF && d.latest_stage && d.latest_stage.name === "deploy" && d.latest_stage.status === "success";
      });
      if (!alvo) return j({ ok: false, erro: "Não achei a versão anterior. Publique o zip de novo." }, 404);
      const rb = await cf(env, `/accounts/${ACC}/pages/projects/${nome}/deployments/${alvo.id}/rollback`, { method: "POST" });
      if (!rb.success) return j({ ok: false, erro: "Não consegui voltar ao ar: " + erroDe(rb) }, 502);
      return j({ ok: true, id: rb.result && rb.result.id });
    }

    // Exclui o site (e limpa endereço antigo no agencianitro.com.br, se houver)
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
