// contadores dos disparos. disparo = PIR ou balança acordou a câmera; vira
// visita se a IA achou bicho, "vazio" se não. vazios/total é a taxa de alarme falso
const fs = require("fs");
const path = require("path");
const armazenamento = require("./armazenamento");

const ARQUIVO = path.join(armazenamento.PASTA, "estatisticas.json");
let dados = null;

function carregar() {
  if (dados) return dados;
  try {
    dados = JSON.parse(fs.readFileSync(ARQUIVO, "utf8"));
  } catch {
    dados = {};
  }
  dados.disparos = dados.disparos || 0;
  dados.vazios = dados.vazios || 0;
  dados.confirmados = dados.confirmados || 0;
  dados.porMotivo = dados.porMotivo || {};
  return dados;
}

function registrarDisparo(motivo, resultado) {
  carregar();
  dados.disparos += 1;
  if (resultado === "vazio") dados.vazios += 1;
  if (resultado === "visita") dados.confirmados += 1;
  const m = dados.porMotivo[motivo] || { disparos: 0, vazios: 0 };
  m.disparos += 1;
  if (resultado === "vazio") m.vazios += 1;
  dados.porMotivo[motivo] = m;
  armazenamento.gravarSeguro(ARQUIVO, JSON.stringify(dados, null, 2));
}

function resumo() {
  return { ...carregar() };
}

module.exports = { registrarDisparo, resumo };
