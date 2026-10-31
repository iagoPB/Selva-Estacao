// identificação via Gemini. a chave vem de GEMINI_API_KEY ou do config.json da
// pasta de dados (o app grava lá quando o usuário cola a chave no Laboratório)
const fs = require("fs");
const path = require("path");
const armazenamento = require("./armazenamento");
const eventos = require("./eventos");

const ARQUIVO_CONFIG = path.join(armazenamento.PASTA, "config.json");
// o campo "modelo" do config.json troca o modelo sem mexer no código. o alias
// -latest acompanha o flash atual, não apodrece quando o Google aposenta versão.
// os reservas entram quando o principal dá 503 ou 404
const MODELO_PADRAO = "gemini-flash-latest";
const MODELOS_RESERVA = ["gemini-flash-lite-latest", "gemini-3.5-flash"];
// sem timeout uma conexão pendurada (4G do hotspot caindo) segura a câmera 5 min
const TEMPO_LIMITE_IA_MS = 20000;

const PROMPT = `Você é o identificador de fauna de uma estação de monitoramento em Salto, São Paulo, Brasil.
Analise a foto e responda APENAS um JSON neste formato:
{"eh_animal": true ou false, "especie_popular": "nome popular em pt-BR", "especie_cientifica": "nome científico", "confianca": número de 0 a 1, "observacao": "comentário de até 15 palavras"}
Se não houver nenhum animal visível na foto, use eh_animal=false.
Pessoas não contam: se o que aparece é um ser humano (rosto, mão, corpo), use eh_animal=false.
A estação também é usada em demonstrações: um animal mostrado numa tela, numa foto impressa ou uma pelúcia realista conta como o animal representado. Identifique a espécie normalmente e diga na observação que é uma reprodução.`;

function lerConfig() {
  try {
    return JSON.parse(fs.readFileSync(ARQUIVO_CONFIG, "utf8"));
  } catch {
    return {};
  }
}

function salvarChave(chave) {
  const cfg = lerConfig();
  cfg.gemini_chave = chave.trim();
  armazenamento.gravarSeguro(ARQUIVO_CONFIG, JSON.stringify(cfg, null, 2));
}

function chaveAtual() {
  return process.env.GEMINI_API_KEY || lerConfig().gemini_chave || null;
}

function temChave() {
  return !!chaveAtual();
}

async function identificar(imagemBase64, mime = "image/jpeg") {
  const r = await gerarConteudo([
    { inlineData: { mimeType: mime, data: imagemBase64 } },
    { text: PROMPT }
  ]);
  anotarResposta(r, "teste", null);
  return r;
}

// erro em frase pra aba Registro (o código cru fica em dados)
function fraseErro(r) {
  if (r.erro === "sem_chave") return "sem chave configurada";
  if (r.erro === "rede") {
    return /timeout|abort/i.test(r.detalhe || "")
      ? `a internet não respondeu em ${TEMPO_LIMITE_IA_MS / 1000} s`
      : "a conexão com o Gemini caiu no meio do caminho";
  }
  if (r.erro === "parse") return "a IA respondeu fora do formato";
  return `o Gemini respondeu erro ${r.status || "desconhecido"}`;
}

// linha do registro quando a resposta chega ("92 % de certeza" e afins).
// o tempo vai em dados.ms, não no texto
function anotarResposta(r, etapa, disparo) {
  const quem = `IA (${r.modelo || (r.erro === "sem_chave" ? "sem chave" : "?")})`;
  const prefixo = etapa === "teste" ? `${quem}, teste do Laboratório` : quem;
  const dados = { disparo, ms: r.ms, modelo: r.modelo, etapa };
  if (!r.ok) {
    r.frase = fraseErro(r);
    eventos.registrar("erro", `${quem}: ${r.frase}`, { ...dados, erro: r.erro, status: r.status || null, detalhe: r.detalhe || r.texto || null });
    return;
  }
  if (etapa === "ficha") {
    eventos.registrar("ia", `${quem}: ficha gerada`, dados);
    return;
  }
  const certeza = Math.round((Number(r.confianca) || 0) * 100);
  const texto = r.eh_animal === false
    ? `${prefixo}: nenhum animal nas fotos`
    : `${prefixo}: ${r.especie_popular || "não identificado"}, ${certeza} % de certeza`;
  eventos.registrar("ia", texto, { ...dados, especie: r.especie_popular || null, confianca: certeza });
}

