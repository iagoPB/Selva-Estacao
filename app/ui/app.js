// interface do selva!. a mesma página roda no Electron, no celular e na TV,
// só muda o endereço da estação (no Electron vem por ?estacao=, no navegador
// é quem serviu a página)
const params = new URLSearchParams(location.search);
const ESTACAO = (location.protocol === "file:" && params.get("estacao")
  ? params.get("estacao") : location.origin).replace(/\/$/, "");

const el = id => document.getElementById(id);

// todo texto que vem da IA ou do catálogo passa por aqui antes de ir pro HTML
function esc(valor) {
  return String(valor ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const tooltip = el("tooltip");

// meta: nome -> ficha do catálogo da estação (cientifico, emoji, wiki, foto, sobre...)
// wiki: nome -> {thumb, extract, url, fonteNome}, o que vai pra tela.
// a ficha vem pronta da estação, a Wikipédia aqui só completa o que faltou
const meta = new Map();
const wiki = new Map();

async function carregarMeta() {
  const especies = await fetch(`${ESTACAO}/api/especies`).then(r => r.json());
  for (const e of especies) receberEspecie(e);
  // em segundo plano pra não segurar o diário nem o ws
  for (const e of especies) if (!e.foto || !e.sobre) buscarWiki(e).catch(() => {});
}

// o que a estação tem vale mais que o que o aparelho achou sozinho
function receberEspecie(e) {
  // o aviso pelo ws vem sem alguns campos (ex.: descoberta), então junta com o que já tinha
  meta.set(e.nome, { ...(meta.get(e.nome) || {}), ...e });
  const atual = wiki.get(e.nome) || {};
  wiki.set(e.nome, {
    thumb: e.foto || atual.thumb || null,
    extract: e.sobre || atual.extract || "",
    url: e.fonte || atual.url || null,
    fonteNome: e.fonteNome || atual.fonteNome || null,
    // crédito acompanha a foto, se a da estação chegou vale o dela
    fotoFonte: e.foto ? (e.fotoFonte || null) : (atual.fotoFonte || null),
    fotoUrl: e.foto ? (e.fotoUrl || null) : (atual.fotoUrl || null)
  });
}

// mesmos filtros da estação, menos que isso é um nome solto e não um texto
const MINIMO_SOBRE = 60;
const PRAZO_WIKI_MS = 8000;
const fotoOk = u => typeof u === "string" && /\.(jpe?g|png|gif|webp)$/i.test(u.split("?")[0]);

// {thumb, extract, url} só com o que presta, ou null se não sobrou nada
function limpar(i) {
  if (!i) return null;
  const extract = String(i.extract || "").trim();
  const info = {
    thumb: fotoOk(i.thumb) ? i.thumb : null,
    extract: extract.length >= MINIMO_SOBRE ? extract : "",
    url: i.url || null
  };
  return info.thumb || info.extract ? info : null;
}

// Wikipédia pt pro que a estação ainda não tem, uma tentativa por espécie
const wikiTentada = new Set();
async function buscarWiki(e) {
  if (wikiTentada.has(e.nome)) return;
  wikiTentada.add(e.nome);
  const chave = `selvaWiki:${e.wiki}`;
  let info = null;
  try { info = limpar(JSON.parse(localStorage.getItem(chave))); } catch {}
  if (!info) {
    try {
      const r = await fetch(`https://pt.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(e.wiki)}`,
        { signal: AbortSignal.timeout(PRAZO_WIKI_MS) });
      if (!r.ok) return;
      const j = await r.json();
      if (j.type === "disambiguation" || j.type === "not_found") return;
      info = limpar({
        thumb: j.thumbnail ? j.thumbnail.source : null,
        extract: j.extract,
        url: j.content_urls && j.content_urls.desktop ? j.content_urls.desktop.page : null
      });
      // resposta vazia não fica presa no cache
      if (!info) return;
      try { localStorage.setItem(chave, JSON.stringify(info)); } catch {}
    } catch {
      return;   // offline, fica no emoji
    }
  }
  const atual = wiki.get(e.nome) || {};
  const usaTexto = !atual.extract && !!info.extract;
  const usaFoto = !atual.thumb && !!info.thumb;
  wiki.set(e.nome, {
    thumb: atual.thumb || info.thumb || null,
    extract: atual.extract || info.extract || "",
    url: usaTexto ? info.url : (atual.url || info.url || null),
    fonteNome: usaTexto ? "Wikipedia" : (atual.fonteNome || null),
    fotoFonte: usaFoto ? "Wikipédia" : (atual.fotoFonte || null),
    fotoUrl: usaFoto ? info.url : (atual.fotoUrl || null)
  });
  if (usaTexto || usaFoto) atualizarEspecieNaTela(e.nome);
}

// redesenha diário, guia e ficha aberta quando a ficha da espécie chega ou melhora
function atualizarEspecieNaTela(nome) {
  for (const li of el("feed").querySelectorAll(".entrada")) {
    if (li.dataset.especie !== nome || !li._visita) continue;
    const foto = li.querySelector(".foto");
    if (foto) foto.innerHTML = fotoDaVisita(li._visita);
  }
  if (!el("vistaGuia").hidden) desenharGuia();
  if (!el("fichaFundo").hidden && el("fichaNome").textContent === nome) desenharCabecaFicha(nome);
}

// no diário vai a foto bonita da espécie (a da câmera fica na galeria da ficha).
// sem Wikipédia usa a da estação, sem nada emoji ou a pata
function fotoDaVisita(v) {
  const w = wiki.get(v.especie);
  if (w && w.thumb) return `<img src="${esc(w.thumb)}" alt="" loading="lazy">`;
  if (v.foto) return `<img src="${esc(ESTACAO + v.foto)}" alt="${esc(v.especie)}" loading="lazy">`;
  const emoji = v.emoji || (meta.get(v.especie) || {}).emoji;
  if (emoji) return `<span class="fotoEmoji">${esc(emoji)}</span>`;
  return `<svg aria-hidden="true"><use href="#sil-pata"/></svg>`;
}

// uma das cinco tintas de fundo, escolhida pelo nome
function corDaEspecie(nome) {
  let soma = 0;
  for (const c of String(nome)) soma += c.charCodeAt(0);
  return `g${(soma % 5) + 1}`;
}

function horaRelativa(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "agora";
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return "em " + new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

// hora grande do diário; se não foi hoje, o dia vai embaixo
function horaDoDia(iso) {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return hm;
  return `${hm}<small>${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}</small>`;
}

// ex.: "quarta, 21 de outubro" no título do painel
function escreverData() {
  const texto = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  el("dataHoje").textContent = texto.replace("-feira", "");
}

function formatoPeso(g) {
  if (g == null) return "-";
  const texto = g >= 1000 ? `${(g / 1000).toFixed(1)} kg` : `${Math.round(g * 10) / 10} g`;
  return texto.replace(".", ",");
}

function formatoTemp(c) {
  return `${String(Math.round(c * 10) / 10).replace(".", ",")} °C`;
}

// peso típico da espécie no catálogo (mesma conta do peso.js da estação)
function pesoTipico(e) {
  if (!e) return null;
  if (e.pesoMin != null && e.pesoMax != null) return Math.round((e.pesoMin + e.pesoMax) / 2);
  return e.pesoMedio != null ? Math.round(e.pesoMedio) : null;
}

// peso da visita com o "~" quando foi estimado em vez de medido
function pesoDaVisita(v) {
  if (v.peso_g == null) return "-";
  return v.peso_estimado ? `~${formatoPeso(v.peso_g)}` : formatoPeso(v.peso_g);
}

const ORIGEM_PESO = {
  balanca: "Peso medido pela balança oculta",
  media_estacao: "Peso estimado pela média do que a estação já pesou desta espécie",
  referencia: "Peso estimado pelo peso típico da espécie (a balança não pesou este visitante)"
};

function mostrarTooltip(texto, x, y) {
  tooltip.textContent = texto;
  tooltip.style.left = x + "px";
  tooltip.style.top = y + "px";
  tooltip.hidden = false;
}
function esconderTooltip() { tooltip.hidden = true; }
function ligarTooltip(alvo, texto) {
  alvo.addEventListener("mousemove", e => mostrarTooltip(texto, e.clientX, e.clientY));
  alvo.addEventListener("mouseleave", esconderTooltip);
}

// diário de visitas

// linha de dados da entrada: peso com carimbo, clima e confiança da IA
function dadosDaVisita(v) {
  const d = [];
  if (v.peso_suspeito && v.peso_g != null) {
    // balança leu algo surreal pra espécie (uma pata só, mão junto), mostra a
    // referência e o lido vai de observação
    d.push(`<span><b>~${esc(formatoPeso(v.peso_g))}</b><em class="carimbo estimado" title="Peso típico da espécie">estimado</em></span>`);
    const lido = v.peso_medido_g != null ? v.peso_medido_g : null;
    d.push(`<span class="alerta"><em class="carimbo suspeito" title="Medida fora do esperado para a espécie">suspeito</em>${lido != null ? "balança leu " + esc(formatoPeso(lido)) : "medida descartada"}</span>`);
  } else if (v.peso_suspeito) {
    d.push(`<span class="alerta"><em class="carimbo suspeito">suspeito</em></span>`);
  } else if (v.peso_g != null) {
    const titulo = ORIGEM_PESO[v.peso_origem] || ORIGEM_PESO.balanca;
    d.push(v.peso_estimado
      ? `<span><b>~${esc(formatoPeso(v.peso_g))}</b><em class="carimbo estimado" title="${titulo}">estimado</em></span>`
      : `<span><b>${esc(formatoPeso(v.peso_g))}</b><em class="carimbo medido" title="${titulo}">medido</em></span>`);
  }
  if (v.temperatura_c != null) d.push(`<span title="Temperatura do ar na hora da visita">${esc(formatoTemp(v.temperatura_c))}</span>`);
  if (v.umidade_pct != null) d.push(`<span title="Umidade relativa do ar na hora da visita">${esc(v.umidade_pct)} % umidade</span>`);
  if (v.confianca != null) d.push(`<span title="Confiança da identificação feita pela IA">IA ${Math.round(v.confianca * 100)} %</span>`);
  return d.join("");
}

// de onde veio a foto, rótulo pequeno em vez de carimbo
function origemDaVisita(v) {
  if (v.origem === "estacao-virtual") return `<span class="origem" title="Capturada pela webcam da estação virtual">estação virtual</span>`;
  if (v.origem === "estacao" && v.foto) return `<span class="origem" title="Fotografada pela câmera da estação">câmera da estação</span>`;
  return "";
}

// visitas que inauguraram uma espécie no catálogo (ganham o carimbo "nova espécie")
const descobertas = new Set();
function marcarDescobertas(visitas, resumo) {
  const total = new Map(resumo.porEspecie.map(e => [e.especie, e.visitas]));
  const naLista = new Map();
  for (const v of visitas) naLista.set(v.especie, (naLista.get(v.especie) || 0) + 1);
  // da mais antiga pra mais nova, só vale se a lista tem todas as visitas da espécie
  for (const v of [...visitas].reverse()) {
    const m = meta.get(v.especie);
    if (m && m.descoberta && naLista.get(v.especie) === total.get(v.especie)) {
      descobertas.add(v.id);
      naLista.delete(v.especie);
    }
  }
}

function cartaoVisita(v, nova = false) {
  const li = document.createElement("li");
  li.className = "entrada" + (nova ? " nova" : "");
  li.dataset.id = v.id;
  li.dataset.especie = v.especie;
  li._visita = v;
  const novaEspecie = descobertas.has(v.id);
  li.innerHTML = `
    <time datetime="${esc(v.timestamp)}">${horaDoDia(v.timestamp)}</time>
    <div class="foto ${corDaEspecie(v.especie)}">${fotoDaVisita(v)}</div>
    <div class="texto">
      <h3>${esc(v.especie)} <i>${esc(v.cientifico)}</i>${novaEspecie ? `<em class="carimbo nova">nova espécie</em>` : ""}</h3>
      <p class="dados">${dadosDaVisita(v)}${novaEspecie ? `<span class="nota">catalogada pela estação, primeira vez por aqui</span>` : ""}</p>
      ${origemDaVisita(v)}
    </div>`;
  li.addEventListener("click", () => abrirFicha(v.especie));
  return li;
}

// tiles e gráficos do painel
function desenharResumo(r) {
  // número com 4 dígitos ou mais encolhe pra não sair do tile
  for (const [id, valor] of [["tHoje", r.hoje], ["tTotal", r.total], ["tEspecies", r.especies]]) {
    const n = String(valor).length;
    el(id).textContent = valor;
    el(id).classList.toggle("medio", n === 4);
    el(id).classList.toggle("longo", n > 4);
  }
  el("tUltima").textContent = r.ultima ? horaRelativa(r.ultima.timestamp) : "-";
  el("tUltimaQuem").textContent = r.ultima ? r.ultima.especie : "";
  el("gHorasSub").textContent = r.total ? `todas as ${r.total} visitas` : "sem visitas ainda";

  const ge = el("gEspecies");
  ge.innerHTML = "";
  if (!r.porEspecie.length) ge.innerHTML = `<p class="nota">nenhuma visita registrada ainda</p>`;
  const maximo = Math.max(1, ...r.porEspecie.map(e => e.visitas));
  for (const e of r.porEspecie) {
    const linha = document.createElement("div");
    linha.className = "linhaRank";
    linha.innerHTML = `
      <span class="rnome">${esc(e.especie)}</span>
      <span class="rbarra" style="width:${(e.visitas / maximo) * 100}%"></span>
      <span class="rnum">${e.visitas}</span>`;
    ligarTooltip(linha, `${e.especie}: ${e.visitas} visitas · peso médio ${formatoPeso(e.pesoMedio_g)}`);
    linha.addEventListener("click", () => abrirFicha(e.especie));
    ge.appendChild(linha);
  }

  const gh = el("gHoras");
  gh.innerHTML = "";
  const maxHora = Math.max(1, ...r.porHora);
  const agora = new Date().getHours();
  r.porHora.forEach((qtd, hora) => {
    const col = document.createElement("div");
    col.className = "hCol" + (qtd === 0 ? " vazia" : "");
    col.style.height = qtd === 0 ? "2px" : `${(qtd / maxHora) * 100}%`;
    // o pico ganha o valor escrito em cima da barra
    if (qtd && qtd === maxHora) col.innerHTML = `<span class="hPico">${qtd}${hora === agora ? " · agora" : ""}</span>`;
    ligarTooltip(col, `${hora}h · ${qtd} visita${qtd === 1 ? "" : "s"}`);
    gh.appendChild(col);
  });
}

// navegação entre as páginas
function trocarVista(nome) {
  document.querySelectorAll(".navBotao").forEach(b => b.classList.toggle("ativo", b.dataset.vista === nome));
  el("vistaPainel").hidden = nome !== "painel";
  el("vistaGuia").hidden = nome !== "guia";
  el("vistaLab").hidden = nome !== "lab";
  el("vistaRegistro").hidden = nome !== "registro";
  if (nome === "guia") desenharGuia();
  if (nome === "lab") iniciarLab();
  if (nome === "registro") abrirRegistro();
}
document.querySelectorAll(".navBotao").forEach(b => b.addEventListener("click", () => trocarVista(b.dataset.vista)));

async function desenharGuia() {
  const [resumo, todas] = await Promise.all([
    fetch(`${ESTACAO}/api/resumo`).then(r => r.json()),
    fetch(`${ESTACAO}/api/visitas?limite=500`).then(r => r.json())
  ]).catch(() => [null, []]);
  if (!resumo) return;

  const contagem = new Map(resumo.porEspecie.map(e => [e.especie, e]));
  // o resumo já traz a última visita de cada espécie, a lista é só reserva
  const ultimaDe = new Map();
  for (const e of resumo.porEspecie) if (e.ultima) ultimaDe.set(e.especie, e.ultima);
  for (const v of todas) if (!ultimaDe.has(v.especie)) ultimaDe.set(v.especie, v.timestamp);

  const especies = [...meta.values()];
  const avistadas = especies.filter(e => contagem.has(e.nome)).length;
  el("guiaSub").textContent = `${avistadas} de ${especies.length} espécies do catálogo já passaram pela estação`;

  const grade = el("guiaGrade");
  grade.innerHTML = "";
  especies
    .sort((a, b) => ((contagem.get(b.nome) || {}).visitas || 0) - ((contagem.get(a.nome) || {}).visitas || 0))
    .forEach((e, i) => {
      const c = contagem.get(e.nome);
      const w = wiki.get(e.nome) || {};
      const carta = document.createElement("div");
      carta.className = "guiaCarta" + (c ? "" : " naoVista");
      const foto = w.thumb ? `<img src="${esc(w.thumb)}" alt="${esc(e.nome)}" loading="lazy">` : esc(e.emoji || "🐾");
      const dados = c
        ? `<p class="gcDados">
             <span><b>${c.visitas}</b> visita${c.visitas === 1 ? "" : "s"}</span>
             ${c.pesoMedio_g != null ? `<span>peso médio <b>${esc(formatoPeso(c.pesoMedio_g))}</b></span>` : ""}
           </p>
           ${ultimaDe.has(e.nome) ? `<p class="gcQuando">última visita ${horaRelativa(ultimaDe.get(e.nome))}</p>` : ""}`
        : "";
      const carimbos = (e.descoberta ? `<em class="carimbo verde">descoberta pela estação</em>` : "")
        + (c ? "" : `<em class="carimbo cinza">ainda não avistada</em>`);
      carta.innerHTML = `
        <div class="gcFoto">${foto}</div>
        <p class="kicker">nº ${String(i + 1).padStart(2, "0")} do catálogo</p>
        <h3 class="gcNome">${esc(e.nome)}</h3>
        <p class="gcCientifico">${esc(e.cientifico)}</p>
        ${dados}${carimbos}`;
      carta.addEventListener("click", () => abrirFicha(e.nome));
      grade.appendChild(carta);
    });
}

// laboratório (chave da IA, disparo de teste, foto e estação virtual)
const lab = { fotoBase64: null, fotoMime: null, stream: null, timer: null, quadroAnterior: null, ultimoDisparo: 0, aquecendo: 0 };

async function iniciarLab() {
  const cfg = await fetch(`${ESTACAO}/api/config`).then(r => r.json()).catch(() => null);
  if (!cfg) return;
  el("chkSim").checked = cfg.simulando;
  desenharEstadoIa(cfg.ia);
  desenharDisparos();
}

// quantos disparos viraram visita e quantos foram alarme falso
async function desenharDisparos() {
  const r = await fetch(`${ESTACAO}/api/resumo`).then(x => x.json()).catch(() => null);
  const d = r && r.disparos;
  if (!d || !d.disparos) {
    el("disparoNumeros").innerHTML = `<span class="nota">nenhum disparo ainda</span>`;
    return;
  }
  const taxa = Math.round((d.vazios / d.disparos) * 100);
  el("disparoNumeros").innerHTML = `
    <span><b>${d.disparos}</b> disparo${d.disparos === 1 ? "" : "s"}</span>
    <span><b>${d.confirmados}</b> com animal</span>
    <span><b>${d.vazios}</b> vazio${d.vazios === 1 ? "" : "s"}</span>
    <span class="nota">alarme falso ${taxa} %</span>`;
}

el("btnDisparo").addEventListener("click", async () => {
  const botao = el("btnDisparo");
  const info = el("infoDisparo");
  botao.disabled = true;
  info.textContent = "tirando 3 fotos e consultando a IA…";
  const r = await fetch(`${ESTACAO}/api/disparo/teste`, { method: "POST" })
    .then(x => x.json()).catch(() => ({ erro: "rede" }));
  botao.disabled = false;
  if (r.descartada) info.textContent = `nenhum animal nas fotos, descartadas (${r.motivo})`;
  else if (r.ignorado) info.textContent = "a câmera já estava ocupada com outro disparo";
  else if (r.ok) info.textContent = `registrado: ${r.visita.especie}${r.catalogando ? " · espécie nova, catalogando…" : ""}${r.visita.observacao ? " · " + r.visita.observacao : ""}`;
  else info.textContent = `falhou (${r.erro || "?"})`;
  desenharDisparos();
});

function desenharEstadoIa(conectada) {
  const alvo = el("iaEstado");
  if (conectada) {
    alvo.innerHTML = `
      <div class="iaLinha">
        <span class="iaOk">IA conectada · Gemini</span>
        <button class="botao contorno" id="btnTrocarChave">Trocar chave</button>
      </div>`;
    alvo.querySelector("#btnTrocarChave").addEventListener("click", () => desenharCampoChave());
  } else {
    desenharCampoChave();
  }
}

function desenharCampoChave() {
  const alvo = el("iaEstado");
  alvo.innerHTML = `
    <div class="iaLinha">
      <span class="iaAviso">IA desligada. Crie uma chave gratuita em
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>
        e cole aqui (fica só na estação).</span>
      <input type="password" id="campoChave" placeholder="chave da API do Gemini">
      <button class="botao" id="btnSalvarChave">Salvar</button>
    </div>`;
  alvo.querySelector("#btnSalvarChave").addEventListener("click", async () => {
    const chave = alvo.querySelector("#campoChave").value.trim();
    if (!chave) return;
    const r = await fetch(`${ESTACAO}/api/config`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chave })
    }).then(x => x.json()).catch(() => null);
    if (r && r.ok) desenharEstadoIa(true);
  });
}

