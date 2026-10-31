/*
  selva! Estação - firmware do Arduino Uno

  O Arduino só acorda a câmera: PIR detectou presença ou a balança sentiu um
  peso subindo, ele manda um disparo pela serial. Quem decide se foi bicho de
  verdade é a TV box (fotos + IA).

  Pinos (mesmo mapa da seção 11 do manual):
    PIR OUT  -> D2      HX711 DT  -> D5      SD CS   -> D10
    DHT22    -> D4      HX711 SCK -> D6      SD MOSI -> D11
                                             SD MISO -> D12
                                             SD SCK  -> D13

  Bibliotecas (Gerenciador de Bibliotecas da IDE):
    DHT sensor library (Adafruit) + Adafruit Unified Sensor
    HX711 Arduino Library (bogde)
    SD (já vem na IDE)

  Protocolo serial (9600):
    G;<millis>;<n>;<pend|na>;<temp_c|erro>;<umid_pct|erro>;<motivo>   sai na hora do disparo
    P;<n>;<peso_g|na>                                                  peso estável, até ~5 s depois
    S;<codigo>;...   status (pronta, balanca_rezerada, erro_sd...)
    D;...            diagnóstico do comando R
    motivo = pir, peso ou pir+peso. pend = balança ainda medindo.
  No SD vai só a linha G, já com o peso final. Não tem relógio, o tempo é o
  millis() desde que ligou; a TV box põe a hora certa.

  Comandos pelo Monitor Serial (com "Nova linha"):
    L      lista o cartão
    T      zera a balança
    R      leitura crua, zero e fator
    C188   calibra com um peso conhecido em cima (188 g no exemplo). fica na EEPROM

  Ao ligar a balança zera com o que estiver em cima, então liga com a plataforma
  vazia. Se zerar errado, 60 s de peso parado corrigem sozinho.
*/

#include <DHT.h>
#include "HX711.h"
#include <SPI.h>
#include <SD.h>
#include <EEPROM.h>

// pinos
const int PINO_PIR    = 2;
const int PINO_DHT    = 4;
const int PINO_HX_DT  = 5;
const int PINO_HX_SCK = 6;
const int PINO_SD_CS  = 10;

// ajustes
// false tira a balança; com true ela ainda se desliga sozinha se o HX711
// não responder ou saturar, e a estação segue só com o PIR
const bool USAR_BALANCA = true;

// fator de fábrica, só vale se nunca calibrou com o comando C.
// célula nova medida em 10/10 com o POCO X7 (188 g): vazia -322130, com o
// celular -364718 -> -226,5 pontos/g (negativo = fio invertido). a antiga era -452
const float FATOR_PADRAO = -226.5f;
const float LIMIAR_PESO_G = 8.0f;           // subida que conta como pouso
const float PESO_MINIMO_G = 5.0f;           // abaixo disso reporta "na"
const float TOLERANCIA_ESTAVEL_G = 2.0f;    // variação máxima de um peso "parado"
const unsigned long DESCANSO_MS = 15000;    // pausa entre disparos
const unsigned long CONFIRMACAO_MS = 300;   // o PIR tem que ficar alto esse tempo
const unsigned long AQUECIMENTO_MS = 30000; // o PIR dispara à toa logo que liga
const unsigned long REZERO_MS = 60000;      // degrau parado esse tempo vira o novo zero
const long LIMITE_SATURACAO = 8388600;      // perto do teto dos 24 bits
const char* ARQUIVO_LOG = "gatilhos.csv";

DHT dht(PINO_DHT, DHT22);
HX711 balanca;

float fator = FATOR_PADRAO;
bool balancaOk = false;
bool sdOk = false;
float pesoSuave = 0;      // leitura filtrada, em gramas
float base = 0;           // zero que acompanha a deriva lenta da célula
int amostrasAcima = 0;
int amostrasAbaixo = 0;   // leituras paradas abaixo do zero (zero errado)
bool emDegrau = false;
bool pesoArmado = true;   // só dispara de novo por peso depois que a plataforma esvazia
float ultimaLeitura = 0;  // última leitura do medirPeso, relativa à base
unsigned long ultimaAmostra = 0;
unsigned long inicioEstavel = 0;
unsigned long ultimoDisparo = 0;
unsigned long numeroDisparo = 0;

