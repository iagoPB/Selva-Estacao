// testes do disparo, peso, serial, eventos e ficha, com câmera e IA falsas
// rodar: node testes/testar.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
// os módulos gravam em dados/, no teste vai tudo pra uma pasta temporária
const PASTA_TESTE = fs.mkdtempSync(path.join(os.tmpdir(), "selva-testes-"));
process.env.SELVA_DADOS = PASTA_TESTE;

const { resolverPeso, referenciaDaEspecie } = require("../peso");
const { interpretarLinha, interpretarPeso, textoStatus } = require("../serial-arduino");
const { criarGatilho, limpar, ehPessoa, textoDisparo } = require("../gatilho");
const { ehAdmin, tokenAdmin } = require("../servidor");
const eventos = require("../eventos");
const catalogo = require("../catalogo");

let falhas = 0;
async function caso(nome, fn) {
  try {
    await fn();
    console.log(`ok   ${nome}`);
  } catch (e) {
    falhas++;
    console.log(`FALHA ${nome}\n     ${e.message}`);
  }
}

const SABIA = { nome: "Sabiá-laranjeira", cientifico: "Turdus rufiventris", emoji: "🐦", pesoMin: 64, pesoMax: 82 };
const GATO = { nome: "Gato-doméstico", cientifico: "Felis catus", emoji: "🐈", pesoMin: 3200, pesoMax: 5200 };

