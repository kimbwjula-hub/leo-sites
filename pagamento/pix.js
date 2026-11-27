// Gera o código Pix Copia e Cola (BR Code estático)
function pixCampo(id, v) { return id + String(v.length).padStart(2, "0") + v; }
function pixCRC(s) {
  var c = 0xFFFF;
  for (var i = 0; i < s.length; i++) {
    c ^= s.charCodeAt(i) << 8;
    for (var j = 0; j < 8; j++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
  }
  return c.toString(16).toUpperCase().padStart(4, "0");
}
function pixTexto(t, max) {
  return String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9 .\-]/g, "").trim().slice(0, max);
}
function pixValor(v) {
  var n = parseFloat(String(v || "").replace(/\./g, "").replace(",", "."));
  return isFinite(n) && n > 0 ? n.toFixed(2) : "";
}
function pixCodigo(o) {
  var chave = String(o.chave || "").trim();
  var conta = pixCampo("00", "br.gov.bcb.pix") + pixCampo("01", chave);
  var d = pixTexto(o.desc, 40);
  if (d && conta.length + 4 + d.length <= 99) conta += pixCampo("02", d);
  var p = pixCampo("00", "01") + pixCampo("01", "12") + pixCampo("26", conta) + pixCampo("52", "0000") + pixCampo("53", "986");
  var v = pixValor(o.valor);
  if (v) p += pixCampo("54", v);
  p += pixCampo("58", "BR") + pixCampo("59", pixTexto(o.nome, 25) || "Recebedor") + pixCampo("60", pixTexto(o.cidade, 15) || "Brasil") + pixCampo("62", pixCampo("05", "***"));
  p += "6304";
  return p + pixCRC(p);
}
