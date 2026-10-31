// balança ao vivo: peso em gramas com uma barra que cresce ao apertar a célula
// t + Enter no monitor serial zera de novo. DT no D5, SCK no D6, VCC 5V, GND GND
#include "HX711.h"

// calibrado em 12/09 com POCO X7 (~188 g)
const float FATOR = -452.0f;
const float ESCALA_BARRA_G = 500.0f;   // barra cheia = 500 g
const int LARGURA_BARRA = 30;

HX711 balanca;

void setup() {
  Serial.begin(9600);
  balanca.begin(5, 6);
  Serial.println(F("=== BALANCA AO VIVO ==="));
  Serial.println(F("Deixe a barra livre, zerando..."));
  if (balanca.wait_ready_timeout(2000)) {
    balanca.set_scale(FATOR);
    delay(500);
    balanca.tare(10);
    Serial.println(F("Pronto. Aperte a barra de leve. Digite t + Enter para zerar de novo."));
  } else {
    Serial.println(F("HX711 NAO RESPONDE: confira o jumper do VCC e o DT no D5"));
  }
}

void loop() {
  if (Serial.available()) {
    char c = Serial.read();
    if (c == 't' || c == 'T') {
      balanca.tare(10);
      Serial.println(F("-- zerada --"));
    }
  }

  if (!balanca.wait_ready_timeout(1000)) {
    Serial.println(F("HX711 NAO RESPONDE: confira o jumper do VCC e o DT no D5"));
    delay(500);
    return;
  }

  long raw = balanca.read_average(5);
  if (raw >= 8388600 || raw <= -8388600) {
    Serial.print(F("SATURADO (raw="));
    Serial.print(raw);
    Serial.println(F("): a celula nao esta recebendo energia"));
    delay(300);
    return;
  }

  float gramas = (raw - balanca.get_offset()) / FATOR;
  int cheias = (int)(fabs(gramas) / ESCALA_BARRA_G * LARGURA_BARRA);
  if (cheias > LARGURA_BARRA) cheias = LARGURA_BARRA;

  Serial.print(F("peso: "));
  if (gramas >= 0) Serial.print(' ');
  Serial.print(gramas, 1);
  Serial.print(F(" g  |"));
  for (int i = 0; i < LARGURA_BARRA; i++) Serial.print(i < cheias ? '#' : ' ');
  Serial.println('|');
  delay(300);
}
