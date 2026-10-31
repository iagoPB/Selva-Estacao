// disparo: PIR ou balança acordam a câmera, 3 fotos e a IA decide. com bicho
// fica só a melhor foto, sem bicho (ou sem como julgar) só entra na estatística
const eventos = require("./eventos");

const LIMIAR_CATALOGAR = 0.5;
const ESPERA_PESO_MS = 6500;

// texto da IA vai pro HTML do app, tira o que vira marcação
function limpar(texto, maximo) {
  return String(texto || "").replace(/[<>"'`]/g, "").trim().slice(0, maximo);
}

// a IA às vezes devolve quem tá na frente da câmera como "Humano, Homo sapiens, 99%"
function ehPessoa(r) {
  const texto = `${r.especie_popular || ""} ${r.especie_cientifica || ""}`.toLowerCase();
  return /homo sapiens|humano|pessoa|ser humano|\bhomem\b|\bmulher\b|crian[cç]a/.test(texto);
}

const NOME_MOTIVO = {
  pir: "pelo PIR", peso: "pela balança", "pir+peso": "pelo PIR e pela balança",
  teste: "de teste pelo Laboratório", camera: "pela estação virtual (webcam)"
};

function textoDisparo(sensores) {
  const partes = [];
  if (sensores.temperatura_c != null) partes.push(`temperatura ${String(sensores.temperatura_c).replace(".", ",")} °C`);
  if (sensores.peso_g != null) partes.push(eventos.gramas(sensores.peso_g) + " na balança");
  else if (sensores.pesoPendente) partes.push("balança ainda medindo");
  const motivo = NOME_MOTIVO[sensores.motivo] || `por ${sensores.motivo || "sensor"}`;
  return `Disparo ${motivo}${partes.length ? ` (${partes.join(", ")})` : ""}`;
}

function criarGatilho(d) {
  let ocupado = false;
  // n do disparo no Arduino -> resolve do peso. o Arduino avisa na hora e manda o
  // peso estável num segundo recado (mede por até 5 s, câmera + IA demoram mais)
  const pesosPendentes = new Map();

  function novoId() {
    return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  function esperarPeso(sensores, ctx) {
    if (!sensores.pesoPendente) return Promise.resolve(sensores.peso_g ?? null);
    const n = sensores.arduino_n;
    return new Promise(resolve => {
      const prazo = setTimeout(() => {
        pesosPendentes.delete(n);
        eventos.registrar("balanca", "Balança: o recado do peso não chegou, vai de estimativa", { disparo: ctx.disparo, ms: ESPERA_PESO_MS, etapa: "balanca" });
        resolve(null);
      }, ESPERA_PESO_MS);
      pesosPendentes.set(n, peso => { clearTimeout(prazo); pesosPendentes.delete(n); resolve(peso); });
      // disparo descartado antes do peso: desarma o prazo, senão ele anota
      // "vai de estimativa" num disparo já encerrado
      ctx.soltarPeso = () => { clearTimeout(prazo); pesosPendentes.delete(n); resolve(null); };
    });
  }

  // chamado pelo leitor serial quando chega o recado P;<n>;<peso>
  function receberPeso(n, peso) {
    const entregar = pesosPendentes.get(n);
    if (entregar) entregar(peso);
  }

  // ctx acompanha o disparo inteiro: número (pro registro) e hora do início
  function abrirDisparo(sensores) {
    const ctx = { disparo: sensores.arduino_n ?? eventos.novoDisparo(), inicio: Date.now() };
    eventos.registrar("disparo", textoDisparo(sensores), { disparo: ctx.disparo, motivo: sensores.motivo || null, origem: sensores.origem || null });
    return ctx;
  }

  function decorrido(ctx) {
    return Date.now() - ctx.inicio;
  }

  function montarVisita({ id, especie, cientifico, emoji, confianca, peso, sensores, foto, observacao }) {
    return {
      id,
      timestamp: new Date().toISOString(),
      especie, cientifico, emoji,
      confianca,
      peso_g: peso.peso_g,
      peso_origem: peso.peso_origem,
      peso_estimado: peso.peso_estimado,
      peso_suspeito: !!peso.peso_suspeito,
      peso_medido_g: peso.peso_medido_g ?? null,
      temperatura_c: sensores.temperatura_c ?? null,
      umidade_pct: sensores.umidade_pct ?? null,
      foto,
      origem: sensores.origem,
      motivo: sensores.motivo || null,
      observacao: observacao || ""
    };
  }

  // tempo total vai em dados.ms, extra leva o código bruto do erro
  function descartar(ctx, motivo, resultado, detalhe, extra = {}) {
    d.registrarDisparo(motivo, resultado);
    const ms = decorrido(ctx);
    eventos.registrar("descarte", `Descartado: ${detalhe}`, { disparo: ctx.disparo, ms, resultado, etapa: "fim", ...extra });
    return { descartada: true, motivo: detalhe };
  }

  // sem como julgar não vira visita, só estatística (senão o feed enche de "Não identificado")
  function semJulgamento(ctx, motivo, resultado, detalhe, extra) {
    d.log(`[disparo] ${motivo}: descartado sem julgamento (${detalhe})`);
    return descartar(ctx, motivo, resultado, detalhe, extra);
  }

  // espécie fora do catálogo: cataloga em segundo plano (wikipédia + ficha da IA,
  // uns 10 a 20 s). se for nova mesmo, d.aoDescobrir avisa o servidor
  function catalogarDepois(popular, cientificoIa, r, visita, ctx) {
    const t0 = Date.now();
    eventos.registrar("catalogo", `Catálogo: ${popular} não está no catálogo, catalogando em segundo plano`, { disparo: ctx.disparo });
    Promise.resolve(d.catalogo.descobrir(popular, cientificoIa, d.identificador, r.peso_tipico_g, ctx.disparo))
      .then(res => {
        if (res.nova && d.aoDescobrir) d.aoDescobrir(res.especie, visita, ctx.disparo);
      })
      .catch(e => {
        d.log(`[catalogo] falha ao catalogar ${popular}: ${e.message}`);
        eventos.registrar("erro", `Catálogo: falha ao catalogar ${popular} (${e.message}), em ${eventos.seg(Date.now() - t0)}`, { disparo: ctx.disparo, etapa: "catalogo" });
      });
  }

  // parte depois das fotos. a estação virtual (webcam do navegador) entra direto
  // aqui com 1 foto. pesoPromessa = peso que ainda vai chegar
  async function avaliar(fotos, sensores, pesoPromessa = Promise.resolve(sensores.peso_g ?? null), ctx = null) {
    const motivo = sensores.motivo || "camera";
    if (!ctx) ctx = abrirDisparo({ ...sensores, motivo });

    if (!d.temChave()) return semJulgamento(ctx, motivo, "sem_ia", "IA sem chave configurada", { erro: "sem_chave" });

    let r;
    try {
      r = await d.identificarLote(fotos.map(b => b.toString("base64")), "image/jpeg", ctx.disparo);
    } catch (e) {
      r = { erro: "excecao", detalhe: e.message, frase: `a IA estourou uma exceção (${e.message})` };
      eventos.registrar("erro", `IA: estourou uma exceção (${e.message})`, { disparo: ctx.disparo, etapa: "identificacao" });
    }

    if (r.ok && (r.eh_animal === false || ehPessoa(r))) {
      d.log(`[disparo] ${motivo}: nenhum animal nas fotos, descartadas (${r.observacao || "sem obs."})`);
      const porque = ehPessoa(r) ? "pessoa na frente da câmera" : `nenhum animal nas fotos${r.observacao ? ", " + limpar(r.observacao, 80) : ""}`;
      descartar(ctx, motivo, "vazio", porque);
      return { descartada: true, motivo: limpar(r.observacao, 120) || "nenhum animal nas fotos" };
    }

    // r.frase já vem em texto de gente do identificador
    if (!r.ok) return semJulgamento(ctx, motivo, "falha_ia", `falha na IA, ${r.frase || "sem resposta"}`, { erro: r.erro || null, status: r.status || null });

    const popular = limpar(r.especie_popular, 60);
    const cientificoIa = limpar(r.especie_cientifica, 60);
    const id = novoId();
    const foto = d.gravarFoto(`${id}.jpg`, fotos[r.melhor_indice] || fotos[0]);

    const conhecida = d.catalogo.buscar(popular, cientificoIa);
    const catalogar = !conhecida && !!popular && (Number(r.confianca) || 0) >= LIMIAR_CATALOGAR;

    const especie = conhecida ? conhecida.nome : (popular || "Não identificado");
    const pesoMedido = await pesoPromessa;
    const peso = d.resolverPeso({
      pesoMedido,
      especie: conhecida,
      nomeEspecie: especie,
      pesoTipicoIa: r.peso_tipico_g,
      visitas: d.visitasAnteriores()
    });

    const visita = montarVisita({
      id, especie,
      cientifico: conhecida ? conhecida.cientifico : cientificoIa,
      emoji: conhecida ? conhecida.emoji : "🐾",
      confianca: Number(r.confianca) || 0,
      peso, sensores, foto, observacao: limpar(r.observacao, 120)
    });
    d.registrarVisita(visita, { identificada: true, descoberta: false, disparo: ctx.disparo });
    d.registrarDisparo(motivo, "visita");

    const ms = decorrido(ctx);
    const comoPesou = peso.peso_g == null ? "sem peso"
      : peso.peso_origem === "balanca" ? `${eventos.gramas(peso.peso_g)} na balança`
      : peso.peso_suspeito ? `~${eventos.gramas(peso.peso_g)} estimado (a balança leu ${eventos.gramas(peso.peso_medido_g)}, surreal pra espécie)`
      : `~${eventos.gramas(peso.peso_g)} estimado`;
    eventos.registrar("visita", `Visita registrada: ${especie}, ${comoPesou}`,
      { disparo: ctx.disparo, ms, especie, peso_g: peso.peso_g, peso_origem: peso.peso_origem, etapa: "fim" });

    if (catalogar) catalogarDepois(popular, cientificoIa, r, visita, ctx);
    return { ok: true, visita, catalogando: catalogar };
  }

  // disparo dos sensores: tira as fotos e avalia. um por vez, o que chega no
  // meio de uma captura é ignorado (é o mesmo bicho)
  async function processar(sensores) {
    if (ocupado) {
      d.log(`[disparo] ${sensores.motivo}: ignorado, captura em andamento`);
      eventos.registrar("descarte", `${textoDisparo(sensores)}: ignorado, a câmera ainda está com o disparo anterior`, { disparo: sensores.arduino_n ?? null, ignorado: true });
      return { ignorado: true };
    }
    ocupado = true;
    const ctx = abrirDisparo(sensores);
    // tem que ser antes de qualquer await, senão o recado do peso se perde
    const pesoPromessa = esperarPeso(sensores, ctx);
    try {
      let cap;
      try {
        cap = await d.capturar(3, ctx.disparo);
      } catch (e) {
        cap = { erro: "captura_falhou", detalhe: e.message, frase: `a câmera estourou uma exceção (${e.message})` };
        eventos.registrar("erro", `Câmera: estourou uma exceção (${e.message})`, { disparo: ctx.disparo, etapa: "camera" });
      }
      if (!cap.ok) {
        return semJulgamento(ctx, sensores.motivo || "sensor", "sem_camera",
          `sem fotos, ${cap.frase || "câmera indisponível"}`, { erro: cap.erro || null });
      }
      return await avaliar(cap.fotos, sensores, pesoPromessa, ctx);
    } finally {
      ocupado = false;
      if (ctx.soltarPeso) ctx.soltarPeso();   // não faz nada se o peso já chegou
    }
  }

  return { processar, avaliar, receberPeso, estaOcupado: () => ocupado };
}

module.exports = { criarGatilho, limpar, ehPessoa, textoDisparo };