// teste de identificação por foto
function prepararFoto(arquivo) {
  if (!arquivo || !arquivo.type.startsWith("image/")) return;
  const leitor = new FileReader();
  leitor.onload = () => {
    const [cabecalho, dados] = leitor.result.split(",");
    lab.fotoBase64 = dados;
    lab.fotoMime = (cabecalho.match(/data:(.*?);/) || [])[1] || "image/jpeg";
    el("previa").src = leitor.result;
    el("previa").hidden = false;
    el("soltarTexto").hidden = true;
    el("btnIdentificar").disabled = false;
    el("resultadoIa").hidden = true;
  };
  leitor.readAsDataURL(arquivo);
}

el("arquivoFoto").addEventListener("change", e => prepararFoto(e.target.files[0]));
el("soltar").addEventListener("dragover", e => { e.preventDefault(); el("soltar").classList.add("sobre"); });
el("soltar").addEventListener("dragleave", () => el("soltar").classList.remove("sobre"));
el("soltar").addEventListener("drop", e => {
  e.preventDefault();
  el("soltar").classList.remove("sobre");
  prepararFoto(e.dataTransfer.files[0]);
});

el("btnIdentificar").addEventListener("click", async () => {
  const saida = el("resultadoIa");
  saida.hidden = false;
  saida.textContent = "Consultando a IA…";
  const r = await fetch(`${ESTACAO}/api/identificar`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imagem_base64: lab.fotoBase64, mime: lab.fotoMime })
  }).then(x => x.json()).catch(() => ({ erro: "rede" }));

  if (r.ok && r.eh_animal === false) {
    saida.innerHTML = `<b>Nenhum animal na foto</b><div class="ri-obs">${esc(r.observacao)}</div>`;
  } else if (r.ok) {
    saida.innerHTML = `
      <b>${esc(r.especie_popular || "?")}</b> <span class="ri-cient">${esc(r.especie_cientifica)}</span>
      <div>confiança da IA: <strong>${Math.round((Number(r.confianca) || 0) * 100)}%</strong></div>
      <div class="ri-obs">${esc(r.observacao)}</div>`;
  } else if (r.erro === "sem_chave") {
    saida.innerHTML = `<b>IA não configurada</b><div class="ri-obs">Cole a chave da API no painel ao lado primeiro.</div>`;
  } else {
    saida.innerHTML = `<b>Falha na identificação</b><div class="ri-obs">${esc(r.erro)}: ${esc(r.detalhe || r.texto)}</div>`;
  }
});

