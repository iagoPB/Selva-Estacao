// visitas em arquivo JSON. TODO: trocar por sqlite se crescer muito
const fs = require("fs");
const path = require("path");

// SELVA_DADOS aponta pra outra pasta (o app empacotado usa a pasta do
// usuário, a do programa não é gravável)
const PASTA = process.env.SELVA_DADOS || path.join(__dirname, "dados");
const ARQUIVO = path.join(PASTA, "visitas.json");

let visitas = null;

function carregar() {
  if (visitas) return visitas;
  try {
    visitas = JSON.parse(fs.readFileSync(ARQUIVO, "utf8"));
  } catch {
    visitas = [];
  }
  return visitas;
}

// escreve num .tmp, fsync e rename por cima. a TV box é desligada puxando
// da tomada e o Armbian segura as gravações, sem isso o json ficava pela metade
function gravarSeguro(arquivo, texto) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const tmp = arquivo + ".tmp";
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, texto);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, arquivo);
}

function salvar() {
  gravarSeguro(ARQUIVO, JSON.stringify(visitas, null, 2));
}

function adicionar(visita) {
  carregar();
  visitas.push(visita);
  salvar();
  return visita;
}

function todas() {
  return [...carregar()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

// mexe em campos de uma visita já gravada (emoji e científico quando a
// espécie termina de catalogar). devolve a visita ou null
function atualizar(id, campos) {
  const v = carregar().find(x => x.id === id);
  if (!v) return null;
  Object.assign(v, campos);
  salvar();
  return v;
}

module.exports = { carregar, adicionar, atualizar, todas, PASTA, gravarSeguro };
