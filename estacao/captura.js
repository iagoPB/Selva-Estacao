// fotos pela webcam USB da estação (só Linux / TV box)
// ffmpeg, ou fswebcam se não tiver. acha a webcam pelo driver uvcvideo em /sys
// porque a TV box tem /dev/video que não são câmera. WEBCAM=/dev/video1 fixa, CAMERA=0 desliga
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const eventos = require("./eventos");

const TEMPO_LIMITE_MS = 25000;

function rodar(comando, args, tempo = TEMPO_LIMITE_MS) {
  return new Promise(resolve => {
    execFile(comando, args, { timeout: tempo }, (erro, stdout, stderr) => {
      resolve({ ok: !erro, erro, stderr: String(stderr || "") });
    });
  });
}

async function existe(comando) {
  const r = await rodar("sh", ["-c", `command -v ${comando}`], 5000);
  return r.ok;
}

function acharWebcam() {
  if (process.env.WEBCAM) return process.env.WEBCAM;
  const base = "/sys/class/video4linux";
  let nomes;
  try {
    nomes = fs.readdirSync(base).filter(n => n.startsWith("video"));
  } catch {
    return null;
  }
  // o nó de captura é o de menor número, o seguinte é só metadados
  nomes.sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  for (const nome of nomes) {
    try {
      const driver = fs.realpathSync(path.join(base, nome, "device", "driver"));
      if (driver.endsWith("uvcvideo")) return `/dev/${nome}`;
    } catch {}
  }
  return null;
}

async function capturarComFfmpeg(dispositivo, qtd, pasta) {
  const saida = path.join(pasta, "foto_%d.jpg");
  const comum = ["-hide_banner", "-loglevel", "error", "-f", "v4l2", "-video_size", "960x540"];
  // pula o 1º segundo (exposição ajustando) e tira 2,5 fotos/s, o bicho não espera mais que isso
  const resto = ["-i", dispositivo, "-ss", "1", "-vf", "fps=2.5", "-frames:v", String(qtd), "-q:v", "3", "-y", saida];
  let r = await rodar("ffmpeg", [...comum, "-input_format", "mjpeg", ...resto]);
  if (!r.ok) r = await rodar("ffmpeg", [...comum, ...resto]);   // câmera sem mjpeg
  return r;
}

async function capturarComFswebcam(dispositivo, qtd, pasta) {
  let ultimo = { ok: true };
  for (let i = 1; i <= qtd; i++) {
    const arquivo = path.join(pasta, `foto_${i}.jpg`);
    // primeira pula mais quadros pra exposição acertar
    const pular = i === 1 ? "20" : "3";
    ultimo = await rodar("fswebcam", ["-d", dispositivo, "-r", "960x540", "--skip", pular, "--no-banner", "-q", arquivo]);
    if (!ultimo.ok) return ultimo;
  }
  return ultimo;
}

// frase pra aba Registro, o código vai em dados.erro
const FRASE = {
  camera_desligada: "câmera desligada por CAMERA=0",
  sem_camera: "a estação não achou a webcam USB",
  sem_programa: "falta instalar o ffmpeg (ou o fswebcam)",
  captura_falhou: "a câmera não devolveu nenhuma foto"
};

// devolve { ok, fotos: [Buffer] } ou { erro, detalhe, frase }
// disparo é só pra marcar os eventos do registro
async function capturar(qtd = 3, disparo = null) {
  const inicio = Date.now();
  const r = await tirarFotos(qtd);
  const ms = Date.now() - inicio;
  if (r.ok) {
    eventos.registrar("camera", `Câmera: ${r.fotos.length} foto${r.fotos.length === 1 ? "" : "s"} (${r.dispositivo})`,
      { disparo, ms, fotos: r.fotos.length, etapa: "camera" });
  } else {
    r.frase = r.frase || FRASE[r.erro] || "câmera indisponível";
    // tira o "câmera" do começo da frase, o prefixo já diz
    eventos.registrar("erro", `Câmera: ${r.frase.replace(/^câmera /, "")}`, { disparo, ms, etapa: "camera", erro: r.erro, detalhe: r.detalhe || null });
  }
  return r;
}

async function tirarFotos(qtd) {
  if (process.env.CAMERA === "0") return { erro: "camera_desligada" };
  if (process.platform !== "linux") return { erro: "sem_camera", frase: "a câmera só funciona na estação Linux" };

  const dispositivo = acharWebcam();
  if (!dispositivo) return { erro: "sem_camera", detalhe: "nenhuma webcam USB (uvcvideo) encontrada" };

  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), "selva-cap-"));
  try {
    let r;
    if (await existe("ffmpeg")) r = await capturarComFfmpeg(dispositivo, qtd, pasta);
    else if (await existe("fswebcam")) r = await capturarComFswebcam(dispositivo, qtd, pasta);
    else return { erro: "sem_programa", detalhe: "instale ffmpeg ou fswebcam" };

    const arquivos = fs.readdirSync(pasta).filter(n => n.endsWith(".jpg")).sort();
    const fotos = arquivos.map(n => fs.readFileSync(path.join(pasta, n))).filter(b => b.length > 0);
    if (!fotos.length) {
      return { erro: "captura_falhou", detalhe: (r.stderr || (r.erro && r.erro.message) || "").slice(0, 300) };
    }
    return { ok: true, fotos, dispositivo };
  } finally {
    fs.rmSync(pasta, { recursive: true, force: true });
  }
}

module.exports = { capturar, acharWebcam };