// estação virtual: webcam como sensor de movimento
const LIMIAR_MOVIMENTO = 14;      // 0-255, chutado testando na mesa
const INTERVALO_QUADROS = 350;    // ms entre comparações
const DESCANSO_MS = 15000;        // pausa entre capturas

el("btnCamera").addEventListener("click", async () => {
  if (lab.stream) { pararCamera(); return; }
  try {
    lab.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
  } catch (e) {
    el("infoVirtual").textContent = `câmera indisponível (${e.name})`;
    return;
  }
  const video = el("video");
  video.srcObject = lab.stream;
  await video.play();
  el("videoQuadro").classList.add("ligado");
  el("btnCamera").textContent = "Desligar câmera";
  el("infoVirtual").textContent = "vigiando movimento…";
  lab.aquecendo = Date.now() + 2500;
  lab.quadroAnterior = null;
  lab.timer = setInterval(vigiarMovimento, INTERVALO_QUADROS);
});

function pararCamera() {
  clearInterval(lab.timer);
  if (lab.stream) lab.stream.getTracks().forEach(t => t.stop());
  lab.stream = null;
  el("videoQuadro").classList.remove("ligado");
  el("medidor").style.width = "0%";
  el("btnCamera").textContent = "Ligar câmera";
  el("infoVirtual").textContent = "";
}

