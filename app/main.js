// cliente Electron do selva!. procura a estação (ESTACAO= no ambiente, depois
// rede local, depois localhost) e abre a interface dela.
// se não acha nenhuma pergunta antes de cair no modo demonstração
const { app, BrowserWindow, Menu, dialog, session, nativeTheme } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");

const PORTA = 3000;

// selva.config.json ao lado do .exe (ou na pasta de dados do usuário) com
// { "token": "<conteúdo de dados/admin-token da caixa>" } libera o Laboratório
function lerConfig() {
  const pastas = [process.env.PORTABLE_EXECUTABLE_DIR, path.dirname(process.execPath), app.getPath("userData")].filter(Boolean);
  for (const pasta of pastas) {
    try {
      return { ...JSON.parse(fs.readFileSync(path.join(pasta, "selva.config.json"), "utf8")), origem: pasta };
    } catch {}
  }
  return {};
}

function caminhoDaEstacao() {
  // empacotado a pasta estacao/ vai em resources/ (extraResources), em dev é a pasta irmã
  return app.isPackaged
    ? path.join(process.resourcesPath, "estacao", "servidor.js")
    : path.join(__dirname, "..", "estacao", "servidor.js");
}

async function responde(url, ms) {
  try {
    const r = await fetch(`${url}/api/acesso`, { signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch {
    return false;
  }
}

// testa todos os ips /24 das redes deste pc (o hotspot da feira muda de faixa todo dia)
async function varrerRede() {
  const bases = new Set();
  for (const lista of Object.values(os.networkInterfaces())) {
    for (const r of lista || []) {
      if (r.family === "IPv4" && !r.internal) bases.add(r.address.split(".").slice(0, 3).join("."));
    }
  }
  // os ips deste pc ficam de fora, senão um simulador rodando aqui aparece antes da caixa
  const meus = new Set();
  for (const lista of Object.values(os.networkInterfaces())) {
    for (const r of lista || []) if (r.family === "IPv4") meus.add(r.address);
  }
  const candidatos = [];
  for (const b of bases) for (let i = 1; i < 255; i++) {
    if (!meus.has(`${b}.${i}`)) candidatos.push(`http://${b}.${i}:${PORTA}`);
  }
  const achados = [];
  // lotes de 64 pra não estourar o limite de conexões
  for (let i = 0; i < candidatos.length; i += 64) {
    const lote = candidatos.slice(i, i + 64);
    const ok = await Promise.all(lote.map(u => responde(u, 900)));
    lote.forEach((u, k) => { if (ok[k]) achados.push(u); });
    if (achados.length) break;
  }
  return achados[0] || null;
}

async function procurarEstacao() {
  const forcada = (process.env.ESTACAO || "").replace(/\/$/, "");
  if (forcada) return { url: forcada, como: "endereço fixo" };
  const local = await varrerRede();
  if (local) return { url: local, como: "rede local" };
  if (await responde(`http://localhost:${PORTA}`, 800)) return { url: `http://localhost:${PORTA}`, como: "este PC" };
  return null;
}

function modoDemonstracao() {
  process.env.SELVA_DADOS = path.join(app.getPath("userData"), "dados");
  const { iniciar } = require(caminhoDaEstacao());
  iniciar({ porta: PORTA, simular: true });
  console.log("[selva] estação embutida iniciada (modo demonstração)");
  return { url: `http://localhost:${PORTA}`, como: "demonstração (simulador)" };
}

async function escolherEstacao() {
  for (;;) {
    const achada = await procurarEstacao();
    if (achada) return achada;
    const { response } = await dialog.showMessageBox({
      type: "question",
      title: "selva!",
      message: "Nenhuma estação encontrada",
      detail: "A caixa está ligada e na mesma rede deste PC?\n\n" +
        "O modo demonstração sobe uma estação de mentira neste PC, com visitas simuladas.",
      buttons: ["Procurar de novo", "Modo demonstração", "Sair"],
      defaultId: 0,
      cancelId: 2
    });
    if (response === 1) return modoDemonstracao();
    if (response === 2) { app.quit(); return null; }
  }
}

function criarJanela(estacao) {
  const janela = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    // mesma cor do papel do estilo.css, senão pisca antes da primeira pintura
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#16191A" : "#F5F0E4",
    title: `selva! · ${estacao.como}`,
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  Menu.setApplicationMenu(null);
  janela.on("page-title-updated", e => e.preventDefault());
  if (estacao.como === "demonstração (simulador)") {
    janela.loadFile(path.join(__dirname, "ui", "index.html"), { query: { estacao: estacao.url } });
  } else {
    // estação de verdade serve a própria interface, aí atualizar a caixa já atualiza o exe
    janela.loadURL(estacao.url);
  }
}

app.whenReady().then(async () => {
  const config = lerConfig();
  const estacao = await escolherEstacao();
  if (!estacao) return;
  if (config.token) {
    // token de admin em toda requisição pra estação, inclusive no upgrade do
    // websocket (senão a aba Registro não recebe nada)
    const padroes = [`${estacao.url}/*`, `${estacao.url.replace(/^http/, "ws")}/*`];
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: padroes }, (detalhes, continuar) => {
      detalhes.requestHeaders["X-Selva-Admin"] = String(config.token);
      continuar({ requestHeaders: detalhes.requestHeaders });
    });
    console.log(`[selva] token de admin lido de ${config.origem}`);
  }
  console.log(`[selva] estação: ${estacao.url} (${estacao.como})`);
  criarJanela(estacao);
});
app.on("window-all-closed", () => app.quit());