bool saturado(long raw) {
  return raw >= LIMITE_SATURACAO || raw <= -LIMITE_SATURACAO;
}

void desligarBalanca(const __FlashStringHelper* motivo) {
  balancaOk = false;
  Serial.print(F("S;balanca_desligada;"));
  Serial.println(motivo);
}

// na EEPROM fica "SLV" + versão + o fator (float). sem a marca, usa o padrão
void carregarFator() {
  if (EEPROM.read(0) != 'S' || EEPROM.read(1) != 'L' || EEPROM.read(2) != 'V' || EEPROM.read(3) != 1) return;
  float f;
  EEPROM.get(4, f);
  if (isfinite(f) && fabs(f) >= 1) fator = f;
}

void salvarFator(float f) {
  EEPROM.update(0, 'S');
  EEPROM.update(1, 'L');
  EEPROM.update(2, 'V');
  EEPROM.update(3, 1);
  EEPROM.put(4, f);
}

float gramas(long raw) {
  return (raw - balanca.get_offset()) / fator;
}

// chamar antes de tare/read_average: se o HX711 sumiu, desliga a balança
// em vez de travar o loop esperando
bool balancaPronta() {
  if (!balancaOk) return false;
  if (balanca.wait_ready_timeout(500)) return true;
  desligarBalanca(F("nao_responde"));
  return false;
}

void iniciarBalanca() {
  if (!USAR_BALANCA) return;
  carregarFator();
  balanca.begin(PINO_HX_DT, PINO_HX_SCK);
  if (!balanca.wait_ready_timeout(2000)) {
    desligarBalanca(F("nao_responde"));
    return;
  }
  balanca.set_scale(fator);
  balanca.tare(10);
  balancaOk = true;
  if (saturado(balanca.read())) desligarBalanca(F("saturada"));
}

// C<gramas>: peso conhecido em cima da plataforma já zerada,
// fator = (raw - zero) / gramas
void calibrar(float conhecido) {
  if (!balancaPronta() || conhecido < 1) {
    Serial.println(F("S;calibracao_invalida"));
    return;
  }
  long raw = balanca.read_average(15);
  float f = (raw - balanca.get_offset()) / conhecido;
  if (fabs(f) < 1) {
    Serial.println(F("S;calibracao_invalida;leitura_nao_mudou"));
    return;
  }
  fator = f;
  balanca.set_scale(fator);
  salvarFator(fator);
  Serial.print(F("S;balanca_calibrada;fator="));
  Serial.print(fator, 1);
  Serial.print(F(";lido_g="));
  Serial.println(gramas(raw), 1);
}

void mostrarBalanca() {
  if (!balancaPronta()) {
    Serial.println(F("D;balanca=off"));
    return;
  }
  long raw = balanca.read_average(10);
  Serial.print(F("D;raw="));
  Serial.print(raw);
  Serial.print(F(";zero="));
  Serial.print(balanca.get_offset());
  Serial.print(F(";fator="));
  Serial.print(fator, 1);
  Serial.print(F(";g="));
  Serial.print(gramas(raw), 1);
  Serial.print(F(";base="));
  Serial.println(base, 1);
}

void setup() {
  Serial.begin(9600);
  pinMode(PINO_PIR, INPUT);
  pinMode(LED_BUILTIN, OUTPUT);
  dht.begin();
  delay(1000);
  iniciarBalanca();

  sdOk = SD.begin(PINO_SD_CS);
  if (sdOk && !SD.exists(ARQUIVO_LOG)) {
    File arq = SD.open(ARQUIVO_LOG, FILE_WRITE);
    if (arq) {
      arq.println(F("evento;millis;n;peso_g;temp_c;umid_pct;motivo"));
      arq.close();
    }
  }

  Serial.print(F("S;pronta;sd="));
  Serial.print(sdOk ? F("ok") : F("falhou"));
  Serial.print(F(";balanca="));
  Serial.println(balancaOk ? F("ok") : F("off"));
  piscar(sdOk ? 2 : 5);
}