function vigiarMovimento() {
  const video = el("video");
  if (!video.videoWidth) return;
  const c = document.createElement("canvas");
  c.width = 64; c.height = 48;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, 64, 48);
  const atual = ctx.getImageData(0, 0, 64, 48).data;

  if (lab.quadroAnterior) {
    let soma = 0;
    for (let i = 0; i < atual.length; i += 4) {
      soma += Math.abs(atual[i] - lab.quadroAnterior[i]);
    }
    const nivel = soma / (atual.length / 4);
    const barra = el("medidor");
    barra.style.width = `${Math.min(100, (nivel / LIMIAR_MOVIMENTO) * 60)}%`;
    barra.classList.toggle("alto", nivel >= LIMIAR_MOVIMENTO);

    const pronto = Date.now() > lab.aquecendo && Date.now() - lab.ultimoDisparo > DESCANSO_MS;
    if (nivel >= LIMIAR_MOVIMENTO && pronto) {
      lab.ultimoDisparo = Date.now();
      capturarVisitaVirtual();
    }
  }
  lab.quadroAnterior = atual;
}

async function capturarVisitaVirtual() {
  const video = el("video");
  const c = document.createElement("canvas");
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext("2d").drawImage(video, 0, 0);
  const base64 = c.toDataURL("image/jpeg", 0.82).split(",")[1];
  el("infoVirtual").textContent = "movimento! identificando…";

  const r = await fetch(`${ESTACAO}/api/visita-virtual`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imagem_base64: base64, mime: "image/jpeg" })
  }).then(x => x.json()).catch(() => null);

  if (r && r.ok) {
    const v = r.visita;
    mostrarRotuloVideo(v);
    // espécie nova é catalogada na estação em segundo plano, o brinde chega pelo ws depois
    el("infoVirtual").textContent = r.catalogando
      ? `registrado: ${v.especie} · espécie nova, catalogando…`
      : `registrado: ${v.especie} · vigiando de novo em 15 s`;
  } else if (r && r.descartada) {
    el("infoVirtual").textContent = `movimento sem animal (${r.motivo}) · vigiando…`;
  } else {
    el("infoVirtual").textContent = "falha ao registrar · vigiando…";
  }
}

