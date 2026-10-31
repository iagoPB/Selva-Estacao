// servidor da estação: amarra os módulos, serve a API, a interface web e o websocket
const path = require("path");
const os = require("os");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");

const fs = require("fs");
const crypto = require("crypto");
const armazenamento = require("./armazenamento");
const simulador = require("./simulador");
const identificador = require("./identificador");
const catalogo = require("./catalogo");
const serialArduino = require("./serial-arduino");
const captura = require("./captura");
const estatisticas = require("./estatisticas");
const push = require("./push");
const eventos = require("./eventos");
const { resolverPeso } = require("./peso");
const { criarGatilho } = require("./gatilho");

// quem pode alterar a estação: o próprio PC e quem manda o token de admin (o app
// Electron lê de selva.config.json do lado do .exe).
// visitante no hotspot da feira só lê. ADMIN_REDE_LOCAL=1 libera a rede de casa
const ARQUIVO_TOKEN = path.join(armazenamento.PASTA, "admin-token");
let tokenCache = null;
function tokenAdmin() {
  if (tokenCache) return tokenCache;
  try {
    tokenCache = fs.readFileSync(ARQUIVO_TOKEN, "utf8").trim();
  } catch {
    tokenCache = crypto.randomBytes(16).toString("hex");
    fs.mkdirSync(path.dirname(ARQUIVO_TOKEN), { recursive: true });
    fs.writeFileSync(ARQUIVO_TOKEN, tokenCache);
  }
  return tokenCache;
}

function tokenConfere(enviado) {
  const esperado = tokenAdmin();
  if (typeof enviado !== "string" || enviado.length !== esperado.length) return false;
  return crypto.timingSafeEqual(Buffer.from(enviado), Buffer.from(esperado));
}

function ehAdmin(req) {
  if (tokenConfere(req.headers["x-selva-admin"])) return true;
  const ip = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if (ip === "::1" || ip.startsWith("127.")) return true;
  const [a, b] = ip.split(".").map(Number);
  if (process.env.ADMIN_REDE_LOCAL === "1") {
    if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return true;
  }
  return false;
}

function textoPeso(v) {
  if (v.peso_g == null) return null;
  const valor = v.peso_g >= 1000 ? `${(v.peso_g / 1000).toFixed(1)} kg` : `${v.peso_g} g`;
  return v.peso_estimado ? `~${valor} (estimado)` : valor;
}

