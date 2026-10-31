// catálogo = espécies fixas (especies.js) + descobertas pela estação.
// a ficha (foto, sobre, fonte, curiosidades, peso médio) é montada aqui buscando
// wikipédia pt, wikipédia en, iNaturalist e por fim a IA. fica em dados/fichas.json
// e é tentada de novo de tempos em tempos até completar, os celulares só leem
const fs = require("fs");
const path = require("path");
const armazenamento = require("./armazenamento");
const eventos = require("./eventos");
const FIXAS = require("./especies");

const ARQUIVO = path.join(armazenamento.PASTA, "catalogo.json");
const ARQUIVO_FICHAS = path.join(armazenamento.PASTA, "fichas.json");
const TEMPO_LIMITE_MS = 8000;
// a Wikimedia devolve 429 pra quem não se identifica
const AGENTE = "selva-estacao/1.0 (estacao de monitoramento de fauna, feira de ciencias)";
// vigia: primeira rodada 10 s depois do boot, depois a cada 10 min
const ESPERA_BOOT_MS = 10000;
const INTERVALO_VIGIA_MS = 10 * 60 * 1000;
const PAUSA_ENTRE_MS = 2000;
const MAXIMO_TENTATIVAS_DIA = 20;
// fonte/fonteNome é do texto, fotoFonte/fotoUrl é da foto (o crédito é separado,
// a foto pode ser do iNaturalist e o texto da wikipédia)
const CAMPOS_FICHA = ["foto", "sobre", "fonte", "fonteNome", "fotoFonte", "fotoUrl", "curiosidades", "pesoMedio", "fichaTentativas", "fichaUltima"];

let dinamicas = null;
let fichas = null;
// duas visitas da mesma espécie nova ao mesmo tempo esperam a mesma catalogação
const emAndamento = new Map();
// fichas sendo preenchidas agora, o vigia não entra na que o disparo já pegou
const preenchendo = new Set();
const ouvintes = [];
const dormir = ms => new Promise(r => setTimeout(r, ms));

function carregarDinamicas() {
  if (dinamicas) return dinamicas;
  try {
    dinamicas = JSON.parse(fs.readFileSync(ARQUIVO, "utf8"));
  } catch {
    dinamicas = [];
  }
  return dinamicas;
}

function salvar() {
  armazenamento.gravarSeguro(ARQUIVO, JSON.stringify(dinamicas, null, 2));
}

// fichas.json: nome -> campos da ficha. as fixas continuam em código, só o que
// a caixa preenche fica aqui
function carregarFichas() {
  if (fichas) return fichas;
  try {
    fichas = JSON.parse(fs.readFileSync(ARQUIVO_FICHAS, "utf8"));
    if (!fichas || typeof fichas !== "object" || Array.isArray(fichas)) fichas = {};
  } catch {
    fichas = {};
  }
  return fichas;
}

function salvarFichas() {
  armazenamento.gravarSeguro(ARQUIVO_FICHAS, JSON.stringify(fichas, null, 2));
}