let rotuloTimer = null;
function mostrarRotuloVideo(v) {
  const rotulo = el("videoRotulo");
  const conf = v.confianca != null ? ` · IA ${Math.round(v.confianca * 100)}%` : "";
  rotulo.innerHTML = `${esc(v.especie)}<small>identificação da estação${conf}</small>`;
  rotulo.hidden = false;
  clearTimeout(rotuloTimer);
  rotuloTimer = setTimeout(() => { rotulo.hidden = true; }, 7000);
}

let brindeTimer = null;
function brindar(html) {
  const b = el("brinde");
  b.innerHTML = html;
  b.hidden = false;
  clearTimeout(brindeTimer);
  brindeTimer = setTimeout(() => { b.hidden = true; }, 6000);
}

el("chkSim").addEventListener("change", async e => {
  await fetch(`${ESTACAO}/api/simulador`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ligado: e.target.checked })
  }).catch(() => {});
});

// aba Registro (só admin). os textos vêm prontos da estação, aqui só formata
// a hora e junta os passos de um mesmo disparo (dados.disparo) num bloco.
// vistoT: hora do disparo no topo da lista, pra animar só bloco novo
const reg = { eventos: [], carregado: false, timer: null, vistoT: null };
const MAX_EVENTOS = 400;

// a lista da estação substitui o que tinha aqui. com 403 ou rede fora não
// marca carregado e tenta de novo na próxima abertura
async function abrirRegistro() {
  if (!reg.carregado) {
    const lista = await fetch(`${ESTACAO}/api/eventos?limite=300`)
      .then(r => (r.ok ? r.json() : null)).catch(() => null);
    if (lista) {
      // passo que chegou pelo WS enquanto o fetch rodava fica na frente
      const novos = lista.length ? reg.eventos.filter(e => e.t > lista[0].t) : [];
      reg.eventos = [...novos, ...lista];   // mais novo primeiro
      reg.carregado = true;
    }
  }
  desenharRegistro();
}

function receberEvento(e) {
  if (!e || !e.t) return;
  reg.eventos.unshift(e);
  if (reg.eventos.length > MAX_EVENTOS) reg.eventos.length = MAX_EVENTOS;
  if (el("vistaRegistro").hidden) return;
  clearTimeout(reg.timer);
  reg.timer = setTimeout(desenharRegistro, 120);
}

// "2,8 s" igual à estação
function seg(ms) {
  if (ms == null) return "-";
  const s = Math.max(0, ms) / 1000;
  if (s >= 60) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  return `${s.toFixed(1).replace(".", ",")} s`;
}

// hora com segundos, se não foi hoje o dia vai do lado
function horaRegistro(iso) {
  const d = new Date(iso);
  const hms = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return hms;
  return `${hms}<small>${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}</small>`;
}

const DEZ_MIN = 10 * 60 * 1000;

