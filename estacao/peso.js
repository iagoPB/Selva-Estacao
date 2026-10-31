// decide o peso da visita: balança, senão média do que a estação já pesou
// dessa espécie (3+ medições), senão referência (catálogo ou palpite da IA).
// medida fora de 0,3x a 3x da referência é surreal (pata só, mão junto) e
// cai pra referência, guardando o lido em peso_medido_g
const MIN_MEDICOES = 3;
const FAIXA = [0.3, 3];

function referenciaDaEspecie(especie, pesoTipicoIa) {
  if (especie) {
    if (especie.pesoMin != null && especie.pesoMax != null) {
      return Math.round((especie.pesoMin + especie.pesoMax) / 2);
    }
    if (especie.pesoMedio != null) return Math.round(especie.pesoMedio);
  }
  const ia = Number(pesoTipicoIa);
  return Number.isFinite(ia) && ia > 0 ? Math.round(ia) : null;
}

function mediaDaEstacao(visitas, nomeEspecie) {
  const medidos = visitas
    .filter(v => v.especie === nomeEspecie && v.peso_origem === "balanca" && v.peso_g != null && !v.peso_suspeito)
    .map(v => v.peso_g);
  if (medidos.length < MIN_MEDICOES) return null;
  return Math.round(medidos.reduce((a, b) => a + b, 0) / medidos.length);
}

function resolverPeso({ pesoMedido, especie, nomeEspecie, pesoTipicoIa, visitas = [] }) {
  const referencia = referenciaDaEspecie(especie, pesoTipicoIa);
  const medido = Number(pesoMedido);

  if (pesoMedido != null && Number.isFinite(medido) && medido > 0) {
    const lido = Math.round(medido * 10) / 10;
    const surreal = referencia != null &&
      (medido < referencia * FAIXA[0] || medido > referencia * FAIXA[1]);
    if (surreal) {
      return { peso_g: referencia, peso_origem: "referencia", peso_estimado: true, peso_suspeito: true, peso_medido_g: lido };
    }
    return { peso_g: lido, peso_origem: "balanca", peso_estimado: false, peso_suspeito: false, peso_medido_g: lido };
  }

  const media = mediaDaEstacao(visitas, nomeEspecie);
  if (media != null) return { peso_g: media, peso_origem: "media_estacao", peso_estimado: true, peso_suspeito: false };
  if (referencia != null) return { peso_g: referencia, peso_origem: "referencia", peso_estimado: true, peso_suspeito: false };
  return { peso_g: null, peso_origem: null, peso_estimado: false, peso_suspeito: false };
}

module.exports = { resolverPeso, referenciaDaEspecie, mediaDaEstacao };
