// web push pro celular. o app se inscreve aqui e a estação avisa quando
// identifica uma espécie. chaves VAPID geradas na primeira vez, ficam em
// dados/push.json junto com as inscrições
const fs = require("fs");
const path = require("path");
const armazenamento = require("./armazenamento");
const eventos = require("./eventos");

let webpush = null;
try {
  webpush = require("web-push");
} catch {
  // sem o pacote só não manda notificação
}

const ARQUIVO = path.join(armazenamento.PASTA, "push.json");
const CONTATO = "mailto:estacao-selva@example.com";
let dados = null;

function salvar() {
  armazenamento.gravarSeguro(ARQUIVO, JSON.stringify(dados, null, 2));
}

function carregar() {
  if (dados) return dados;
  try {
    dados = JSON.parse(fs.readFileSync(ARQUIVO, "utf8"));
  } catch {
    dados = {};
  }
  dados.inscricoes = dados.inscricoes || [];
  if (!dados.chaves && webpush) {
    dados.chaves = webpush.generateVAPIDKeys();
    salvar();
  }
  return dados;
}

function disponivel() {
  return !!webpush;
}

function inscrever(inscricao) {
  if (!inscricao || !inscricao.endpoint || !inscricao.keys || !inscricao.keys.p256dh || !inscricao.keys.auth) {
    return false;
  }
  carregar();
  dados.inscricoes = dados.inscricoes.filter(s => s.endpoint !== inscricao.endpoint);
  dados.inscricoes.push({ endpoint: inscricao.endpoint, keys: inscricao.keys });
  salvar();
  return true;
}

function cancelar(endpoint) {
  carregar();
  const antes = dados.inscricoes.length;
  dados.inscricoes = dados.inscricoes.filter(s => s.endpoint !== endpoint);
  if (dados.inscricoes.length !== antes) salvar();
}

// manda pra todos os inscritos. inscrição que deu 404/410 é removida
async function notificar({ titulo, corpo, url = "/", tag = "selva", imagem = null, disparo = null }) {
  if (!webpush) return { enviadas: 0 };
  carregar();
  if (!dados.inscricoes.length) return { enviadas: 0 };

  const inicio = Date.now();
  webpush.setVapidDetails(CONTATO, dados.chaves.publicKey, dados.chaves.privateKey);
  const payload = JSON.stringify({ titulo, corpo, url, tag, imagem });
  const mortas = new Set();
  const falhas = [];
  let enviadas = 0;

  await Promise.all(dados.inscricoes.map(async s => {
    try {
      await webpush.sendNotification(s, payload, { TTL: 3600, urgency: "high" });
      enviadas++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) mortas.add(s.endpoint);
      else {
        console.log(`[push] falha ao notificar (${e.statusCode || e.message})`);
        falhas.push(String(e.statusCode || e.message));
      }
    }
  }));

  if (mortas.size) {
    dados.inscricoes = dados.inscricoes.filter(s => !mortas.has(s.endpoint));
    salvar();
  }
  const total = enviadas + falhas.length;
  const ms = Date.now() - inicio;
  const celulares = `${total} celular${total === 1 ? "" : "es"}`;
  if (enviadas) {
    eventos.registrar("push", `Push "${titulo}" enviado a ${enviadas} de ${celulares}`, { disparo, ms, enviadas, total });
  } else if (falhas.length) {
    eventos.registrar("erro", `Push "${titulo}" falhou nos ${celulares} (${[...new Set(falhas)].join(", ")})`, { disparo, ms, enviadas, total });
  }
  return { enviadas };
}

function rotas(app) {
  app.get("/api/push/chave", (req, res) => {
    if (!webpush) return res.json({ disponivel: false });
    res.json({ disponivel: true, chave: carregar().chaves.publicKey });
  });

  app.post("/api/push/inscrever", (req, res) => {
    if (!webpush) return res.status(503).json({ erro: "push indisponível na estação" });
    if (!inscrever(req.body)) return res.status(400).json({ erro: "inscrição inválida" });
    res.json({ ok: true, total: dados.inscricoes.length });
  });

  app.post("/api/push/cancelar", (req, res) => {
    cancelar(String((req.body || {}).endpoint || ""));
    res.json({ ok: true });
  });

  app.post("/api/push/teste", async (req, res) => {
    const r = await notificar({
      titulo: "selva! está te avisando",
      corpo: "As notificações da estação estão funcionando.",
      tag: "selva-teste"
    });
    res.json({ ok: true, ...r });
  });
}

module.exports = { rotas, notificar, disponivel };
