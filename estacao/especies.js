// espécies comuns em Salto/SP, usadas no simulador e como base do catálogo.
// freq = peso do sorteio, horasPico = horas em que mais visita, wiki = título do
// artigo na wikipédia pt (de onde vem a foto), curiosidades = o que a ficha mostra offline
module.exports = [
  {
    nome: "Bem-te-vi", cientifico: "Pitangus sulphuratus", emoji: "🐤", wiki: "Bem-te-vi",
    pesoMin: 52, pesoMax: 68, freq: 5, horasPico: [6, 7, 8, 9, 16, 17],
    curiosidades: [
      "O nome vem do próprio canto: o assobio de três notas soa como \"bem-te-vi!\", e é um dos primeiros sons da madrugada brasileira.",
      "É corajoso a ponto de enfrentar gaviões e até pousar em capivaras para catar carrapatos.",
      "Come de tudo: frutas, insetos e até peixinhos que pesca em voo rasante, coisa rara entre passarinhos.",
      "Na cultura popular, ouvir um bem-te-vi cantando perto de casa é sinal de visita chegando."
    ]
  },
  {
    nome: "Sabiá-laranjeira", cientifico: "Turdus rufiventris", emoji: "🐦", wiki: "Sabiá-laranjeira",
    pesoMin: 64, pesoMax: 82, freq: 4, horasPico: [6, 7, 17, 18],
    curiosidades: [
      "É a ave símbolo do Brasil por decreto federal desde 2002.",
      "É o sabiá da Canção do Exílio de Gonçalves Dias (\"as aves que aqui gorjeiam não gorjeiam como lá\").",
      "Canta com mais intensidade na madrugada e no crepúsculo, e cada macho tem variações próprias de melodia.",
      "Diz a tradição que o canto do sabiá no fim da tarde anuncia chuva."
    ]
  },
  {
    nome: "Sanhaçu-cinzento", cientifico: "Thraupis sayaca", emoji: "🐦", wiki: "Sanhaçu-cinzento",
    pesoMin: 30, pesoMax: 45, freq: 3, horasPico: [9, 10, 11, 15, 16],
    curiosidades: [
      "O nome vem do tupi sa'i wasu, algo como \"passarinho grande\".",
      "É o rei dos comedouros com fruta: mamão e banana madura são irresistíveis para ele.",
      "Quase sempre aparece em casal ou em pequenos bandos barulhentos, raramente sozinho.",
      "A cor cinza-azulada muda de tom conforme a luz, e ele parece azul vivo em dia de sol."
    ]
  },
  {
    nome: "Pardal", cientifico: "Passer domesticus", emoji: "🐦", wiki: "Pardal",
    pesoMin: 24, pesoMax: 32, freq: 4, horasPico: [7, 8, 12, 13, 16],
    curiosidades: [
      "Não é nativo do Brasil: foi trazido da Europa por volta de 1900 para comer insetos nas cidades.",
      "É uma das aves mais urbanas do planeta, vive praticamente onde o ser humano vive.",
      "Toma banho de poeira para se livrar de parasitas, um espetáculo comum em canteiros.",
      "O macho tem o \"babador\" preto no peito; quanto maior a mancha, mais dominante ele tende a ser."
    ]
  },
  {
    nome: "João-de-barro", cientifico: "Furnarius rufus", emoji: "🐦", wiki: "João-de-barro",
    pesoMin: 34, pesoMax: 58, freq: 2, horasPico: [8, 9, 15, 16],
    curiosidades: [
      "Constrói uma casa de barro de até 5 kg com a entrada virada contra o vento predominante.",
      "A lenda diz que o joão-de-barro não trabalha aos domingos, e por isso virou símbolo do trabalhador caprichoso.",
      "O casal constrói junto e costuma fazer uma casa nova a cada estação, as antigas viram lar de outras aves.",
      "Macho e fêmea cantam em dueto sincronizado, um responde o outro em ritmo."
    ]
  },
  {
    nome: "Periquitão-maracanã", cientifico: "Psittacara leucophthalmus", emoji: "🦜", wiki: "Periquitão-maracanã",
    pesoMin: 130, pesoMax: 170, freq: 1, horasPico: [6, 7, 17],
    curiosidades: [
      "Voa em bandos barulhentos que riscam o céu no início da manhã e no fim da tarde.",
      "Dorme em \"dormitórios\" coletivos que podem reunir dezenas ou centenas de indivíduos.",
      "Adaptou-se tão bem às cidades que hoje é mais fácil vê-lo em praças do que em mata fechada.",
      "É frequentemente confundido com papagaio, mas é menor e verde por inteiro, com anel branco ao redor do olho."
    ]
  },
  {
    nome: "Gato-doméstico", cientifico: "Felis catus", emoji: "🐈", wiki: "Gato",
    pesoMin: 3200, pesoMax: 5200, freq: 1, horasPico: [5, 19, 20],
    curiosidades: [
      "É o maior predador de aves em áreas urbanas do mundo, e a razão de a estação registrar visitas indesejadas.",
      "A balança oculta denuncia o gato na hora: nenhum passarinho da região pesa 4 quilos.",
      "O mito das sete vidas vem da capacidade felina de sobreviver a quedas girando o corpo no ar.",
      "O ronronar vibra em frequências (~25 Hz) que estudos associam a autocura óssea e relaxamento."
    ]
  }
];