bool emVisita() {
  return ultimoDisparo != 0 && millis() - ultimoDisparo < DESCANSO_MS;
}

void rezerar(const __FlashStringHelper* aviso) {
  base = pesoSuave;
  pesoArmado = true;
  amostrasAcima = 0;
  amostrasAbaixo = 0;
  emDegrau = false;
  inicioEstavel = millis();
  Serial.println(aviso);
}

// lê uma amostra só se o HX711 já tiver uma pronta, pra não travar o loop
void atualizarBalanca() {
  if (!balancaOk) return;
  if (!balanca.is_ready()) {
    // 3 s mudo = fio solto ou módulo sem energia, segue só com o PIR
    if (ultimaAmostra != 0 && millis() - ultimaAmostra > 3000) desligarBalanca(F("nao_responde"));
    return;
  }
  ultimaAmostra = millis();
  long raw = balanca.read();
  if (saturado(raw)) {
    desligarBalanca(F("saturada"));
    return;
  }
  float g = gramas(raw);
  float anterior = pesoSuave;
  pesoSuave = pesoSuave * 0.6 + g * 0.4;
  bool semVariacao = fabs(pesoSuave - anterior) < 1.0;

  // "parado" = sem variação e fora de visita. o PIR não entra na conta porque
  // com gente em volta ele fica alto direto e o re-zero nunca aconteceria
  if (!semVariacao || emVisita()) inicioEstavel = millis();

  float delta = pesoSuave - base;
  bool degrau = fabs(delta) >= LIMIAR_PESO_G / 2;
  // o cronômetro do re-zero conta do começo do degrau
  if (degrau && !emDegrau) inicioEstavel = millis();
  emDegrau = degrau;
  if (delta <= -LIMIAR_PESO_G && semVariacao) amostrasAbaixo++;
  else amostrasAbaixo = 0;

  if (!degrau) {
    // plataforma vazia: zero acompanha a deriva e o disparo por peso rearma
    if (!emVisita()) base = base * 0.995 + pesoSuave * 0.005;
    pesoArmado = true;
  } else if (amostrasAbaixo >= 20) {
    // peso negativo = zerou com algo em cima e esse algo saiu. corrige em 2 s
    rezerar(F("S;balanca_rezerada;plataforma_esvaziou"));
    return;
  } else if (millis() - inicioEstavel > REZERO_MS) {
    // degrau parado há 1 min: objeto esquecido ou comida reposta
    rezerar(F("S;balanca_rezerada"));
    return;
  }

  if (delta >= LIMIAR_PESO_G) amostrasAcima++;
  else amostrasAcima = 0;
}

bool pesoSubiu() {
  return pesoArmado && amostrasAcima >= 2;
}

// espera o peso parar: lê por até ~5 s e devolve a média da primeira janela
// de 1 s (10 leituras) parada. se nunca parar (bicho se mexendo, mão
// segurando) vai a média dos 5 s menos o meio segundo inicial. -1 = sem peso
const int JANELA_PESO = 10;
const int MAX_AMOSTRAS_PESO = 50;
const int DESCARTE_INICIAL = 5;

float medirPeso() {
  if (!balancaOk) return -1;
  float janela[JANELA_PESO];
  int n = 0;
  float somaTudo = 0;
  int contaTudo = 0;
  for (int i = 0; i < MAX_AMOSTRAS_PESO; i++) {
    if (!balanca.wait_ready_timeout(200)) break;
    long raw = balanca.read();
    if (saturado(raw)) {
      desligarBalanca(F("saturada"));
      return -1;
    }
    ultimaLeitura = gramas(raw) - base;
    janela[n % JANELA_PESO] = ultimaLeitura;
    n++;
    if (n > DESCARTE_INICIAL) {
      somaTudo += ultimaLeitura;
      contaTudo++;
    }
    if (n < JANELA_PESO) continue;
    float menor = janela[0], maior = janela[0], soma = 0;
    for (int k = 0; k < JANELA_PESO; k++) {
      menor = min(menor, janela[k]);
      maior = max(maior, janela[k]);
      soma += janela[k];
    }
    float media = soma / JANELA_PESO;
    if (maior - menor < TOLERANCIA_ESTAVEL_G && media >= PESO_MINIMO_G) return media;
  }
  if (contaTudo == 0) return -1;
  float mediaTudo = somaTudo / contaTudo;
  return mediaTudo >= PESO_MINIMO_G ? mediaTudo : -1;
}