// junta os passos de um mesmo disparo num bloco, evento sem disparo fica solto.
// evento "disparo" sempre abre bloco novo (o número do arduino recomeça quando
// ele reinicia), passo que chega muito depois também
function agruparEventos(lista) {
  const itens = [];
  const abertos = new Map();
  for (const e of [...lista].reverse()) {
    const n = e.dados && e.dados.disparo;
    if (n == null) { itens.push({ solto: e }); continue; }
    let bloco = abertos.get(n);
    const tarde = bloco && Date.parse(e.t) - Date.parse(bloco.passos[bloco.passos.length - 1].t) > DEZ_MIN;
    if (!bloco || e.tipo === "disparo" || tarde) {
      bloco = { disparo: n, passos: [] };
      abertos.set(n, bloco);
      itens.push(bloco);
    }
    bloco.passos.push(e);
  }
  for (const b of itens) if (b.passos) resumirBloco(b);
  return itens.reverse();
}

function resumirBloco(b) {
  b.inicio = b.passos.find(e => e.tipo === "disparo") || null;
  b.fim = b.passos.find(e => e.dados.etapa === "fim") || null;
  b.ignorado = !b.inicio && b.passos.some(e => e.dados.ignorado);
  const ms = tipo => { const p = b.passos.find(e => e.tipo === tipo && e.dados.ms != null && e.dados.etapa !== "fim"); return p ? p.dados.ms : null; };
  b.msCamera = ms("camera");
  b.msIa = (b.passos.find(e => e.tipo === "ia" && e.dados.etapa === "identificacao" && e.dados.ms != null) || { dados: {} }).dados.ms ?? null;
  b.msTotal = b.fim ? b.fim.dados.ms : null;
  b.temErro = b.passos.some(e => e.tipo === "erro");
  if (b.fim) b.resultado = b.fim.tipo;                        // visita ou descarte
  else if (b.ignorado) b.resultado = "descarte";
  else if (b.temErro) b.resultado = "erro";
  else b.resultado = "andamento";
}

const CARIMBO_BLOCO = {
  visita: `<em class="carimbo verde">visita</em>`,
  descarte: `<em class="carimbo cinza">descartado</em>`,
  erro: `<em class="carimbo">erro</em>`,
  andamento: `<em class="carimbo cinza">em andamento</em>`
};

function htmlBloco(b, novo) {
  const t0 = Date.parse((b.inicio || b.passos[0]).t);
  const motivo = b.inicio ? b.inicio.texto : (b.ignorado ? b.passos[0].texto : `Disparo nº ${b.disparo}`);
  const passos = b.passos.filter(e => e !== b.inicio && !(b.ignorado && e === b.passos[0])).map(e => `
      <li class="regPasso ${esc(e.tipo)}">
        <span class="regQuando">+${esc(seg(Date.parse(e.t) - t0))}</span>
        <span class="regTexto">${esc(e.texto)}</span>
        <span class="regDur">${e.dados.ms != null && e.dados.etapa !== "fim" ? esc(seg(e.dados.ms)) : ""}</span>
      </li>`).join("");
  return `
    <li class="regBloco ${b.resultado}${novo ? " nova" : ""}">
      <div class="regCabeca">
        <time datetime="${esc((b.inicio || b.passos[0]).t)}">${horaRegistro((b.inicio || b.passos[0]).t)}</time>
        <div class="regMotivo">${esc(motivo)} ${CARIMBO_BLOCO[b.resultado]}</div>
        <span class="regTotal">${b.msTotal != null ? esc(seg(b.msTotal)) : ""}<small>${b.msTotal != null ? "total" : ""}</small></span>
      </div>
      ${passos ? `<ol class="regPassos">${passos}</ol>` : ""}
    </li>`;
}

function htmlSolto(e) {
  return `
    <li class="regSolto ${esc(e.tipo)}">
      <time datetime="${esc(e.t)}">${horaRegistro(e.t)}</time>
      <span class="regTexto">${esc(e.texto)}</span>
      <em class="${e.tipo === "erro" ? "carimbo" : e.tipo === "visita" ? "carimbo verde" : "carimbo cinza"}">${esc(e.tipo)}</em>
    </li>`;
}

function desenharRegistro() {
  const itens = agruparEventos(reg.eventos);
  const lista = el("registro");
  el("regSub").textContent = reg.eventos.length ? `últimos ${reg.eventos.length} eventos, mais recente primeiro` : "nada registrado ainda";

  // cada passo redesenha a lista, mas só anima o bloco de cima se for disparo
  // que ainda não tinha aparecido (nem ao abrir a aba)
  const topo = itens[0] && itens[0].passos ? itens[0] : null;
  const tTopo = topo ? (topo.inicio || topo.passos[0]).t : null;
  const novo = reg.vistoT !== null && tTopo != null && tTopo > reg.vistoT;
  if (tTopo != null) reg.vistoT = tTopo;
  else if (reg.vistoT === null) reg.vistoT = "";

  lista.innerHTML = itens.length
    ? itens.map((it, i) => (it.solto ? htmlSolto(it.solto) : htmlBloco(it, i === 0 && novo))).join("")
    : `<li class="nota">a estação ainda não registrou nada por aqui</li>`;

  // resumo: último disparo completo e média dos últimos 10
  const completos = itens.filter(it => it.passos && it.msTotal != null);
  const ultimo = completos[0];
  el("rTotal").textContent = ultimo ? seg(ultimo.msTotal) : "-";
  el("rTotalQuem").textContent = ultimo
    ? (ultimo.fim.dados.especie || (ultimo.resultado === "descarte" ? "descartado" : "")) : "";
  el("rCamera").textContent = ultimo ? seg(ultimo.msCamera) : "-";
  el("rIa").textContent = ultimo ? seg(ultimo.msIa) : "-";
  // na média só entra disparo que passou pela câmera e pela IA, descarte de
  // 0,0 s (sem câmera, sem chave) puxava o total pra baixo
  const dez = completos.filter(b => b.msCamera != null && b.msIa != null).slice(0, 10);
  const media = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  el("rMedia").textContent = dez.length ? seg(media(dez.map(b => b.msTotal))) : "-";
  el("rMediaQuem").textContent = dez.length
    ? `câmera ${seg(media(dez.map(b => b.msCamera)))} · IA ${seg(media(dez.map(b => b.msIa)))}`
    : "";
}

// ficha da espécie (modal)
function trocarAba(nome) {
  document.querySelectorAll(".aba").forEach(a => a.classList.toggle("ativa", a.dataset.aba === nome));
  document.querySelectorAll(".abaPainel").forEach(p => { p.hidden = p.id !== `aba-${nome}`; });
}
document.querySelectorAll(".aba").forEach(a => a.addEventListener("click", () => trocarAba(a.dataset.aba)));