function temTexto(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// o summary da wikipédia às vezes vem só com um nome solto ("Phytolacca dioica"
// no Sanhaço-cinzento), então sobre de verdade tem que ter pelo menos uma frase
const MINIMO_SOBRE = 60;
function textoUtil(v) {
  return temTexto(v) && v.trim().length >= MINIMO_SOBRE;
}

// espécie + ficha; fichaOk = tem foto, sobre e curiosidades
function mesclar(e) {
  const f = carregarFichas()[e.nome] || {};
  const r = { ...e };
  for (const k of CAMPOS_FICHA) {
    const v = f[k];
    if (v == null) continue;
    if (Array.isArray(v) && !v.length) continue;
    r[k] = v;
  }
  for (const k of ["foto", "sobre", "fonte", "fonteNome", "fotoFonte", "fotoUrl"]) if (r[k] === undefined) r[k] = null;
  if (!Array.isArray(r.curiosidades)) r.curiosidades = [];
  if (r.pesoMedio === undefined) r.pesoMedio = null;
  if (!textoUtil(r.sobre)) r.sobre = null;
  r.fichaOk = !!(temTexto(r.foto) && temTexto(r.sobre) && r.curiosidades.length);
  return r;
}

function todos() {
  return [...FIXAS.map(mesclar), ...carregarDinamicas().map(e => ({ ...mesclar(e), descoberta: true }))];
}

function normalizar(s) {
  return String(s || "").trim().toLowerCase();
}

function buscar(nome, cientifico) {
  return todos().find(e =>
    (cientifico && normalizar(e.cientifico) === normalizar(cientifico)) ||
    (nome && normalizar(e.nome) === normalizar(nome))
  ) || null;
}

function aoAtualizar(fn) {
  ouvintes.push(fn);
  return () => {
    const i = ouvintes.indexOf(fn);
    if (i >= 0) ouvintes.splice(i, 1);
  };
}

function avisar(especie) {
  for (const fn of ouvintes) {
    try { fn(especie); } catch {}
  }
}

// ===== fontes da ficha =====
// só http(s) com cara de foto (o svg de desambiguação da wikipédia não vale)
function fotoValida(url) {
  if (!temTexto(url)) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  return /\.(jpe?g|png|gif|webp)(\?|#|$)/i.test(url.split("?")[0]);
}

async function pegarJson(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(TEMPO_LIMITE_MS), headers: { accept: "application/json", "user-agent": AGENTE } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// summary da wikipédia (pt ou en) -> {foto, sobre, url} ou null
async function wikiResumo(lingua, titulo) {
  if (!temTexto(titulo)) return null;
  const j = await pegarJson(`https://${lingua}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(titulo)}`);
  if (!j || j.type === "disambiguation" || j.type === "not_found") return null;
  const foto = j.thumbnail && j.thumbnail.source;
  return {
    titulo: j.title || titulo,
    foto: fotoValida(foto) ? foto : null,
    sobre: textoUtil(j.extract) ? j.extract.trim() : null,
    url: j.content_urls && j.content_urls.desktop ? j.content_urls.desktop.page : null
  };
}

// o nome científico é redirect do artigo da espécie. a busca é "começa com",
// então só vale se casou o nome inteiro (senão "Melanerpes erythrocephalus"
// cai na página do gênero)
async function wikiBusca(lingua, termo) {
  if (!temTexto(termo)) return null;
  const j = await pegarJson(`https://${lingua}.wikipedia.org/w/rest.php/v1/search/title?q=${encodeURIComponent(termo)}&limit=1`);
  const p = j && Array.isArray(j.pages) && j.pages[0];
  if (!p) return null;
  const casou = [p.matched_title, p.title, p.excerpt].some(x => normalizar(x) === normalizar(termo));
  return casou && p.title ? p.title : null;
}

// iNaturalist: foto do táxon e link da wikipédia quando tem. a busca é fuzzy
// (qualquer coisa devolve algum bicho), só vale casando o nome
async function inat(termo) {
  if (!temTexto(termo)) return null;
  const j = await pegarJson(`https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(termo)}&per_page=1`);
  const t = j && Array.isArray(j.results) && j.results[0];
  if (!t) return null;
  const casou = [t.name, t.matched_term, t.preferred_common_name].some(x => normalizar(x) === normalizar(termo));
  if (!casou) return null;
  const foto = t.default_photo && t.default_photo.medium_url;
  const pagina = t.id ? `https://www.inaturalist.org/taxa/${t.id}` : null;
  return {
    foto: fotoValida(foto) ? foto : null,
    pagina,
    url: temTexto(t.wikipedia_url) ? t.wikipedia_url : pagina
  };
}

function hoje() {
  return new Date().toISOString().slice(0, 10);
}

function tentativasHoje(f) {
  if (!f.fichaUltima || String(f.fichaUltima).slice(0, 10) !== hoje()) return 0;
  return Number(f.fichaTentativas) || 0;
}

// preenche o que falta na ficha, fonte por fonte. cada fonte tem timeout próprio
// e erro vira "não achou". devolve a espécie mesclada com a ficha
async function preencherFicha(especie, identificador = null, disparo = null) {
  const nome = especie.nome;
  const cientifico = temTexto(especie.cientifico) ? especie.cientifico.trim() : "";
  carregarFichas();
  if (preenchendo.has(nome)) return mesclar(especie);
  preenchendo.add(nome);
  const t0 = Date.now();
  try {
    const antes = mesclar(especie);
    const f = { ...(fichas[nome] || {}) };
    const origem = {};
    const faltaFoto = () => !temTexto(f.foto);
    const faltaSobre = () => !textoUtil(f.sobre);
    const guardarPagina = (r, lingua) => {
      if (!r) return false;
      let usou = false;
      if (faltaFoto() && r.foto) {
        f.foto = r.foto; f.fotoFonte = "Wikipédia"; f.fotoUrl = r.url || null;
        origem.foto = `Wikipédia ${lingua}`; usou = true;
      }
      // texto em inglês não vira "sobre"
      if (lingua === "pt" && faltaSobre() && r.sobre) {
        f.sobre = r.sobre; f.fonte = r.url || f.fonte || null; f.fonteNome = "Wikipedia";
        origem.sobre = "Wikipédia pt"; usou = true;
      }
      if (!temTexto(f.fonte) && r.url) { f.fonte = r.url; f.fonteNome = "Wikipedia"; }
      return usou;
    };

    // nome científico primeiro: "Pardal" na pt é o artigo do gênero (foto de
    // outro pardal), "Passer domesticus" cai no certo
    if ((faltaFoto() || faltaSobre()) && cientifico) {
      const titulo = await wikiBusca("pt", cientifico);
      if (titulo) guardarPagina(await wikiResumo("pt", titulo), "pt");
    }
    // wikipédia pt pelo título conhecido / nome popular
    if (faltaFoto() || faltaSobre()) {
      const titulos = [...new Set([especie.wiki, nome].filter(temTexto))];
      for (const t of titulos) {
        if (!faltaFoto() && !faltaSobre()) break;
        guardarPagina(await wikiResumo("pt", t), "pt");
      }
    }
    // wikipédia en só pra foto e link
    if (faltaFoto() && cientifico) guardarPagina(await wikiResumo("en", cientifico), "en");
    if (faltaFoto()) {
      const r = await inat(cientifico || nome);
      if (r && r.foto) {
        f.foto = r.foto;
        f.fotoFonte = "iNaturalist";
        f.fotoUrl = r.pagina || r.url || null;
        origem.foto = "iNaturalist";
        if (!temTexto(f.fonte) && r.url) { f.fonte = r.url; f.fonteNome = /wikipedia/i.test(r.url) ? "Wikipedia" : "iNaturalist"; }
      }
    }

    // IA por último: sobre quando nenhuma wikipédia tinha, curiosidades, peso e emoji
    const curiosAntes = Array.isArray(antes.curiosidades) ? antes.curiosidades : [];
    const dinamica = carregarDinamicas().find(e => e.nome === nome) || null;
    const precisaEmoji = !!dinamica && (!temTexto(dinamica.emoji) || dinamica.emoji === "🐾");
    const precisaPeso = antes.pesoMedio == null && antes.pesoMin == null;
    const precisaIa = faltaSobre() || !curiosAntes.length || precisaPeso || precisaEmoji;
    let ia = null;
    if (precisaIa && identificador && typeof identificador.gerarFicha === "function") {
      try {
        ia = await identificador.gerarFicha(nome, cientifico, disparo);
      } catch (e) {
        ia = { erro: "excecao", detalhe: e.message };
      }
      if (ia && ia.ok) {
        if (faltaSobre() && textoUtil(ia.sobre)) {
          f.sobre = ia.sobre.trim();
          origem.sobre = "IA";
          f.fonteNome = "IA";   // o link (fonte) fica sendo o da foto
        }
        if (!curiosAntes.length && Array.isArray(ia.curiosidades) && ia.curiosidades.length) {
          f.curiosidades = ia.curiosidades.filter(temTexto).slice(0, 5);
          origem.curiosidades = "IA";
        }
        const p = Number(ia.peso_medio_g);
        if (precisaPeso && Number.isFinite(p) && p > 0) { f.pesoMedio = Math.round(p); origem.pesoMedio = "IA"; }
        if (precisaEmoji && temTexto(ia.emoji)) {
          dinamica.emoji = String(ia.emoji).slice(0, 4);
          salvar();
        }
      }
    }

    f.fichaTentativas = tentativasHoje(fichas[nome] || {}) + 1;
    f.fichaUltima = new Date().toISOString();
    fichas[nome] = f;
    salvarFichas();

    const depois = mesclar(especie);
    const ms = Date.now() - t0;
    const mudou = Object.keys(origem).length > 0;
    const falta = [!depois.foto && "foto", !depois.sobre && "texto", !depois.curiosidades.length && "curiosidades"].filter(Boolean);
    const dados = { especie: nome, disparo, ms, etapa: "ficha", ...origem, fichaOk: depois.fichaOk, tentativa: f.fichaTentativas };
    const deOnde = Object.entries(origem).map(([k, v]) => `${k === "sobre" ? "texto" : k} de ${v}`).join(", ");
    if (mudou) {
      const resto = falta.length ? `; ainda falta ${falta.join(" e ")}` : "; ficha completa";
      eventos.registrar("catalogo", `Ficha de ${nome}: ${deOnde}${resto}, em ${eventos.seg(ms)}`, dados);
      console.log(`[catalogo] ficha de ${nome}: ${deOnde}${resto}`);
    } else if (!depois.fichaOk) {
      const porque = ia && !ia.ok ? `, IA ${ia.frase || ia.erro || "falhou"}` : "";
      eventos.registrar("erro", `Ficha de ${nome}: nenhuma fonte respondeu (falta ${falta.join(" e ")}${porque}), tentativa ${f.fichaTentativas} de hoje, em ${eventos.seg(ms)}`, dados);
    }
    // descoberta vai com o carimbo, igual todos()
    if (mudou) avisar(dinamica ? { ...depois, descoberta: true } : depois);
    return depois;
  } finally {
    preenchendo.delete(nome);
  }
}

// usada pela rota /completar (manual, sem botão no app por enquanto)
async function completarAgora(nome, identificador) {
  const e = buscar(nome);
  if (!e) return null;
  return preencherFicha(e, identificador);
}

// vigia: fichas incompletas são tentadas de novo. pausaMs entre uma espécie e
// outra pra não estourar cota da IA
let vigiando = false;
async function completarPendentes(identificador, pausaMs = PAUSA_ENTRE_MS) {
  if (vigiando) return;
  vigiando = true;
  try {
    const pendentes = todos().filter(e => !e.fichaOk && tentativasHoje(e) < MAXIMO_TENTATIVAS_DIA);
    for (let i = 0; i < pendentes.length; i++) {
      if (i) await dormir(pausaMs);
      try {
        await preencherFicha(pendentes[i], identificador);
      } catch (e) {
        eventos.registrar("erro", `Ficha de ${pendentes[i].nome}: estourou uma exceção (${e.message})`, { especie: pendentes[i].nome, etapa: "ficha" });
      }
    }
  } finally {
    vigiando = false;
  }
}

function vigiarFichas(identificador) {
  const rodar = () => completarPendentes(identificador).catch(() => {});
  const primeiro = setTimeout(rodar, ESPERA_BOOT_MS);
  const periodico = setInterval(rodar, INTERVALO_VIGIA_MS);
  primeiro.unref();
  periodico.unref();
  return () => { clearTimeout(primeiro); clearInterval(periodico); };
}

// devolve { especie, nova }. nova=false se já existia (ou outra visita catalogou
// no meio do caminho), pra não avisar duas vezes. pesoTipicoIa é o palpite que
// veio junto da identificação, usado se a ficha não trouxer um
function descobrir(nome, cientifico, identificador, pesoTipicoIa = null, disparo = null) {
  carregarDinamicas();
  const jaExiste = buscar(nome, cientifico);
  if (jaExiste) return Promise.resolve({ especie: jaExiste, nova: false });

  const chave = normalizar(cientifico) || normalizar(nome);
  if (emAndamento.has(chave)) {
    eventos.registrar("catalogo", `Catálogo: ${nome} já está sendo catalogada por outro disparo, esperando`, { disparo });
    return emAndamento.get(chave).then(r => ({ especie: r.especie, nova: false }));
  }
  const promessa = catalogar(nome, cientifico, identificador, pesoTipicoIa, disparo)
    .finally(() => emAndamento.delete(chave));
  emAndamento.set(chave, promessa);
  return promessa;
}

// a espécie entra no catálogo na hora (emoji genérico) e a ficha vem em seguida
async function catalogar(nome, cientifico, identificador, pesoTipicoIa, disparo) {
  const t0 = Date.now();
  // confere de novo, pode ter entrado por outro caminho
  const agora = buscar(nome, cientifico);
  if (agora) {
    eventos.registrar("catalogo", `Catálogo: ${nome} foi catalogada por outro disparo nesse meio tempo`, { disparo, especie: nome, etapa: "catalogo", nova: false });
    return { especie: agora, nova: false };
  }
  const nova = { nome, cientifico: cientifico || "", emoji: "🐾", wiki: nome };
  dinamicas.push(nova);
  salvar();
  const p = Number(pesoTipicoIa);
  if (Number.isFinite(p) && p > 0) {
    carregarFichas();
    fichas[nome] = { ...(fichas[nome] || {}), pesoMedio: Math.round(p) };
    salvarFichas();
  }
  console.log(`[catalogo] nova espécie descoberta: ${nome} (${cientifico || "?"})`);

  let especie;
  try {
    especie = await preencherFicha(nova, identificador, disparo);
  } catch (e) {
    eventos.registrar("erro", `Ficha de ${nome}: estourou uma exceção (${e.message})`, { disparo, especie: nome, etapa: "ficha" });
    especie = mesclar(nova);
  }
  eventos.registrar("catalogo", `Catálogo: ${nome} é espécie nova; ficha ${especie.fichaOk ? "completa" : "incompleta, a estação continua buscando"}`,
    { disparo, ms: Date.now() - t0, especie: nome, etapa: "catalogo", nova: true, fichaOk: especie.fichaOk });
  return { especie: { ...especie, descoberta: true }, nova: true };
}

module.exports = {
  todos, buscar, descobrir, preencherFicha, completarAgora, completarPendentes, vigiarFichas, aoAtualizar, fotoValida,
  ARQUIVO_FICHAS, MAXIMO_TENTATIVAS_DIA
};