// o PIR tem que segurar o sinal um pouco, senão qualquer ruído dispara
bool presencaConfirmada() {
  if (digitalRead(PINO_PIR) != HIGH) return false;
  unsigned long inicio = millis();
  while (millis() - inicio < CONFIRMACAO_MS) {
    if (digitalRead(PINO_PIR) != HIGH) return false;
    delay(20);
  }
  return true;
}

void loop() {
  if (Serial.available()) {
    char c = Serial.read();
    if (c == 'L' || c == 'l') despejarArquivo();
    if (c == 'R' || c == 'r') mostrarBalanca();
    if (c == 'C' || c == 'c') calibrar(Serial.parseFloat());
    if ((c == 'T' || c == 't') && balancaPronta()) {
      balanca.tare(10);
      pesoSuave = 0;
      rezerar(F("S;balanca_zerada"));
    }
  }

  atualizarBalanca();

  bool aquecido = millis() > AQUECIMENTO_MS;
  if (aquecido && !emVisita()) {
    bool peso = pesoSubiu();
    bool pir = presencaConfirmada();
    if (pir || peso) {
      disparar(pir, peso);
      ultimoDisparo = millis();
      amostrasAcima = 0;
    }
  }
  delay(20);
}

String montarLinha(unsigned long quando, const String& peso, float temperatura, float umidade, const char* motivo) {
  String linha = "G;";
  linha += quando;
  linha += ';';
  linha += numeroDisparo;
  linha += ';';
  linha += peso;
  linha += ';';
  linha += isnan(temperatura) ? String("erro") : String(temperatura, 1);
  linha += ';';
  linha += isnan(umidade) ? String("erro") : String(umidade, 0);
  linha += ';';
  linha += motivo;
  return linha;
}

void disparar(bool pir, bool pesoDetectado) {
  numeroDisparo++;
  unsigned long quando = millis();
  const char* motivo = pir && pesoDetectado ? "pir+peso" : (pir ? "pir" : "peso");
  float temperatura = dht.readTemperature();
  float umidade = dht.readHumidity();

  // avisa a TV box já, a câmera não pode esperar o peso estabilizar
  bool pendente = balancaOk;
  Serial.println(montarLinha(quando, pendente ? String("pend") : String("na"), temperatura, umidade, motivo));

  float peso = medirPeso();
  String textoPeso = peso < 0 ? String("na") : String(peso, 1);
  if (pendente) {
    Serial.print(F("P;"));
    Serial.print(numeroDisparo);
    Serial.print(';');
    Serial.println(textoPeso);
  }
  // só rearma o disparo por peso quando a plataforma esvaziar, senão um
  // disparo do PIR com peso ainda instável vira visita dupla
  if (peso >= 0 || pesoDetectado || ultimaLeitura >= LIMIAR_PESO_G) pesoArmado = false;

  if (sdOk) {
    File arq = SD.open(ARQUIVO_LOG, FILE_WRITE);
    if (arq) {
      arq.println(montarLinha(quando, textoPeso, temperatura, umidade, motivo));
      arq.close();
    } else {
      sdOk = false;             // cartão saiu? avisa e segue
      Serial.println(F("S;erro_sd"));
    }
  }

  piscar(3);
}

void despejarArquivo() {
  if (!sdOk) {
    Serial.println(F("S;sem_sd"));
    return;
  }
  File arq = SD.open(ARQUIVO_LOG, FILE_READ);
  if (!arq) {
    Serial.println(F("S;arquivo_nao_encontrado"));
    return;
  }
  Serial.println(F("---inicio do gatilhos.csv---"));
  while (arq.available()) {
    Serial.write(arq.read());
  }
  arq.close();
  Serial.println(F("---fim---"));
}

void piscar(int vezes) {
  for (int i = 0; i < vezes; i++) {
    digitalWrite(LED_BUILTIN, HIGH);
    delay(90);
    digitalWrite(LED_BUILTIN, LOW);
    delay(90);
  }
}
