// registro do que a estação fez, em pt-BR, pra aba Registro
// registrar(tipo, texto, dados) guarda em memória (últimos 400), appenda em
// dados/eventos.jsonl e avisa quem se inscreveu com aoRegistrar (o servidor manda pelo WS).
// dados.disparo agrupa os passos de um mesmo disparo na interface
const fs = require("fs");
const path = require("path");
const armazenamento = require("./armazenamento");

const ARQUIVO = path.join(armazenamento.PASTA, "eventos.jsonl");
const MAXIMO = 400;
// acima disso reescreve o arquivo na subida (uns 2 x 400 linhas)
const LIMITE_ARQUIVO = 200 * 1024;
const TIPOS = ["disparo", "camera", "ia", "balanca", "catalogo", "visita", "descarte", "push", "serial", "erro", "sistema"];

let lista = null;
const ouvintes = [];
let contador = 0;
let appends = 0;

function carregar() {
  if (lista) return lista;
  lista = [];
  let tamanho = 0;
  try {
    const texto = fs.readFileSync(ARQUIVO, "utf8");
    tamanho = texto.length;
    const linhas = texto.split("\n").filter(Boolean).slice(-MAXIMO);
    for (const l of linhas) {
      try { lista.push(JSON.parse(l)); } catch {}
    }
  } catch {}
  if (tamanho > LIMITE_ARQUIVO) compactar();
  return lista;
}

// de tempos em tempos o arquivo volta a ter só o que está em memória,
// senão cresce meio MB por dia na TV box
function compactar() {
  appends = 0;
  try {
    armazenamento.gravarSeguro(ARQUIVO, lista.map(e => JSON.stringify(e)).join("\n") + "\n");
  } catch {}
}

function registrar(tipo, texto, dados = {}) {
  carregar();
  if (!TIPOS.includes(tipo)) tipo = "sistema";
  const evento = { t: new Date().toISOString(), tipo, texto: String(texto), dados };
  lista.push(evento);
  if (lista.length > MAXIMO) lista.splice(0, lista.length - MAXIMO);
  try {
    fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
    fs.appendFileSync(ARQUIVO, JSON.stringify(evento) + "\n");
    appends += 1;
    if (appends >= MAXIMO) compactar();
  } catch {}
  for (const fn of ouvintes) {
    try { fn(evento); } catch {}
  }
  return evento;
}

// do mais novo pro mais antigo
function ultimos(n = 200) {
  carregar();
  if (!(n > 0)) return [];
  return lista.slice(-n).reverse();
}

function aoRegistrar(fn) {
  ouvintes.push(fn);
  return () => {
    const i = ouvintes.indexOf(fn);
    if (i >= 0) ouvintes.splice(i, 1);
  };
}

// número pros disparos sem Arduino (teste do Laboratório, estação virtual)
function novoDisparo() {
  contador += 1;
  return `local-${contador}`;
}

// "2,8 s", "0,4 s", "1 min 12 s"
function seg(ms) {
  const s = Math.max(0, ms) / 1000;
  if (s >= 60) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  return `${s.toFixed(1).replace(".", ",")} s`;
}

// "71 g", "1,2 kg"
function gramas(g) {
  if (g == null) return "sem peso";
  const n = Number(g);
  const texto = n >= 1000 ? `${(n / 1000).toFixed(1)} kg` : `${Math.round(n * 10) / 10} g`;
  return texto.replace(".", ",");
}

module.exports = { registrar, ultimos, aoRegistrar, novoDisparo, seg, gramas, TIPOS, MAXIMO, ARQUIVO };