// as fotos da visita numa chamada só: a IA diz se tem animal, escolhe a melhor
// e chuta o peso típico da espécie (usado quando a balança não pesou)
async function identificarLote(imagens, mime = "image/jpeg", disparo = null) {
  const qtd = imagens.length;
  const prompt = `Você é o identificador de fauna de uma estação de monitoramento em Salto, São Paulo, Brasil.
Estas ${qtd} foto(s) foram tiradas em sequência, em poucos segundos, quando um sensor detectou movimento num comedouro.
Responda APENAS um JSON neste formato:
{"eh_animal": true ou false, "melhor_indice": número de 0 a ${qtd - 1} (a foto em que o animal aparece melhor), "especie_popular": "nome popular em pt-BR", "especie_cientifica": "nome científico", "confianca": número de 0 a 1, "peso_tipico_g": peso médio de um adulto da espécie em gramas, "observacao": "comentário de até 15 palavras"}
Se nenhuma foto mostrar um animal, use eh_animal=false. Folhas, sombras e vento não são animais.
Pessoas não contam: se o que aparece é um ser humano (rosto, mão, corpo), use eh_animal=false.
A estação também é usada em demonstrações: um animal mostrado numa tela, numa foto impressa ou uma pelúcia realista conta como o animal representado. Identifique a espécie normalmente e diga na observação que é uma reprodução.`;
  const parts = imagens.map(b64 => ({ inlineData: { mimeType: mime, data: b64 } }));
  parts.push({ text: prompt });
  const r = await gerarConteudo(parts, disparo);
  if (r.ok) {
    const indice = Number(r.melhor_indice);
    r.melhor_indice = Number.isInteger(indice) && indice >= 0 && indice < qtd ? indice : 0;
  }
  anotarResposta(r, "identificacao", disparo);
  return r;
}

// ficha da espécie (emoji, peso, sobre, curiosidades). o sobre só é usado se a
// wikipédia não tiver artigo
async function gerarFicha(nome, cientifico, disparo = null) {
  const r = await gerarConteudo([{
    text: `Gere uma mini-ficha sobre a espécie "${nome}" (${cientifico || "nome científico desconhecido"}) para um aplicativo brasileiro de observação de fauna.
Responda APENAS um JSON neste formato:
{"emoji": "um único emoji que melhor representa o animal", "peso_medio_g": peso médio de um adulto em gramas, "sobre": "2 ou 3 frases em pt-BR apresentando a espécie (aparência, onde vive, hábitos), tom de guia de campo", "curiosidades": ["4 curiosidades ou mitos sobre a espécie, em pt-BR, uma frase cada, tom leve e factual"]}`
  }], disparo);
  anotarResposta(r, "ficha", disparo);
  return r;
}

// 4 s já passa da janela de cota por minuto, 6 s era demais com o bicho na frente da câmera
const ESPERA_429_MS = 4000;
const dormir = ms => new Promise(r => setTimeout(r, ms));

// corrida entre modelos: se o principal não responder em CORRIDA_MS o reserva
// entra junto, vale a primeira resposta boa (o flash lotado leva 7 s pra dizer 503)
const CORRIDA_MS = 2000;

