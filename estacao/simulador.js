// visitas de mentira pra demo e pra testar a interface sem o hardware ligado
const ESPECIES = require("./especies");

function sortear(lista, pesoDe) {
  const total = lista.reduce((s, x) => s + pesoDe(x), 0);
  let r = Math.random() * total;
  for (const x of lista) {
    r -= pesoDe(x);
    if (r <= 0) return x;
  }
  return lista[lista.length - 1];
}

function entre(min, max) {
  return min + Math.random() * (max - min);
}

// espécie na hora de pico tem 3x mais chance
function sortearEspecie(hora) {
  return sortear(ESPECIES, e => e.freq * (e.horasPico.includes(hora) ? 3 : 1));
}

function temperaturaEm(hora) {
  // senoide: madrugada fria, meio da tarde quente
  const base = 17 + 9 * Math.sin(((hora - 9) / 24) * 2 * Math.PI + Math.PI / 2);
  return Math.round((base + entre(-1.5, 1.5)) * 10) / 10;
}

function gerarVisita(data) {
  const hora = data.getHours();
  const e = sortearEspecie(hora);
  return {
    id: `${data.getTime()}-${Math.floor(Math.random() * 1e6)}`,
    timestamp: data.toISOString(),
    especie: e.nome,
    cientifico: e.cientifico,
    emoji: e.emoji,
    confianca: Math.round(entre(0.62, 0.98) * 100) / 100,
    peso_g: Math.round(entre(e.pesoMin, e.pesoMax)),
    temperatura_c: temperaturaEm(hora),
    umidade_pct: Math.round(entre(45, 88)),
    foto: null,
    origem: "simulador"
  };
}

// horas repetidas pesam mais (manhã e fim de tarde)
const HORAS_ATIVAS = [5, 6, 6, 7, 7, 7, 8, 8, 8, 9, 9, 10, 10, 11, 12, 13, 14, 14, 15, 15, 16, 16, 16, 17, 17, 17, 18, 18, 19];

function gerarHistorico(quantidade, dias = 7) {
  const agora = Date.now();
  const visitas = [];
  for (let i = 0; i < quantidade; i++) {
    const d = new Date(agora - Math.random() * dias * 24 * 3600 * 1000);
    d.setHours(HORAS_ATIVAS[Math.floor(Math.random() * HORAS_ATIVAS.length)]);
    d.setMinutes(Math.floor(Math.random() * 60));
    visitas.push(gerarVisita(d));
  }
  return visitas.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

// uma visita a cada 20 a 45 s, devolve { parar }
function iniciar(aoGerar) {
  let ativo = true;
  let handle = null;
  function agendar() {
    handle = setTimeout(() => {
      if (!ativo) return;
      aoGerar(gerarVisita(new Date()));
      agendar();
    }, entre(20000, 45000));
  }
  agendar();
  return { parar() { ativo = false; clearTimeout(handle); } };
}

module.exports = { gerarVisita, gerarHistorico, iniciar };