// ---------- peso ----------
(async () => {
await caso("referência pela faixa do catálogo", () => {
  assert.strictEqual(referenciaDaEspecie(SABIA), 73);
});

await caso("referência de espécie descoberta (pesoMedio)", () => {
  assert.strictEqual(referenciaDaEspecie({ nome: "Quero-quero", pesoMedio: 277 }), 277);
});

await caso("referência cai pro palpite da IA", () => {
  assert.strictEqual(referenciaDaEspecie(null, "150"), 150);
  assert.strictEqual(referenciaDaEspecie(null, "abc"), null);
});

await caso("peso plausível vence", () => {
  const p = resolverPeso({ pesoMedido: 70.4, especie: SABIA, nomeEspecie: SABIA.nome });
  assert.deepStrictEqual(p, { peso_g: 70.4, peso_origem: "balanca", peso_estimado: false, peso_suspeito: false, peso_medido_g: 70.4 });
});

await caso("pata do gato (20 g) cai pra referência e guarda o lido", () => {
  const p = resolverPeso({ pesoMedido: 20, especie: GATO, nomeEspecie: GATO.nome });
  assert.deepStrictEqual(p, { peso_g: 4200, peso_origem: "referencia", peso_estimado: true, peso_suspeito: true, peso_medido_g: 20 });
});

await caso("300 g num sabiá cai pra referência", () => {
  const p = resolverPeso({ pesoMedido: 300, especie: SABIA, nomeEspecie: SABIA.nome });
  assert.strictEqual(p.peso_g, 73);
  assert.strictEqual(p.peso_origem, "referencia");
  assert.strictEqual(p.peso_suspeito, true);
  assert.strictEqual(p.peso_medido_g, 300);
});

await caso("sem referência qualquer medida vale", () => {
  const p = resolverPeso({ pesoMedido: 300, especie: null, nomeEspecie: "Bicho X" });
  assert.strictEqual(p.peso_origem, "balanca");
  assert.strictEqual(p.peso_suspeito, false);
});

await caso("sem balança usa a média da estação", () => {
  const visitas = [70, 72, 74].map(g => ({ especie: SABIA.nome, peso_g: g, peso_origem: "balanca" }));
  visitas.push({ especie: SABIA.nome, peso_g: 999, peso_origem: "referencia", peso_estimado: true });
  visitas.push({ especie: SABIA.nome, peso_g: 300, peso_origem: "balanca", peso_suspeito: true });
  const p = resolverPeso({ pesoMedido: null, especie: SABIA, nomeEspecie: SABIA.nome, visitas });
  assert.deepStrictEqual(p, { peso_g: 72, peso_origem: "media_estacao", peso_estimado: true, peso_suspeito: false });
});

await caso("média da estação exige 3 medições", () => {
  const visitas = [70, 72].map(g => ({ especie: SABIA.nome, peso_g: g, peso_origem: "balanca" }));
  const p = resolverPeso({ pesoMedido: null, especie: SABIA, nomeEspecie: SABIA.nome, visitas });
  assert.strictEqual(p.peso_origem, "referencia");
});

await caso("sem nada pra estimar devolve nulo", () => {
  const p = resolverPeso({ pesoMedido: null, especie: null, nomeEspecie: "Bicho X" });
  assert.deepStrictEqual(p, { peso_g: null, peso_origem: null, peso_estimado: false, peso_suspeito: false });
});

await caso("medida sem referência é aceita", () => {
  const p = resolverPeso({ pesoMedido: 33, especie: null, nomeEspecie: "Bicho X" });
  assert.strictEqual(p.peso_origem, "balanca");
});

// ---------- serial ----------
await caso("linha G completa", () => {
  const s = interpretarLinha("G;12345;7;68.2;24.1;61;pir+peso");
  assert.strictEqual(s.peso_g, 68.2);
  assert.strictEqual(s.temperatura_c, 24.1);
  assert.strictEqual(s.umidade_pct, 61);
  assert.strictEqual(s.motivo, "pir+peso");
  assert.strictEqual(s.origem, "estacao");
});

await caso("linha G sem balança e DHT com erro", () => {
  const s = interpretarLinha("G;1;1;na;erro;erro;pir");
  assert.strictEqual(s.peso_g, null);
  assert.strictEqual(s.temperatura_c, null);
  assert.strictEqual(s.umidade_pct, null);
});

await caso("linha V antiga vira disparo do PIR", () => {
  const s = interpretarLinha("V;1;1;na;22.0;60");
  assert.strictEqual(s.motivo, "pir");
});

await caso("motivo desconhecido cai pro pir; lixo é ignorado", () => {
  assert.strictEqual(interpretarLinha("G;1;1;na;22;60;xyz").motivo, "pir");
  assert.strictEqual(interpretarLinha("D;pir_alto"), null);
  assert.strictEqual(interpretarLinha("G;1;2"), null);
});

await caso("linha G com peso pendente", () => {
  const s = interpretarLinha("G;500;3;pend;23.5;58;peso");
  assert.strictEqual(s.peso_g, null);
  assert.strictEqual(s.pesoPendente, true);
  assert.strictEqual(s.arduino_n, 3);
  assert.strictEqual(interpretarLinha("G;500;3;70.1;23.5;58;peso").pesoPendente, false);
});

await caso("recado P do peso estável", () => {
  assert.deepStrictEqual(interpretarPeso("P;3;68.4"), { n: 3, peso_g: 68.4 });
  assert.deepStrictEqual(interpretarPeso("P;4;na"), { n: 4, peso_g: null });
  assert.strictEqual(interpretarPeso("P;x;10"), null);
  assert.strictEqual(interpretarPeso("G;1;1;na;1;1;pir"), null);
});

await caso("linha S vira texto", () => {
  assert.strictEqual(textoStatus("S;balanca_rezerada"), "Serial: balança re-zerada");
  assert.strictEqual(textoStatus("S;pronta;sd=ok;balanca=off"), "Serial: Arduino pronto (sd ok, balanca off)");
  assert.strictEqual(textoStatus("S;coisa_nova"), "Serial: coisa_nova");
});

// ---------- registro de eventos ----------
await caso("eventos: registrar guarda tipo, texto, dados e hora", () => {
  const e = eventos.registrar("serial", "Serial: Arduino conectado em COM5", { porta: "COM5" });
  assert.strictEqual(e.tipo, "serial");
  assert.strictEqual(e.texto, "Serial: Arduino conectado em COM5");
  assert.deepStrictEqual(e.dados, { porta: "COM5" });
  assert.ok(!Number.isNaN(Date.parse(e.t)));
  assert.strictEqual(eventos.registrar("tipo_que_nao_existe", "x").tipo, "sistema");
  assert.ok(fs.readFileSync(eventos.ARQUIVO, "utf8").includes("Arduino conectado em COM5"));
});

await caso("eventos: ultimos(n) vem do mais novo pro mais antigo", () => {
  for (let i = 1; i <= 5; i++) eventos.registrar("sistema", `evento ${i}`);
  const u = eventos.ultimos(3);
  assert.deepStrictEqual(u.map(e => e.texto), ["evento 5", "evento 4", "evento 3"]);
  assert.strictEqual(eventos.ultimos(0).length, 0);
});

await caso("eventos: só os últimos 400 ficam em memória", () => {
  for (let i = 1; i <= 410; i++) eventos.registrar("sistema", `lote ${i}`);
  const todos = eventos.ultimos(1000);
  assert.strictEqual(todos.length, eventos.MAXIMO);
  assert.strictEqual(todos[0].texto, "lote 410");
  assert.strictEqual(todos[todos.length - 1].texto, "lote 11");
});

await caso("eventos: arquivo reescrito a cada 400 appends", () => {
  const linhasDoArquivo = () => fs.readFileSync(eventos.ARQUIVO, "utf8").split("\n").filter(Boolean);
  // memória já cheia (400), então logo depois de reescrever o arquivo tem 400 linhas
  let compactou = false;
  for (let i = 1; i <= eventos.MAXIMO && !compactou; i++) {
    eventos.registrar("sistema", `lote b ${i}`);
    if (linhasDoArquivo().length === eventos.MAXIMO) compactou = true;
  }
  assert.ok(compactou, "o arquivo não foi reescrito em 400 appends");
  const linhas = linhasDoArquivo();
  assert.strictEqual(linhas.length, eventos.MAXIMO);
  assert.strictEqual(JSON.parse(linhas[linhas.length - 1]).texto, eventos.ultimos(1)[0].texto);
  assert.strictEqual(JSON.parse(linhas[0]).texto, eventos.ultimos(eventos.MAXIMO).pop().texto);
});

await caso("eventos: aoRegistrar avisa e dá pra parar", () => {
  const vistos = [];
  const parar = eventos.aoRegistrar(e => vistos.push(e.texto));
  eventos.registrar("push", "Push enviado");
  parar();
  eventos.registrar("push", "Push depois de parar");
  assert.deepStrictEqual(vistos, ["Push enviado"]);
});

await caso("eventos: seg e gramas em pt-BR", () => {
  assert.strictEqual(eventos.seg(2840), "2,8 s");
  assert.strictEqual(eventos.seg(72000), "1 min 12 s");
  assert.strictEqual(eventos.gramas(71), "71 g");
  assert.strictEqual(eventos.gramas(1240), "1,2 kg");
  assert.strictEqual(eventos.gramas(null), "sem peso");
});

await caso("texto do disparo", () => {
  assert.strictEqual(textoDisparo({ motivo: "pir", temperatura_c: 24.1 }), "Disparo pelo PIR (temperatura 24,1 °C)");
  assert.strictEqual(textoDisparo({ motivo: "peso", pesoPendente: true }), "Disparo pela balança (balança ainda medindo)");
  assert.strictEqual(textoDisparo({ motivo: "teste" }), "Disparo de teste pelo Laboratório");
});

// ---------- segurança ----------
await caso("limpar tira marcação e corta o tamanho", () => {
  assert.strictEqual(limpar('<img src=x onerror="alert(1)">Sabiá', 60), "img src=x onerror=alert(1)Sabiá");
  assert.strictEqual(limpar("a".repeat(100), 10).length, 10);
  assert.strictEqual(limpar(null, 10), "");
});

await caso("ehAdmin: local sim, hotspot não", () => {
  const req = ip => ({ socket: { remoteAddress: ip }, headers: {} });
  const antes = process.env.ADMIN_REDE_LOCAL;
  delete process.env.ADMIN_REDE_LOCAL;
  try {
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      assert.strictEqual(ehAdmin(req(ip)), true, ip);
    }
    for (const ip of ["192.168.0.50", "10.0.0.2", "100.101.2.3", "fd7a:115c:a1e0::1", "8.8.8.8", ""]) {
      assert.strictEqual(ehAdmin(req(ip)), false, ip);
    }
    process.env.ADMIN_REDE_LOCAL = "1";
    assert.strictEqual(ehAdmin(req("::ffff:192.168.0.50")), true);
    assert.strictEqual(ehAdmin(req("8.8.8.8")), false);
    delete process.env.ADMIN_REDE_LOCAL;
    // token do app do PC: vale de qualquer rede; errado ou ausente, não
    const comToken = t => ({ socket: { remoteAddress: "10.172.17.80" }, headers: t == null ? {} : { "x-selva-admin": t } });
    assert.strictEqual(ehAdmin(comToken(tokenAdmin())), true);
    assert.strictEqual(ehAdmin(comToken("x".repeat(32))), false);
    assert.strictEqual(ehAdmin(comToken(null)), false);
  } finally {
    if (antes === undefined) delete process.env.ADMIN_REDE_LOCAL;
    else process.env.ADMIN_REDE_LOCAL = antes;
  }
});

// ---------- fluxo do disparo ----------
function montar(opcoes = {}) {
  const registro = { visitas: [], disparos: [], fotos: [], logs: [], descobertas: 0, avisadas: [] };
  // catalogação roda em segundo plano, quem precisa espera essa promise
  registro.descobertaAvisada = new Promise(res => { registro.avisar = res; });
  const catalogoFalso = {
    especies: [SABIA, GATO],
    buscar(nome, cient) {
      return this.especies.find(e => e.nome === nome || e.cientifico === cient) || null;
    },
    async descobrir(nome, cient, _ident, pesoIa) {
      registro.descobertas++;
      const nova = { nome, cientifico: cient, emoji: "🐾", pesoMedio: Number(pesoIa) || null, descoberta: true };
      this.especies.push(nova);
      return { especie: nova, nova: true };
    }
  };
  const gat = criarGatilho({
    capturar: opcoes.capturar || (async () => ({ ok: true, fotos: [Buffer.from("f0"), Buffer.from("f1"), Buffer.from("f2")] })),
    identificarLote: opcoes.identificarLote || (async () => ({ ok: true, eh_animal: true, melhor_indice: 1, especie_popular: "Sabiá-laranjeira", especie_cientifica: "Turdus rufiventris", confianca: 0.92, peso_tipico_g: 75 })),
    temChave: opcoes.temChave || (() => true),
    identificador: {},
    catalogo: catalogoFalso,
    resolverPeso,
    visitasAnteriores: () => registro.visitas,
    registrarVisita: (v, extras) => registro.visitas.push({ ...v, _extras: extras }),
    aoDescobrir: (especie, visita, disparo) => { registro.avisadas.push({ especie, visita, disparo }); registro.avisar(especie); },
    registrarDisparo: (motivo, resultado) => registro.disparos.push({ motivo, resultado }),
    gravarFoto: (nome, buf) => { registro.fotos.push({ nome, conteudo: buf.toString() }); return `/fotos/${nome}`; },
    log: m => registro.logs.push(m)
  });
  return { gat, registro, cat: catalogoFalso };
}

const respirar = () => new Promise(res => setTimeout(res, 20));

const SENSORES = { peso_g: 71, temperatura_c: 25, umidade_pct: 60, motivo: "pir+peso", origem: "estacao" };

await caso("animal: só a melhor foto, peso da balança", async () => {
  const { gat, registro } = montar();
  const r = await gat.processar(SENSORES);
  assert.ok(r.ok);
  assert.strictEqual(registro.fotos.length, 1);
  assert.strictEqual(registro.fotos[0].conteudo, "f1");
  const v = registro.visitas[0];
  assert.strictEqual(v.especie, "Sabiá-laranjeira");
  assert.strictEqual(v.peso_origem, "balanca");
  assert.strictEqual(v.peso_g, 71);
  assert.strictEqual(v.motivo, "pir+peso");
  assert.strictEqual(v._extras.identificada, true);
  assert.deepStrictEqual(registro.disparos, [{ motivo: "pir+peso", resultado: "visita" }]);
});

await caso("sem animal: nada gravado, conta disparo vazio", async () => {
  const { gat, registro } = montar({ identificarLote: async () => ({ ok: true, eh_animal: false, melhor_indice: 0, observacao: "só folhas" }) });
  const r = await gat.processar({ ...SENSORES, motivo: "pir" });
  assert.strictEqual(r.descartada, true);
  assert.strictEqual(registro.fotos.length, 0);
  assert.strictEqual(registro.visitas.length, 0);
  assert.deepStrictEqual(registro.disparos, [{ motivo: "pir", resultado: "vazio" }]);
});

await caso("pessoa é descartada, não vira espécie", async () => {
  const { gat, registro } = montar({
    identificarLote: async () => ({ ok: true, eh_animal: true, melhor_indice: 0, especie_popular: "Humano", especie_cientifica: "Homo sapiens", confianca: 0.99, peso_tipico_g: 70000 })
  });
  const r = await gat.processar(SENSORES);
  assert.strictEqual(r.descartada, true);
  assert.strictEqual(registro.visitas.length, 0);
  assert.strictEqual(registro.descobertas, 0);
  assert.strictEqual(registro.fotos.length, 0);
  assert.deepStrictEqual(registro.disparos, [{ motivo: "pir+peso", resultado: "vazio" }]);
  assert.strictEqual(ehPessoa({ especie_popular: "Pessoa" }), true);
  assert.strictEqual(ehPessoa({ especie_popular: "Sabiá-laranjeira", especie_cientifica: "Turdus rufiventris" }), false);
});

await caso("IA fora do ar: descarta, conta falha_ia", async () => {
  const { gat, registro } = montar({ identificarLote: async () => ({ erro: "rede" }) });
  const r = await gat.processar(SENSORES);
  assert.strictEqual(r.descartada, true);
  assert.strictEqual(registro.visitas.length, 0);
  assert.strictEqual(registro.fotos.length, 0);
  assert.deepStrictEqual(registro.disparos, [{ motivo: "pir+peso", resultado: "falha_ia" }]);
});

await caso("sem chave da IA: descarta sem chamar a IA", async () => {
  let chamou = false;
  const { gat, registro } = montar({ temChave: () => false, identificarLote: async () => { chamou = true; return {}; } });
  const r = await gat.processar(SENSORES);
  assert.strictEqual(chamou, false);
  assert.strictEqual(r.descartada, true);
  assert.strictEqual(registro.visitas.length, 0);
  assert.deepStrictEqual(registro.disparos, [{ motivo: "pir+peso", resultado: "sem_ia" }]);
});

await caso("câmera indisponível: descarta, conta sem_camera", async () => {
  const { gat, registro } = montar({ capturar: async () => ({ erro: "sem_camera" }) });
  const r = await gat.processar(SENSORES);
  assert.strictEqual(r.descartada, true);
  assert.strictEqual(registro.visitas.length, 0);
  assert.strictEqual(registro.fotos.length, 0);
  assert.deepStrictEqual(registro.disparos, [{ motivo: "pir+peso", resultado: "sem_camera" }]);
});

await caso("disparo durante captura é ignorado", async () => {
  let soltar;
  const { gat, registro } = montar({ capturar: () => new Promise(res => { soltar = () => res({ ok: true, fotos: [Buffer.from("a")] }); }) });
  const primeiro = gat.processar(SENSORES);
  const segundo = await gat.processar(SENSORES);
  assert.strictEqual(segundo.ignorado, true);
  soltar();
  await primeiro;
  assert.strictEqual(registro.visitas.length, 1);
  assert.strictEqual(gat.estaOcupado(), false);
});

await caso("captura que explode vira sem_camera e libera a trava", async () => {
  const { gat, registro } = montar({ capturar: async () => { throw new Error("boom"); } });
  const r = await gat.processar(SENSORES);
  assert.strictEqual(r.descartada, true);
  assert.strictEqual(gat.estaOcupado(), false);
  assert.deepStrictEqual(registro.disparos, [{ motivo: "pir+peso", resultado: "sem_camera" }]);
});

await caso("IA que explode descarta e libera a trava", async () => {
  const { gat, registro } = montar({ identificarLote: async () => { throw new Error("boom"); } });
  const r = await gat.processar(SENSORES);
  assert.strictEqual(r.descartada, true);
  assert.strictEqual(registro.visitas.length, 0);
  assert.strictEqual(gat.estaOcupado(), false);
  assert.deepStrictEqual(registro.disparos, [{ motivo: "pir+peso", resultado: "falha_ia" }]);
});

await caso("espécie nova: visita sai na hora, catálogo depois", async () => {
  const { gat, registro } = montar({
    identificarLote: async () => ({ ok: true, eh_animal: true, melhor_indice: 0, especie_popular: "Quero-quero", especie_cientifica: "Vanellus chilensis", confianca: 0.9, peso_tipico_g: 277 })
  });
  const r = await gat.processar({ ...SENSORES, peso_g: null });
  assert.ok(r.ok);
  assert.strictEqual(r.catalogando, true);
  const v = registro.visitas[0];
  assert.strictEqual(v.especie, "Quero-quero");
  assert.strictEqual(v.emoji, "🐾");
  assert.strictEqual(v.cientifico, "Vanellus chilensis");
  assert.strictEqual(v.peso_g, 277);
  assert.strictEqual(v.peso_estimado, true);
  assert.strictEqual(v._extras.descoberta, false);
  assert.strictEqual(v._extras.identificada, true);
  const especie = await registro.descobertaAvisada;
  assert.strictEqual(registro.descobertas, 1);
  assert.strictEqual(especie.nome, "Quero-quero");
  assert.strictEqual(registro.avisadas[0].visita.id, v.id);
});

await caso("espécie nova: visita não espera o catálogo", async () => {
  let soltar;
  const { gat, registro, cat } = montar({
    identificarLote: async () => ({ ok: true, eh_animal: true, melhor_indice: 0, especie_popular: "Tucano-toco", especie_cientifica: "Ramphastos toco", confianca: 0.95, peso_tipico_g: 600 })
  });
  // catálogo lento de mentira, só termina quando o teste soltar
  const descobrirOriginal = cat.descobrir.bind(cat);
  cat.descobrir = (...args) => new Promise(res => { soltar = () => res(descobrirOriginal(...args)); });
  const inicio = Date.now();
  const r = await gat.processar({ ...SENSORES, peso_g: null });
  assert.ok(r.ok);
  assert.ok(Date.now() - inicio < 1000, "visita devia sair antes do catálogo");
  assert.strictEqual(registro.visitas.length, 1);
  assert.strictEqual(registro.avisadas.length, 0);
  soltar();
  const especie = await registro.descobertaAvisada;
  assert.strictEqual(especie.nome, "Tucano-toco");
  assert.strictEqual(registro.descobertas, 1);
});

await caso("baixa confiança não cataloga, mas registra", async () => {
  const { gat, registro } = montar({
    identificarLote: async () => ({ ok: true, eh_animal: true, melhor_indice: 0, especie_popular: "Bicho raro", confianca: 0.3, peso_tipico_g: 40 })
  });
  const r = await gat.processar({ ...SENSORES, peso_g: null });
  await respirar();
  assert.strictEqual(r.catalogando, false);
  assert.strictEqual(registro.descobertas, 0);
  assert.strictEqual(registro.avisadas.length, 0);
  assert.strictEqual(registro.visitas[0].especie, "Bicho raro");
  assert.strictEqual(registro.visitas[0].peso_g, 40);
});

await caso("catálogo que falha vira erro no registro", async () => {
  const { gat, registro, cat } = montar({
    identificarLote: async () => ({ ok: true, eh_animal: true, melhor_indice: 0, especie_popular: "Bicho novo", especie_cientifica: "Novus novus", confianca: 0.9, peso_tipico_g: 10 })
  });
  cat.descobrir = async () => { throw new Error("wiki fora"); };
  const r = await gat.processar(SENSORES);
  assert.ok(r.ok);
  await respirar();
  assert.strictEqual(registro.avisadas.length, 0);
  assert.ok(registro.logs.some(l => l.includes("wiki fora")));
  const erro = eventos.ultimos(10).find(e => e.tipo === "erro" && e.texto.includes("Bicho novo"));
  assert.ok(erro, "faltou o evento de erro do catálogo");
});

await caso("registro: passos do disparo com o mesmo número", async () => {
  const { gat } = montar();
  await gat.processar({ ...SENSORES, arduino_n: 77 });
  const doDisparo = eventos.ultimos(20).filter(e => e.dados.disparo === 77).reverse();
  assert.deepStrictEqual(doDisparo.map(e => e.tipo), ["disparo", "visita"]);
  assert.strictEqual(doDisparo[0].texto, "Disparo pelo PIR e pela balança (temperatura 25 °C, 71 g na balança)");
  assert.strictEqual(doDisparo[1].texto, "Visita registrada: Sabiá-laranjeira, 71 g na balança");
  assert.strictEqual(doDisparo[1].dados.etapa, "fim");
  assert.ok(doDisparo[1].dados.ms >= 0);
});

await caso("registro: disparo sem Arduino ganha número local", async () => {
  const { gat } = montar({ identificarLote: async () => ({ ok: true, eh_animal: false, melhor_indice: 0, observacao: "só vento" }) });
  await gat.processar({ ...SENSORES, motivo: "teste" });
  const [visita, disparo] = eventos.ultimos(2);
  assert.strictEqual(disparo.tipo, "disparo");
  assert.strictEqual(disparo.texto, "Disparo de teste pelo Laboratório (temperatura 25 °C, 71 g na balança)");
  assert.ok(String(disparo.dados.disparo).startsWith("local-"));
  assert.strictEqual(visita.tipo, "descarte");
  assert.strictEqual(visita.dados.disparo, disparo.dados.disparo);
  assert.strictEqual(visita.texto, "Descartado: nenhum animal nas fotos, só vento");
  assert.ok(visita.dados.ms >= 0);
});

await caso("registro: descarte em frase, código em dados", async () => {
  const semCam = montar({ capturar: async () => ({ erro: "sem_camera", frase: "a estação não achou a webcam USB" }) });
  await semCam.gat.processar({ ...SENSORES, arduino_n: 31 });
  const d1 = eventos.ultimos(5).find(e => e.tipo === "descarte" && e.dados.disparo === 31);
  assert.strictEqual(d1.texto, "Descartado: sem fotos, a estação não achou a webcam USB");
  assert.strictEqual(d1.dados.erro, "sem_camera");
  const semIa = montar({ identificarLote: async () => ({ erro: "api", status: 503, frase: "o Gemini respondeu erro 503" }) });
  await semIa.gat.processar({ ...SENSORES, arduino_n: 32 });
  const d2 = eventos.ultimos(5).find(e => e.tipo === "descarte" && e.dados.disparo === 32);
  assert.strictEqual(d2.texto, "Descartado: falha na IA, o Gemini respondeu erro 503");
  assert.strictEqual(d2.dados.erro, "api");
  assert.strictEqual(d2.dados.status, 503);
});

await caso("peso pendente em disparo descartado desarma o prazo", async () => {
  const { gat } = montar({ identificarLote: async () => ({ ok: true, eh_animal: false, melhor_indice: 0 }) });
  await gat.processar({ ...SENSORES, peso_g: null, pesoPendente: true, arduino_n: 42 });
  await new Promise(res => setTimeout(res, 6700));
  const doDisparo = eventos.ultimos(30).filter(e => e.dados.disparo === 42);
  assert.ok(!doDisparo.some(e => e.tipo === "balanca"), "prazo do peso registrou em disparo já encerrado");
  assert.deepStrictEqual(doDisparo.map(e => e.tipo), ["descarte", "disparo"]);
});

await caso("gato com pata na balança no fluxo inteiro", async () => {
  const { gat, registro } = montar({
    identificarLote: async () => ({ ok: true, eh_animal: true, melhor_indice: 2, especie_popular: "Gato-doméstico", especie_cientifica: "Felis catus", confianca: 0.97 })
  });
  await gat.processar({ ...SENSORES, peso_g: 18 });
  const v = registro.visitas[0];
  assert.strictEqual(v.peso_origem, "referencia");
  assert.strictEqual(v.peso_g, 4200);
  assert.strictEqual(v.peso_estimado, true);
  assert.strictEqual(v.peso_suspeito, true);
  assert.strictEqual(v.peso_medido_g, 18);
  assert.strictEqual(registro.fotos[0].conteudo, "f2");
});

await caso("estação virtual com 1 foto segue o mesmo fluxo", async () => {
  const { gat, registro } = montar();
  const r = await gat.avaliar([Buffer.from("unica")], { peso_g: null, temperatura_c: null, umidade_pct: null, motivo: "camera", origem: "estacao-virtual" });
  assert.ok(r.ok);
  assert.strictEqual(registro.visitas[0].origem, "estacao-virtual");
  assert.strictEqual(registro.visitas[0].peso_origem, "referencia");
});

await caso("melhor_indice fora do alcance cai na primeira foto", async () => {
  const { gat, registro } = montar({
    identificarLote: async () => ({ ok: true, eh_animal: true, melhor_indice: 9, especie_popular: "Sabiá-laranjeira", confianca: 0.9 })
  });
  await gat.processar(SENSORES);
  assert.strictEqual(registro.fotos[0].conteudo, "f0");
});

await caso("peso pendente espera o P", async () => {
  const { gat, registro } = montar();
  const fluxo = gat.processar({ ...SENSORES, peso_g: null, pesoPendente: true, arduino_n: 12 });
  gat.receberPeso(11, 999);   // P de outro disparo não conta
  gat.receberPeso(12, 69.8);
  await fluxo;
  const v = registro.visitas[0];
  assert.strictEqual(v.peso_g, 69.8);
  assert.strictEqual(v.peso_origem, "balanca");
});

await caso("peso pendente que nunca chega vira estimativa", async () => {
  const { gat, registro } = montar();
  const inicio = Date.now();
  await gat.processar({ ...SENSORES, peso_g: null, pesoPendente: true, arduino_n: 5 });
  assert.ok(Date.now() - inicio >= 6400, "devia esperar o prazo do peso");
  const v = registro.visitas[0];
  assert.strictEqual(v.peso_origem, "referencia");
  assert.strictEqual(v.peso_estimado, true);
});

await caso("P = na também vira estimativa", async () => {
  const { gat, registro } = montar();
  const fluxo = gat.processar({ ...SENSORES, peso_g: null, pesoPendente: true, arduino_n: 8 });
  gat.receberPeso(8, null);
  await fluxo;
  assert.strictEqual(registro.visitas[0].peso_origem, "referencia");
});

await caso("descoberta repetida não avisa como nova", async () => {
  const visitas = [];
  const avisos = [];
  const cat = { buscar: () => null, descobrir: async () => ({ especie: SABIA, nova: false }) };
  const gat = criarGatilho({
    capturar: async () => ({ ok: true, fotos: [Buffer.from("x")] }),
    identificarLote: async () => ({ ok: true, eh_animal: true, melhor_indice: 0, especie_popular: "Sabiá", confianca: 0.9 }),
    temChave: () => true, identificador: {}, catalogo: cat, resolverPeso,
    visitasAnteriores: () => [], registrarVisita: (v, e) => visitas.push({ ...v, _extras: e }),
    aoDescobrir: e => avisos.push(e),
    registrarDisparo: () => {}, gravarFoto: n => `/fotos/${n}`, log: () => {}
  });
  await gat.processar(SENSORES);
  await respirar();
  assert.strictEqual(visitas[0]._extras.descoberta, false);
  // visita sai com o nome da IA, o catálogo acerta depois
  assert.strictEqual(visitas[0].especie, "Sabiá");
  assert.strictEqual(avisos.length, 0);
});

// ---------- ficha da espécie ----------
// fetch falso: url que casa com uma rota devolve o corpo, resto 404, "falha" lança
const fetchReal = global.fetch;
function fetchFalso(rotas, chamadas = []) {
  return async (url) => {
    chamadas.push(url);
    if (rotas.falha) throw new Error("rede fora");
    for (const [padrao, corpo] of Object.entries(rotas)) {
      if (padrao !== "falha" && url.includes(padrao)) return { ok: true, status: 200, json: async () => corpo };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}
const RESUMO_PT = { title: "Pica-pau-de-cabeça-vermelha", extract: "O pica-pau-de-cabeça-vermelha é uma ave piciforme da família dos picídeos, comum na América do Norte.", thumbnail: { source: "https://upload.wikimedia.org/x/320px-Pica.jpg" }, content_urls: { desktop: { page: "https://pt.wikipedia.org/wiki/Pica-pau" } } };
const IA_FALSA = { gerarFicha: async () => ({ ok: true, emoji: "🐦", peso_medio_g: 85, sobre: "Texto da IA sobre a ave, com duas frases inteiras. Vive em matas e come frutas e insetos.", curiosidades: ["c1", "c2"] }) };
const SEM_IA = { gerarFicha: async () => ({ erro: "sem_chave" }) };
const fichas = () => JSON.parse(fs.readFileSync(catalogo.ARQUIVO_FICHAS, "utf8"));
let n = 0;
const bicho = () => ({ nome: `Bicho ${++n}`, cientifico: `Bichus ${n}`, wiki: `Bicho ${n}`, emoji: "🐾" });

await caso("ficha: Wikipédia pt preenche tudo", async () => {
  const chamadas = [];
  global.fetch = fetchFalso({ "pt.wikipedia.org/api/rest_v1/page/summary/Bicho": RESUMO_PT }, chamadas);
  const e = await catalogo.preencherFicha(bicho(), IA_FALSA);
  assert.strictEqual(e.foto, "https://upload.wikimedia.org/x/320px-Pica.jpg");
  assert.strictEqual(e.sobre, RESUMO_PT.extract);
  assert.strictEqual(e.fonte, "https://pt.wikipedia.org/wiki/Pica-pau");
  assert.strictEqual(e.fonteNome, "Wikipedia");
  assert.deepStrictEqual(e.curiosidades, ["c1", "c2"]);
  assert.strictEqual(e.pesoMedio, 85);
  assert.strictEqual(e.fichaOk, true);
  assert.strictEqual(e.fichaTentativas, 1);
  assert.ok(!chamadas.some(u => u.includes("inaturalist")), "não devia chamar o iNaturalist");
  assert.ok(fichas()[e.nome].foto, "fichas.json sem a foto");
  const ev = eventos.ultimos(3).find(x => x.tipo === "catalogo" && x.texto.startsWith(`Ficha de ${e.nome}`));
  assert.ok(ev && ev.texto.includes("foto de Wikipédia pt") && ev.texto.includes("ficha completa"), ev && ev.texto);
});

await caso("ficha: busca pelo científico acha", async () => {
  const b = bicho();
  global.fetch = fetchFalso({
    "rest.php/v1/search/title?q=Bichus": { pages: [{ title: "Pica-pau-de-cabeça-vermelha", matched_title: b.cientifico }] },
    "summary/Pica-pau-de-cabe": RESUMO_PT
  });
  const e = await catalogo.preencherFicha(b, IA_FALSA);
  assert.strictEqual(e.foto, RESUMO_PT.thumbnail.source);
  assert.strictEqual(e.sobre, RESUMO_PT.extract);
  assert.strictEqual(e.fichaOk, true);
});

await caso("ficha: só iNaturalist e sem IA fica incompleta com foto", async () => {
  const b = bicho();
  global.fetch = fetchFalso({
    "api.inaturalist.org/v1/taxa": { results: [{ id: 7, name: b.cientifico, default_photo: { medium_url: "https://static.inaturalist.org/photos/1/medium.jpeg" }, wikipedia_url: "https://en.wikipedia.org/wiki/Bichus" }] }
  });
  const e = await catalogo.preencherFicha(b, SEM_IA);
  assert.strictEqual(e.foto, "https://static.inaturalist.org/photos/1/medium.jpeg");
  assert.strictEqual(e.fonte, "https://en.wikipedia.org/wiki/Bichus");
  // crédito da foto é do iNaturalist, não da Wikipédia do link
  assert.strictEqual(e.fotoFonte, "iNaturalist");
  assert.strictEqual(e.fotoUrl, "https://www.inaturalist.org/taxa/7");
  assert.strictEqual(e.sobre, null);
  assert.strictEqual(e.fichaOk, false);
});

await caso("ficha: científico antes do popular (Pardal na pt é o gênero)", async () => {
  const b = bicho();
  const genero = { ...RESUMO_PT, title: b.wiki, extract: "Bichus é um gênero da família Bichidae, também conhecido como bicho. O gênero inclui várias espécies.", thumbnail: { source: "https://upload.wikimedia.org/x/outro_bicho.jpg" }, content_urls: { desktop: { page: "https://pt.wikipedia.org/wiki/Bicho" } } };
  global.fetch = fetchFalso({
    "rest.php/v1/search/title?q=Bichus": { pages: [{ title: "Bicho-comum", matched_title: b.cientifico }] },
    "summary/Bicho-comum": RESUMO_PT,
    "summary/Bicho": genero
  });
  const e = await catalogo.preencherFicha(b, IA_FALSA);
  assert.strictEqual(e.foto, RESUMO_PT.thumbnail.source);
  assert.strictEqual(e.sobre, RESUMO_PT.extract);
  assert.strictEqual(e.fonte, "https://pt.wikipedia.org/wiki/Pica-pau");
  assert.strictEqual(e.fotoFonte, "Wikipédia");
  assert.strictEqual(e.fotoUrl, "https://pt.wikipedia.org/wiki/Pica-pau");
});

await caso("ficha: nada achado dá fichaOk false e erro no registro", async () => {
  global.fetch = fetchFalso({ falha: true });
  const b = bicho();
  const e = await catalogo.preencherFicha(b, SEM_IA);
  assert.strictEqual(e.fichaOk, false);
  assert.strictEqual(e.foto, null);
  assert.strictEqual(e.sobre, null);
  assert.strictEqual(e.fichaTentativas, 1);
  const erro = eventos.ultimos(3).find(x => x.tipo === "erro" && x.texto.startsWith(`Ficha de ${b.nome}`));
  assert.ok(erro, "faltou o evento de erro");
  // segunda tentativa no dia conta
  const e2 = await catalogo.preencherFicha(b, SEM_IA);
  assert.strictEqual(e2.fichaTentativas, 2);
});

await caso("ficha: IA escreve o sobre, wiki en só dá foto", async () => {
  global.fetch = fetchFalso({
    "en.wikipedia.org/api/rest_v1/page/summary/Bichus": { title: "Bichus", extract: "English text", thumbnail: { source: "https://upload.wikimedia.org/en/Bichus.png" }, content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Bichus" } } }
  });
  const e = await catalogo.preencherFicha(bicho(), IA_FALSA);
  assert.strictEqual(e.foto, "https://upload.wikimedia.org/en/Bichus.png");
  assert.strictEqual(e.sobre, "Texto da IA sobre a ave, com duas frases inteiras. Vive em matas e come frutas e insetos.");
  assert.strictEqual(e.fonteNome, "IA");
  assert.strictEqual(e.fonte, "https://en.wikipedia.org/wiki/Bichus");
  assert.strictEqual(e.fichaOk, true);
});

await caso("ficha: busca fuzzy que não casa o nome é ignorada", async () => {
  global.fetch = fetchFalso({
    "rest.php/v1/search/title": { pages: [{ title: "Melanerpes", matched_title: "Melanerpes" }] },
    "api.inaturalist.org/v1/taxa": { results: [{ id: 1, name: "Melissodes bimaculatus nullus", matched_term: "Melissodes bimaculatus nullus", default_photo: { medium_url: "https://x/abelha.jpg" } }] }
  });
  const e = await catalogo.preencherFicha(bicho(), SEM_IA);
  assert.strictEqual(e.foto, null);
  assert.strictEqual(e.fichaOk, false);
});

await caso("ficha: extract curto não vale, IA escreve o sobre", async () => {
  global.fetch = fetchFalso({ "summary/Bicho": { ...RESUMO_PT, extract: "Phytolacca dioica" } });
  const e = await catalogo.preencherFicha(bicho(), IA_FALSA);
  assert.strictEqual(e.foto, RESUMO_PT.thumbnail.source);
  assert.strictEqual(e.fonteNome, "IA");
  assert.ok(e.sobre.startsWith("Texto da IA"));
  assert.strictEqual(e.fichaOk, true);
});

await caso("ficha: fotoValida só aceita http(s) e imagem", () => {
  assert.strictEqual(catalogo.fotoValida("https://a.b/x.jpg"), true);
  assert.strictEqual(catalogo.fotoValida("https://a.b/x.JPG?v=1"), true);
  assert.strictEqual(catalogo.fotoValida("https://a.b/x.svg"), false);
  assert.strictEqual(catalogo.fotoValida("data:image/png;base64,AAA"), false);
  assert.strictEqual(catalogo.fotoValida("ftp://a.b/x.jpg"), false);
  assert.strictEqual(catalogo.fotoValida(null), false);
});

await caso("ficha: espécie fixa ganha foto sem mexer no especies.js", async () => {
  global.fetch = fetchFalso({ "summary/Bem-te-vi": { ...RESUMO_PT, title: "Bem-te-vi" } });
  const fixa = catalogo.todos().find(e => e.nome === "Bem-te-vi");
  assert.strictEqual(fixa.fichaOk, false);
  const e = await catalogo.preencherFicha(fixa, SEM_IA);
  assert.strictEqual(e.fichaOk, true);
  assert.strictEqual(e.curiosidades.length, 4);   // as do especies.js
  assert.strictEqual(require("../especies")[0].foto, undefined);
  assert.strictEqual(catalogo.todos().find(x => x.nome === "Bem-te-vi").foto, RESUMO_PT.thumbnail.source);
});

await caso("ficha: aoAtualizar avisa, vigia respeita o limite diário", async () => {
  const avisos = [];
  const parar = catalogo.aoAtualizar(e => avisos.push(e.nome));
  global.fetch = fetchFalso({ falha: true });
  const b = bicho();
  await catalogo.preencherFicha(b, SEM_IA);
  assert.deepStrictEqual(avisos, []);
  global.fetch = fetchFalso({ "summary/Bicho": RESUMO_PT });
  await catalogo.preencherFicha(b, IA_FALSA);
  assert.deepStrictEqual(avisos, [b.nome]);
  parar();
  // 20 tentativas hoje, o vigia pula
  const f = fichas();
  const c = bicho();
  f[c.nome] = { fichaTentativas: catalogo.MAXIMO_TENTATIVAS_DIA, fichaUltima: new Date().toISOString() };
  fs.writeFileSync(catalogo.ARQUIVO_FICHAS, JSON.stringify(f));
  delete require.cache[require.resolve("../catalogo")];
  const cat2 = require("../catalogo");
  const chamadas = [];
  global.fetch = fetchFalso({ falha: true }, chamadas);
  // só a fixa sem ficha é tentada, as completas e a estourada não
  await cat2.completarPendentes(SEM_IA, 0);
  assert.ok(!chamadas.some(u => u.includes(encodeURIComponent(c.nome))), "espécie com 20 tentativas foi tentada");
  assert.ok(!chamadas.some(u => u.includes("Bem-te-vi")), "ficha completa foi tentada de novo");
});

await caso("ficha: descobrir cataloga e preenche a ficha", async () => {
  global.fetch = fetchFalso({ "summary/Bicho": RESUMO_PT });
  const b = bicho();
  const r = await catalogo.descobrir(b.nome, b.cientifico, IA_FALSA, 120, 9);
  assert.strictEqual(r.nova, true);
  assert.strictEqual(r.especie.emoji, "🐦");
  assert.strictEqual(r.especie.fichaOk, true);
  assert.strictEqual(r.especie.pesoMedio, 120);   // palpite da identificação serviu
  assert.strictEqual(r.especie.descoberta, true);
  const deNovo = await catalogo.descobrir(b.nome, b.cientifico, IA_FALSA);
  assert.strictEqual(deNovo.nova, false);
});
global.fetch = fetchReal;

await caso("eventos: arquivo grande é enxugado na subida", () => {
  // módulo recarregado lendo um eventos.jsonl de uns 250 KB
  const enchimento = "x".repeat(300);
  const linhas = [];
  for (let i = 1; i <= 700; i++) linhas.push(JSON.stringify({ t: new Date().toISOString(), tipo: "sistema", texto: `velho ${i} ${enchimento}`, dados: {} }));
  fs.writeFileSync(eventos.ARQUIVO, linhas.join("\n") + "\n");
  delete require.cache[require.resolve("../eventos")];
  const novo = require("../eventos");
  const u = novo.ultimos(1000);
  assert.strictEqual(u.length, novo.MAXIMO);
  assert.ok(u[0].texto.startsWith("velho 700 "));
  const noDisco = fs.readFileSync(novo.ARQUIVO, "utf8").split("\n").filter(Boolean);
  assert.strictEqual(noDisco.length, novo.MAXIMO);
  assert.ok(JSON.parse(noDisco[0]).texto.startsWith("velho 301 "));
});

fs.rmSync(PASTA_TESTE, { recursive: true, force: true });
console.log(falhas ? `\n${falhas} teste(s) falharam` : "\ntodos os testes passaram");
process.exit(falhas ? 1 : 0);
})();