function gerarConteudo(parts, disparo = null) {
  const chave = chaveAtual();
  if (!chave) return Promise.resolve({ erro: "sem_chave" });

  const inicio = Date.now();
  const candidatos = [lerConfig().modelo || MODELO_PADRAO, ...MODELOS_RESERVA];
  return new Promise(resolve => {
    let proximo = 0, rodando = 0, acabou = false, ultimoErro = { erro: "api" };
    const alcas = [];

    function terminar(r) {
      if (acabou) return;
      acabou = true;
      for (const a of alcas) a.abort();
      resolve(r);
    }

    async function tentar() {
      if (acabou || proximo >= candidatos.length) return;
      const modelo = candidatos[proximo++];
      const alca = { abort() {} };
      alcas.push(alca);
      rodando++;
      let vivo = true;
      if (proximo < candidatos.length) {
        setTimeout(() => {
          if (!vivo || acabou) return;
          eventos.registrar("ia", `IA (${modelo}): demorando, ${candidatos[proximo]} entra na corrida`, { disparo, modelo });
          tentar();
        }, CORRIDA_MS);
      }

      let r = await chamarModelo(chave, modelo, parts, alca);
      // 429 é cota do plano grátis (disparo em sequência na feira bate nisso), espera e repete
      if (!acabou && r.erro === "api" && r.status === 429) {
        console.log(`[ia] ${modelo}: cota estourada (429), esperando ${ESPERA_429_MS / 1000} s`);
        eventos.registrar("ia", `IA (${modelo}): cota estourada (429), esperando ${ESPERA_429_MS / 1000} s`, { disparo, modelo, status: 429 });
        await dormir(ESPERA_429_MS);
        if (!acabou) r = await chamarModelo(chave, modelo, parts, alca);
      }
      vivo = false;
      rodando--;
      if (acabou) return;
      r.modelo = modelo;
      r.ms = Date.now() - inicio;   // tempo total, esperas incluídas
      if (r.ok) return terminar(r);

      console.log(`[ia] ${modelo}: ${r.erro}${r.status ? " " + r.status : ""} ${String(r.detalhe || "").replace(/\s+/g, " ").slice(0, 140)}`);
      ultimoErro = r;
      // 503/404 passam o bastão na hora
      const passaBastao = (r.erro === "api" && [503, 404, 429].includes(r.status)) || r.erro === "rede";
      if (passaBastao && proximo < candidatos.length && rodando === 0) {
        eventos.registrar("ia", `IA (${modelo}): indisponível (${r.status || r.erro}), tentando ${candidatos[proximo]}`, { disparo, modelo, status: r.status || null });
        return tentar();
      }
      // outro modelo ainda correndo, deixa ele decidir
      if (rodando === 0) terminar(ultimoErro);
    }
    tentar();
  });
}

// alca.abort() cancela por fora (quem perdeu a corrida)
async function chamarModelo(chave, modelo, parts, alca = null) {
  const corpo = {
    contents: [{ parts }],
    generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
  };

  const controle = new AbortController();
  const prazo = setTimeout(() => controle.abort(), TEMPO_LIMITE_IA_MS);
  if (alca) alca.abort = () => controle.abort();
  let resposta;
  let json;
  try {
    resposta = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${chave}`,
      {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo),
        signal: controle.signal
      }
    );
    if (!resposta.ok) {
      const detalhe = (await resposta.text()).slice(0, 400);
      return { erro: "api", status: resposta.status, detalhe };
    }
    json = await resposta.json();
  } catch (e) {
    // conexão que caiu no meio do corpo (ou foi cancelada) cai aqui também
    return { erro: "rede", detalhe: e.message };
  } finally {
    clearTimeout(prazo);
  }

  const texto = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
  try {
    const bruto = texto.match(/\{[\s\S]*\}/);
    const r = JSON.parse(bruto ? bruto[0] : texto);
    return { ok: true, ...r };
  } catch {
    return { erro: "parse", texto: texto.slice(0, 400) };
  }
}

// modelos que a chave atual pode usar (só nomes, a chave não sai daqui)
async function listarModelos() {
  const chave = chaveAtual();
  if (!chave) return { erro: "sem_chave" };
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${chave}&pageSize=100`,
      { signal: AbortSignal.timeout(TEMPO_LIMITE_IA_MS) });
    if (!r.ok) return { erro: "api", status: r.status };
    const j = await r.json();
    return {
      ok: true,
      emUso: lerConfig().modelo || MODELO_PADRAO,
      modelos: (j.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map(m => m.name.replace("models/", ""))
    };
  } catch (e) {
    return { erro: "rede", detalhe: e.message };
  }
}

module.exports = { identificar, identificarLote, gerarFicha, temChave, salvarChave, listarModelos, lerConfig };
