// escuta o Arduino e manda cada disparo pro gatilho.js
// linhas do firmware (selva_estacao_fase1.ino):
//   G;<millis>;<n>;<peso_g|na|pend>;<temp_c|erro>;<umid_pct|erro>;<motivo>
//   P;<n>;<peso|na>   peso estável de um G que veio com "pend"
//   V;...             firmware antigo, sem motivo, vale como pir
//   S; status e D; diagnóstico só vão pro console
// porta: acha sozinho pelo CH340, ou PORTA_SERIAL=COM5 / /dev/ttyUSB0. SERIAL=0 desliga
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");
const eventos = require("./eventos");

const BAUD = 9600;
const RETENTAR_MS = 5000;

// S;<codigo>;... do firmware em texto de gente
const STATUS = {
  pronta: "Arduino pronto",
  balanca_zerada: "balança zerada",
  balanca_rezerada: "balança re-zerada",
  balanca_calibrada: "balança calibrada",
  balanca_desligada: "balança desligada",
  calibracao_invalida: "calibração da balança inválida",
  erro_sd: "erro no cartão SD",
  sem_sd: "sem cartão SD",
  arquivo_nao_encontrado: "arquivo não encontrado no SD"
};

function textoStatus(linha) {
  const partes = linha.split(";").slice(1);
  const nome = STATUS[partes[0]] || partes[0];
  const resto = partes.slice(1).map(p => p.replace("=", " ").replace(/_/g, " ")).join(", ");
  return `Serial: ${nome}${resto ? ` (${resto})` : ""}`;
}

async function acharPorta() {
  if (process.env.PORTA_SERIAL) return process.env.PORTA_SERIAL;
  const portas = await SerialPort.list();
  const arduino = portas.find(p => {
    const texto = `${p.manufacturer || ""} ${p.friendlyName || ""} ${p.vendorId || ""}`.toLowerCase();
    return texto.includes("ch340") || texto.includes("wch") || texto.includes("1a86") || texto.includes("arduino");
  });
  return arduino ? arduino.path : null;
}

function num(campo) {
  const n = Number(campo);
  return Number.isFinite(n) ? n : null;
}

const MOTIVOS = ["pir", "peso", "pir+peso"];

// G ou V -> leitura dos sensores na hora do disparo
function interpretarLinha(linha) {
  const partes = linha.trim().split(";");
  const tipo = partes[0];
  if ((tipo !== "G" && tipo !== "V") || partes.length < 6) return null;
  const motivo = tipo === "G" && MOTIVOS.includes(partes[6]) ? partes[6] : "pir";
  const pendente = partes[3] === "pend";
  return {
    peso_g: partes[3] === "na" || pendente ? null : num(partes[3]),
    pesoPendente: pendente,
    temperatura_c: partes[4] === "erro" ? null : num(partes[4]),
    umidade_pct: partes[5] === "erro" ? null : num(partes[5]),
    motivo,
    origem: "estacao",
    arduino_millis: num(partes[1]),
    arduino_n: num(partes[2])
  };
}

function interpretarPeso(linha) {
  const partes = linha.trim().split(";");
  if (partes[0] !== "P" || partes.length < 3) return null;
  const n = num(partes[1]);
  if (n == null) return null;
  return { n, peso_g: partes[2] === "na" ? null : num(partes[2]) };
}

function iniciar(aoDisparar, aoPeso = () => {}) {
  if (process.env.SERIAL === "0") {
    console.log("[serial] desligado por SERIAL=0");
    eventos.registrar("serial", "Serial: leitor desligado por SERIAL=0");
    return;
  }

  let avisouAusencia = false;
  const horaDisparo = new Map();   // n -> quando o G chegou, pra cronometrar a balança

  async function conectar() {
    let caminho = null;
    try {
      caminho = await acharPorta();
    } catch (e) {
      console.log(`[serial] erro ao listar portas: ${e.message}`);
      eventos.registrar("erro", `Serial: erro ao listar portas (${e.message})`);
    }
    if (!caminho) {
      if (!avisouAusencia) {
        console.log("[serial] nenhum Arduino encontrado; vou ficar tentando (pluga que eu acho)");
        eventos.registrar("serial", "Serial: nenhum Arduino encontrado, tentando de novo a cada 5 s");
        avisouAusencia = true;
      }
      setTimeout(conectar, RETENTAR_MS);
      return;
    }

    const porta = new SerialPort({ path: caminho, baudRate: BAUD }, erro => {
      if (erro) {
        console.log(`[serial] falha ao abrir ${caminho}: ${erro.message} (Monitor Serial da IDE aberto?)`);
        eventos.registrar("erro", `Serial: falha ao abrir ${caminho} (${erro.message})`);
        setTimeout(conectar, RETENTAR_MS);
      }
    });

    porta.on("open", () => {
      avisouAusencia = false;
      console.log(`[serial] Arduino conectado em ${caminho} (${BAUD} baud)`);
      eventos.registrar("serial", `Serial: Arduino conectado em ${caminho}`);
    });

    const linhas = porta.pipe(new ReadlineParser({ delimiter: "\n" }));
    linhas.on("data", bruto => {
      const linha = String(bruto).trim();
      if (!linha) return;
      if (linha.startsWith("G;") || linha.startsWith("V;")) {
        const sensores = interpretarLinha(linha);
        if (sensores) {
          console.log(`[serial] disparo (${sensores.motivo}): peso=${sensores.peso_g ?? "na"} temp=${sensores.temperatura_c ?? "?"}`);
          if (sensores.arduino_n != null) horaDisparo.set(sensores.arduino_n, Date.now());
          if (horaDisparo.size > 50) horaDisparo.delete(horaDisparo.keys().next().value);
          Promise.resolve(aoDisparar(sensores)).catch(e => {
            console.log(`[serial] erro no disparo: ${e.message}`);
            eventos.registrar("erro", `Disparo estourou uma exceção (${e.message})`, { disparo: sensores.arduino_n ?? null });
          });
        } else {
          eventos.registrar("erro", `Serial: linha de disparo que não entendi: ${linha.slice(0, 60)}`);
        }
      } else if (linha.startsWith("P;")) {
        const p = interpretarPeso(linha);
        if (p) {
          console.log(`[serial] peso do disparo ${p.n}: ${p.peso_g ?? "na"}`);
          // tempo desde o G vai em dados.ms (coluna da aba Registro)
          const desde = horaDisparo.has(p.n) ? Date.now() - horaDisparo.get(p.n) : null;
          eventos.registrar("balanca", p.peso_g == null
            ? "Balança: nada pesado (vazia ou o bicho saiu antes)"
            : `Balança: ${eventos.gramas(p.peso_g)}`, { disparo: p.n, ms: desde, peso_g: p.peso_g, etapa: "balanca" });
          aoPeso(p.n, p.peso_g);
        }
      } else if (linha.startsWith("S;")) {
        console.log(`[serial] ${linha}`);
        eventos.registrar("serial", textoStatus(linha));
      } else if (linha.startsWith("D;")) {
        console.log(`[serial] ${linha}`);
      }
    });

    porta.on("close", () => {
      console.log("[serial] conexão caiu; tentando reconectar...");
      eventos.registrar("erro", "Serial: conexão com o Arduino caiu, tentando reconectar");
      setTimeout(conectar, RETENTAR_MS);
    });
    porta.on("error", e => {
      console.log(`[serial] erro: ${e.message}`);
      eventos.registrar("erro", `Serial: ${e.message}`);
    });
  }

  conectar();
}

module.exports = { iniciar, interpretarLinha, interpretarPeso, textoStatus };
