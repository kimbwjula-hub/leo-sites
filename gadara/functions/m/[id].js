// Entrega fotos e vídeos guardados no KV, com suporte a Range (necessário para vídeo no iPhone)
export async function onRequestGet({ request, env, params }) {
  const id = String(params.id || "").replace(/[^a-z0-9p]/g, "");
  const c = await env.CAT.get("catalog", "json");
  const baseId = id.replace(/p$/, "");
  const it = c && c.items.find((x) => x.id === baseId);
  if (!it) return new Response("Não encontrado", { status: 404 });
  const isPoster = id.endsWith("p");
  const mime = isPoster ? "image/jpeg" : (it.mime || (it.type === "video" ? "video/mp4" : "image/jpeg"));
  const n = isPoster ? 1 : (it.chunks || 1);
  const key = (i) => `m:${id}:${i}`;

  if (n === 1) {
    const buf = await env.CAT.get(key(0), "arrayBuffer");
    if (!buf) return new Response("Não encontrado", { status: 404 });
    return ranged(request, buf, mime);
  }

  // vídeo em vários pedaços: monta só o trecho pedido
  const size = it.size;
  const CH = it.chunkSize || 20 * 1024 * 1024;
  let start = 0, end = size - 1, status = 200;
  const r = request.headers.get("range");
  if (r) {
    const mt = r.match(/bytes=(\d*)-(\d*)/);
    if (mt) {
      if (mt[1] === "") { start = Math.max(0, size - Number(mt[2])); }
      else { start = Number(mt[1]); if (mt[2]) end = Math.min(size - 1, Number(mt[2])); }
      status = 206;
    }
  }
  if (status === 206 && end - start > 8 * 1024 * 1024) end = start + 8 * 1024 * 1024 - 1;
  const first = Math.floor(start / CH), last = Math.floor(end / CH);
  const { readable, writable } = new TransformStream();
  (async () => {
    const w = writable.getWriter();
    for (let i = first; i <= last; i++) {
      const buf = await env.CAT.get(key(i), "arrayBuffer");
      if (!buf) break;
      const s = i === first ? start - i * CH : 0;
      const e = i === last ? end - i * CH + 1 : buf.byteLength;
      await w.write(new Uint8Array(buf, s, e - s));
    }
    await w.close();
  })();
  const h = { "content-type": mime, "accept-ranges": "bytes", "content-length": String(end - start + 1), "cache-control": "public, max-age=86400" };
  if (status === 206) h["content-range"] = `bytes ${start}-${end}/${size}`;
  return new Response(readable, { status, headers: h });
}

function ranged(request, buf, mime) {
  const size = buf.byteLength;
  const r = request.headers.get("range");
  const h = { "content-type": mime, "accept-ranges": "bytes", "cache-control": "public, max-age=86400" };
  if (r) {
    const mt = r.match(/bytes=(\d*)-(\d*)/);
    if (mt) {
      let start, end;
      if (mt[1] === "") { start = Math.max(0, size - Number(mt[2])); end = size - 1; }
      else { start = Number(mt[1]); end = mt[2] ? Math.min(size - 1, Number(mt[2])) : size - 1; }
      h["content-range"] = `bytes ${start}-${end}/${size}`;
      h["content-length"] = String(end - start + 1);
      return new Response(buf.slice(start, end + 1), { status: 206, headers: h });
    }
  }
  h["content-length"] = String(size);
  return new Response(buf, { headers: h });
}