// linha de crédito, texto e foto podem vir de lugares diferentes (foto do
// iNaturalist e texto da Wikipédia, por exemplo)
function nomeDoSite(url) {
  return /inaturalist/i.test(url || "") ? "iNaturalist" : "Wikipédia";
}
function linkFonte(nome, url) {
  const cc = nome === "Wikipédia" ? " (CC BY-SA)" : "";
  return (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(nome)}</a>` : esc(nome)) + cc;
}
function textoFonte(w) {
  let texto = null;
  let foto = null;
  if (w.extract) texto = w.fonteNome === "IA" ? "Texto escrito pela IA da estação" : `Texto: ${linkFonte(nomeDoSite(w.url), w.url)}`;
  if (w.thumb) {
    // ficha antiga sem fotoFonte, adivinha pelo endereço da imagem
    const nome = w.fotoFonte || nomeDoSite(w.thumb);
    const url = w.fotoUrl || (w.fonteNome !== "IA" && nomeDoSite(w.url) === nome ? w.url : null);
    foto = linkFonte(nome, url);
  }
  if (texto && foto && w.fonteNome !== "IA" && texto === `Texto: ${foto}`) return `Texto e foto da espécie: ${foto}.`;
  const partes = [];
  if (texto) partes.push(texto);
  if (foto) partes.push(`${texto ? "foto" : "Foto"}: ${foto}`);
  return partes.length ? partes.join("; ") + "." : "";
}

// foto, texto, fonte e curiosidades, redesenhado quando a ficha chega pelo ws
function desenharCabecaFicha(nome) {
  const m = meta.get(nome) || {};
  const w = wiki.get(nome) || {};
  el("fichaNome").textContent = nome;
  el("fichaCientifico").textContent = m.cientifico || "";
  el("fichaFoto").innerHTML = w.thumb
    ? `<img src="${esc(w.thumb)}" alt="${esc(nome)}">`
    : esc(m.emoji || "🐾");
  el("fichaSobre").textContent = w.extract || "Ficha em preparo, a estação está buscando as informações desta espécie na internet.";
  el("fichaFonte").innerHTML = textoFonte(w);

  const curiosidades = el("curiosidades");
  curiosidades.innerHTML = "";
  for (const c of (m.curiosidades || [])) {
    const li = document.createElement("li");
    li.textContent = c;
    curiosidades.appendChild(li);
  }
  if (!curiosidades.children.length) {
    curiosidades.innerHTML = `<li>Ficha em preparo, a estação ainda está buscando curiosidades desta espécie.</li>`;
  }
}

async function abrirFicha(nome) {
  esconderTooltip();
  const m = meta.get(nome) || {};
  const w = wiki.get(nome) || {};
  trocarAba("info");
  desenharCabecaFicha(nome);

  el("fichaStats").innerHTML = "";
  el("galeria").innerHTML = `<p class="galVazia">Carregando registros…</p>`;
  el("fichaFundo").hidden = false;

  // contagem e datas vêm do resumo (histórico inteiro), a lista filtrada
  // serve pra estatística de peso e pra galeria
  const [resumo, lista] = await Promise.all([
    fetch(`${ESTACAO}/api/resumo`).then(r => r.json()).catch(() => null),
    fetch(`${ESTACAO}/api/visitas?especie=${encodeURIComponent(nome)}&limite=500`).then(r => r.json()).catch(() => [])
  ]);
  const daEspecie = lista.filter(v => v.especie === nome);
  const c = resumo && resumo.porEspecie.find(e => e.especie === nome);
  const total = c ? c.visitas : daEspecie.length;

  if (total) {
    // só peso medido entra na estatística, estimativa e leitura suspeita não
    const pesos = daEspecie.filter(v => !v.peso_estimado && !v.peso_suspeito).map(v => v.peso_g).filter(p => p != null);
    const primeira = (c && c.primeira) || (daEspecie.length ? daEspecie[daEspecie.length - 1].timestamp : null);
    const dadosPeso = pesos.length
      ? `<span>peso médio <b>${esc(formatoPeso(Math.round(pesos.reduce((a, b) => a + b, 0) / pesos.length)))}</b></span>
         <span>mín <b>${esc(formatoPeso(Math.min(...pesos)))}</b> · máx <b>${esc(formatoPeso(Math.max(...pesos)))}</b></span>`
      : "";
    el("fichaStats").innerHTML = `
      <span><b>${total}</b> visita${total === 1 ? "" : "s"}</span>
      ${dadosPeso}
      ${primeira ? `<span>primeira vez ${horaRelativa(primeira)}</span>` : ""}`;
  }

  const galeria = el("galeria");
  galeria.innerHTML = "";
  if (!daEspecie.length) {
    galeria.innerHTML = `<p class="galVazia">Nenhum registro desta espécie ainda.</p>`;
    return;
  }
  for (const v of daEspecie.slice(0, 12)) {
    const quando = new Date(v.timestamp).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    const foto = document.createElement("div");
    foto.className = "galFoto";
    if (v.foto) {
      foto.innerHTML = `<img src="${esc(ESTACAO + v.foto)}" alt="Registro de ${esc(nome)}" loading="lazy"><span class="galHora">${quando}</span>`;
    } else {
      // visita simulada não tem foto, vai a imagem da espécie mesmo
      const fundo = w.thumb ? `<img src="${esc(w.thumb)}" alt="" loading="lazy">` : esc(m.emoji || "🐾");
      foto.innerHTML = `${fundo}<span class="galHora">${quando}</span>`;
    }
    const dicas = [pesoDaVisita(v),
      v.temperatura_c != null ? formatoTemp(v.temperatura_c) : null,
      v.confianca != null ? `IA ${Math.round(v.confianca * 100)}%` : null].filter(Boolean);
    ligarTooltip(foto, dicas.join(" · "));
    galeria.appendChild(foto);
  }
}

function fecharFicha() { el("fichaFundo").hidden = true; }
el("fichaFechar").addEventListener("click", fecharFicha);
el("fichaFundo").addEventListener("click", e => { if (e.target === el("fichaFundo")) fecharFicha(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") fecharFicha(); });

// carga inicial e websocket
async function carregarTudo() {
  const [visitas, resumo] = await Promise.all([
    fetch(`${ESTACAO}/api/visitas?limite=40`).then(r => r.json()),
    fetch(`${ESTACAO}/api/resumo`).then(r => r.json())
  ]);
  escreverData();
  marcarDescobertas(visitas, resumo);
  const feed = el("feed");
  feed.innerHTML = visitas.length ? "" : `<li class="nota">nenhuma visita registrada ainda</li>`;
  for (const v of visitas) feed.appendChild(cartaoVisita(v));
  desenharResumo(resumo);
}

function definirStatus(classe, texto) {
  el("status").className = "status " + classe;
  el("statusTexto").textContent = texto;
}

function conectar() {
  const ws = new WebSocket(ESTACAO.replace(/^http/, "ws"));
  ws.onopen = () => {
    definirStatus("ok", "ao vivo");
    carregarTudo().catch(() => {});   // pega o que chegou com a conexão fora
    reg.carregado = false;   // o registro também
    if (!el("vistaRegistro").hidden) abrirRegistro();
  };
  let ultimaVisita = null;
  ws.onmessage = async ev => {
    const msg = JSON.parse(ev.data);
    if (msg.tipo === "visita") {
      ultimaVisita = msg.visita;
      // espécie que ainda não conheço, recarrega o catálogo antes
      if (!meta.has(msg.visita.especie)) await carregarMeta().catch(() => {});
      const vazio = el("feed").querySelector(".nota");
      if (vazio) vazio.remove();
      el("feed").prepend(cartaoVisita(msg.visita, true));
      fetch(`${ESTACAO}/api/resumo`).then(r => r.json()).then(desenharResumo);
    }
    if (msg.tipo === "descoberta") {
      brindar(`Nova espécie catalogada: <b>${esc(msg.especie)}</b>!`);
      await carregarMeta().catch(() => {});
      // a visita que inaugurou a espécie já está no diário, ganha o carimbo
      const v = msg.visita || (ultimaVisita && ultimaVisita.especie === msg.especie ? ultimaVisita : null);
      if (v) {
        descobertas.add(v.id);
        const li = el("feed").querySelector(`[data-id="${v.id}"]`);
        if (li) li.replaceWith(cartaoVisita(v, true));
      }
      atualizarEspecieNaTela(msg.especie);
    }
    if (msg.tipo === "evento") receberEvento(msg.evento);
    // ficha de espécie completada ou melhorada
    if (msg.tipo === "especie" && msg.especie && msg.especie.nome) {
      receberEspecie(msg.especie);
      atualizarEspecieNaTela(msg.especie.nome);
    }
  };
  ws.onclose = () => {
    definirStatus("erro", "reconectando…");
    setTimeout(conectar, 3000);
  };
}

// abre o app mesmo com a estação fora (ex.: caixa ainda subindo) e fica
// tentando
let conectado = false;
function iniciarDados() {
  (meta.size ? Promise.resolve() : carregarMeta())
    .then(carregarTudo)
    .then(() => {
      if (!conectado) { conectado = true; conectar(); }
      verificarAcesso();
    })
    .catch(() => {
      definirStatus("erro", "estação fora do ar, tentando de novo…");
      setTimeout(iniciarDados, 5000);
    });
}

// visitante na rede da feira só lê, esconde o que ele não pode usar
async function verificarAcesso() {
  const r = await fetch(`${ESTACAO}/api/acesso`).then(x => x.json()).catch(() => null);
  const admin = !!(r && r.admin);
  document.querySelector('.navBotao[data-vista="lab"]').hidden = !admin;
  document.querySelector('.navBotao[data-vista="registro"]').hidden = !admin;
  if (!admin) el("btnSino").hidden = true;
  return admin;
}

// pwa e notificações, só funciona em https ou localhost
let registroSW = null;
let chaveVapid = null;

function base64ParaBytes(b64) {
  const preenchido = (b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const bruto = atob(preenchido);
  return Uint8Array.from(bruto, c => c.charCodeAt(0));
}

async function atualizarSino() {
  const inscricao = await registroSW.pushManager.getSubscription();
  const ligado = !!inscricao && Notification.permission === "granted";
  el("btnSino").classList.toggle("ligado", ligado);
  el("sinoTexto").textContent = ligado ? "avisos ligados" : "avisar";
}

async function iniciarApp() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext || location.protocol === "file:") return;
  registroSW = await navigator.serviceWorker.register("sw.js").catch(() => null);
  if (!registroSW || !("PushManager" in window) || !("Notification" in window)) return;
  const cfg = await fetch(`${ESTACAO}/api/push/chave`).then(r => r.json()).catch(() => null);
  if (!cfg || !cfg.disponivel) return;
  if (!(await verificarAcesso())) return;   // avisos só pra admin
  chaveVapid = cfg.chave;
  el("btnSino").hidden = false;
  await navigator.serviceWorker.ready;
  atualizarSino();
}

el("btnSino").addEventListener("click", async () => {
  const atual = await registroSW.pushManager.getSubscription();
  if (atual) {
    await fetch(`${ESTACAO}/api/push/cancelar`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: atual.endpoint })
    }).catch(() => {});
    await atual.unsubscribe();
    brindar("Avisos desligados neste aparelho.");
  } else {
    const permissao = await Notification.requestPermission();
    if (permissao !== "granted") {
      brindar("O navegador bloqueou as notificações. Libere nas configurações do site.");
      return;
    }
    try {
      const nova = await registroSW.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64ParaBytes(chaveVapid)
      });
      await fetch(`${ESTACAO}/api/push/inscrever`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nova.toJSON())
      });
      await fetch(`${ESTACAO}/api/push/teste`, { method: "POST" }).catch(() => {});
      brindar("Pronto! Você vai ser avisado quando a estação identificar uma espécie.");
    } catch (e) {
      brindar(`Não deu pra ligar os avisos (${e.message}).`);
    }
  }
  atualizarSino();
});

escreverData();
iniciarDados();
iniciarApp();

// atualiza os "há x min" e os gráficos de tempos em tempos
setInterval(() => { carregarTudo().catch(() => {}); }, 60000);