function iniciar({ porta = 3000, simular = true } = {}) {
tokenAdmin();   // gera dados/admin-token na primeira subida
const app = express();
const servidorHttp = http.createServer(app);
const wss = new WebSocketServer({ server: servidorHttp });
let controleSim = null;

// CORS só pro app Electron (file:// chega com Origin "null")
app.use((req, res, next) => {
  if (req.headers.origin === "null" || req.headers.origin === "file://") {
    res.set("Access-Control-Allow-Origin", req.headers.origin);
    res.set("Access-Control-Allow-Headers", "Content-Type, X-Selva-Admin");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "15mb" }));

// toda rota que altera algo é POST; só quem é admin passa
app.use((req, res, next) => {
  if (req.method === "POST" && !ehAdmin(req)) {
    return res.status(403).json({ erro: "somente_leitura", detalhe: "só o app com token (ou a própria caixa) altera a estação" });
  }
  next();
});

app.get("/api/acesso", (req, res) => {
  res.json({ admin: ehAdmin(req) });
});

// aba Registro, só admin (tem porta serial, modelo da IA, erro cru)
app.get("/api/eventos", (req, res) => {
  if (!ehAdmin(req)) return res.status(403).json({ erro: "somente_leitura" });
  const limite = Math.min(Number(req.query.limite || 200), eventos.MAXIMO);
  res.json(eventos.ultimos(limite));
});

// a mesma ui serve o Electron, os celulares e a TV
app.use(express.static(path.join(__dirname, "..", "app", "ui"), {
  setHeaders(res, arquivo) {
    if (arquivo.endsWith(".webmanifest")) res.type("application/manifest+json");
    // o navegador precisa sempre buscar o service worker novo
    if (arquivo.endsWith("sw.js")) res.set("Cache-Control", "no-cache");
  }
}));

const PASTA_FOTOS = path.join(armazenamento.PASTA, "fotos");
fs.mkdirSync(PASTA_FOTOS, { recursive: true });
app.use("/fotos", express.static(PASTA_FOTOS));

// express 4 não pega rejeição de rota async
const seguro = fn => (req, res) => fn(req, res).catch(e => {
  console.log(`[api] ${req.path}: ${e.message}`);
  res.status(500).json({ erro: "interno", detalhe: e.message });
});

// cada espécie já vem com a ficha (foto, sobre, fonte, curiosidades, pesoMedio, fichaOk)
app.get("/api/especies", (req, res) => {
  res.json(catalogo.todos());
});

// rota manual pra forçar a ficha agora (curl ou Laboratório, ainda sem botão no app)
app.post("/api/especies/:nome/completar", seguro(async (req, res) => {
  const e = await catalogo.completarAgora(req.params.nome, identificador);
  if (!e) return res.status(404).json({ erro: "especie_desconhecida" });
  res.json(e);
}));

app.get("/api/visitas", (req, res) => {
  const limite = Math.min(Number(req.query.limite || 30), 500);
  let visitas = armazenamento.todas();
  // ?especie= pra ficha não baixar tudo
  if (req.query.especie) visitas = visitas.filter(v => v.especie === req.query.especie);
  res.json(visitas.slice(0, limite));
});

app.get("/api/resumo", (req, res) => {
  const visitas = armazenamento.todas();
  const hojeStr = new Date().toISOString().slice(0, 10);

  const porEspecieMapa = new Map();
  const porHora = Array.from({ length: 24 }, () => 0);

  for (const v of visitas) {
    // todas() vem da mais recente pra mais antiga
    const atual = porEspecieMapa.get(v.especie) || { especie: v.especie, emoji: v.emoji, visitas: 0, somaPeso: 0, comPeso: 0, ultima: v.timestamp };
    atual.visitas += 1;
    atual.primeira = v.timestamp;
    // peso estimado/suspeito fica fora da média, senão a estimativa realimenta ela mesma
    if (v.peso_g != null && !v.peso_estimado && !v.peso_suspeito) { atual.somaPeso += v.peso_g; atual.comPeso += 1; }
    porEspecieMapa.set(v.especie, atual);
    porHora[new Date(v.timestamp).getHours()] += 1;
  }

  const porEspecie = [...porEspecieMapa.values()]
    .map(e => ({
      especie: e.especie, emoji: e.emoji, visitas: e.visitas,
      ultima: e.ultima, primeira: e.primeira,
      pesoMedio_g: e.comPeso ? Math.round(e.somaPeso / e.comPeso) : null
    }))
    .sort((a, b) => b.visitas - a.visitas);

  res.json({
    total: visitas.length,
    hoje: visitas.filter(v => v.timestamp.startsWith(hojeStr)).length,
    especies: porEspecie.length,
    ultima: visitas[0] || null,
    porEspecie,
    porHora,
    disparos: estatisticas.resumo()
  });
});

// ===== IA e estação virtual =====
app.get("/api/config", (req, res) => {
  res.json({ ia: identificador.temChave(), simulando: !!controleSim });
});

app.post("/api/config", (req, res) => {
  const chave = String(req.body.chave || "").trim();
  if (!chave) return res.status(400).json({ erro: "chave vazia" });
  identificador.salvarChave(chave);
  eventos.registrar("sistema", "Chave da IA trocada pelo app");
  res.json({ ok: true, ia: true });
});

app.get("/api/modelos", async (req, res) => {
  res.json(await identificador.listarModelos());
});

app.post("/api/simulador", (req, res) => {
  const ligado = !!req.body.ligado;
  if (ligado && !controleSim) {
    controleSim = simulador.iniciar(registrarVisita);
    console.log("[simulador] religado pelo app");
    eventos.registrar("sistema", "Simulador de visitas ligado pelo app");
  } else if (!ligado && controleSim) {
    controleSim.parar();
    controleSim = null;
    console.log("[simulador] desligado pelo app");
    eventos.registrar("sistema", "Simulador de visitas desligado pelo app");
  }
  res.json({ simulando: !!controleSim });
});

// teste do Laboratório, identifica sem registrar visita
app.post("/api/identificar", async (req, res) => {
  const { imagem_base64, mime } = req.body || {};
  if (!imagem_base64) return res.status(400).json({ erro: "sem imagem" });
  try {
    res.json(await identificador.identificar(imagem_base64, mime));
  } catch (e) {
    res.status(500).json({ erro: "interno", detalhe: e.message });
  }
});

// estação virtual: a webcam do navegador viu movimento e mandou a foto
app.post("/api/visita-virtual", seguro(async (req, res) => {
  const { imagem_base64 } = req.body || {};
  if (!imagem_base64) return res.status(400).json({ erro: "sem imagem" });
  const r = await gatilho.avaliar([Buffer.from(imagem_base64, "base64")], {
    peso_g: null, temperatura_c: null, umidade_pct: null,
    motivo: "camera", origem: "estacao-virtual"
  });
  res.json(r);
}));

// botão do Laboratório, finge um disparo de sensor
app.post("/api/disparo/teste", seguro(async (req, res) => {
  const r = await gatilho.processar({
    peso_g: null, temperatura_c: null, umidade_pct: null,
    motivo: "teste", origem: "estacao"
  });
  res.json(r);
}));

app.get("/api/camera", (req, res) => {
  res.json({ dispositivo: captura.acharWebcam() });
});

push.rotas(app);

// o WS também filtra por admin (os eventos têm porta serial, erro cru etc).
// o Electron manda o token no header do upgrade, no navegador vale ?admin=<token>
wss.on("connection", (ws, req) => {
  let token = null;
  try { token = new URL(req.url, "http://x").searchParams.get("admin"); } catch {}
  ws.admin = ehAdmin(req) || tokenConfere(token);
});

function transmitir(mensagem) {
  const texto = JSON.stringify(mensagem);
  for (const cliente of wss.clients) {
    if (cliente.readyState !== 1) continue;
    if (mensagem.tipo === "evento" && !cliente.admin) continue;
    cliente.send(texto);
  }
}
// registro em tempo real (só admin) e ficha que ganhou foto/texto
eventos.aoRegistrar(evento => transmitir({ tipo: "evento", evento }));
catalogo.aoAtualizar(especie => transmitir({ tipo: "especie", especie }));

function detalhesVisita(visita) {
  return [textoPeso(visita), visita.temperatura_c != null ? `${visita.temperatura_c} °C` : null,
    visita.confianca != null ? `IA ${Math.round(visita.confianca * 100)}%` : null].filter(Boolean).join(" · ");
}

// extras.identificada = a IA reconheceu (manda push); extras.disparo = número pro registro
function registrarVisita(visita, extras = {}) {
  armazenamento.adicionar(visita);
  transmitir({ tipo: "visita", visita });
  const peso = textoPeso(visita);
  console.log(`[visita] ${visita.especie}${peso ? " · " + peso : ""} · ${new Date(visita.timestamp).toLocaleTimeString("pt-BR")}`);

  if (extras.identificada) {
    push.notificar({
      titulo: `${visita.especie} na estação`, corpo: detalhesVisita(visita) || "Visita registrada",
      url: "/", tag: `selva-${visita.especie}`, imagem: visita.foto, disparo: extras.disparo
    }).catch(e => console.log(`[push] ${e.message}`));
  } else {
    eventos.registrar("visita", `Visita simulada: ${visita.especie}${peso ? ", " + peso : ""}`, { especie: visita.especie, simulada: true });
  }
}

// chamado quando a catalogação em segundo plano termina e a espécie é nova mesmo:
// a visita ganha emoji e nome científico, o app recebe a descoberta e sai um push
function aoDescobrir(especie, visita, disparo) {
  const atualizada = armazenamento.atualizar(visita.id, {
    emoji: especie.emoji || visita.emoji,
    cientifico: visita.cientifico || especie.cientifico || ""
  }) || visita;
  transmitir({ tipo: "descoberta", especie: especie.nome, emoji: especie.emoji, visita: atualizada });
  // mesma tag do push "X na estação" que já saiu, no celular esse substitui aquele
  push.notificar({
    titulo: "Nova espécie catalogada!",
    corpo: `${especie.nome} passou pela estação pela primeira vez. ${detalhesVisita(atualizada)}`,
    url: "/", tag: `selva-${especie.nome}`, imagem: atualizada.foto, disparo
  }).catch(e => console.log(`[push] ${e.message}`));
}

function gravarFoto(nome, buffer) {
  armazenamento.gravarSeguro(path.join(PASTA_FOTOS, nome), buffer);
  return `/fotos/${nome}`;
}

const gatilho = criarGatilho({
  capturar: captura.capturar,
  identificarLote: identificador.identificarLote,
  temChave: identificador.temChave,
  identificador,
  catalogo,
  resolverPeso,
  visitasAnteriores: () => armazenamento.todas(),
  registrarVisita,
  aoDescobrir,
  registrarDisparo: estatisticas.registrarDisparo,
  gravarFoto,
  log: console.log
});

// primeira execução: semeia um histórico pros gráficos não nascerem vazios
if (simular && armazenamento.carregar().length === 0) {
  for (const v of simulador.gerarHistorico(60)) armazenamento.adicionar(v);
  console.log("[simulador] histórico inicial de 60 visitas gerado");
}
if (simular) {
  controleSim = simulador.iniciar(registrarVisita);
  console.log("[simulador] gerando uma visita a cada 20-45 s (desligue com SIMULAR=0 ou pelo app)");
}

// cada disparo do Arduino acorda a câmera, o peso estável chega depois
eventos.registrar("sistema", "Ligando o leitor serial do Arduino");
serialArduino.iniciar(sensores => gatilho.processar(sensores), (n, peso) => gatilho.receberPeso(n, peso));

// fichas incompletas são tentadas de novo em segundo plano
catalogo.vigiarFichas(identificador);

servidorHttp.listen(porta, () => {
  const camera = captura.acharWebcam();
  eventos.registrar("sistema", `Estação no ar na porta ${porta}: IA ${identificador.temChave() ? "configurada" : "sem chave"}, `
    + `câmera ${camera || "não encontrada"}, simulador ${controleSim ? "ligado" : "desligado"}`, { porta, ia: identificador.temChave(), camera });
  console.log(`\nselva! estação no ar (token de admin em ${ARQUIVO_TOKEN}):`);
  console.log(`  neste computador:  http://localhost:${porta}`);
  for (const rede of Object.values(os.networkInterfaces()).flat()) {
    if (rede && rede.family === "IPv4" && !rede.internal) {
      console.log(`  na rede (celulares): http://${rede.address}:${porta}`);
    }
  }
  console.log();
});

return servidorHttp;
}

module.exports = { iniciar, ehAdmin, tokenAdmin };

// node servidor.js sobe a estação; importado (testes) não
if (require.main === module) {
  iniciar({
    porta: Number(process.env.PORTA || 3000),
    simular: process.env.SIMULAR !== "0"
  });
}
