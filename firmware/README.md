# Firmware da selva! Estação

Sketch em `selva_estacao_fase1/`. O Arduino não decide nada, só acorda a
câmera: PIR detectou presença ou a balança sentiu peso subindo, ele manda
`G;millis;n;pend|na;temp_c;umid_pct;motivo` pela serial e grava no SD. O peso
estável vem logo depois em `P;n;peso_g|na`. Pausa de 15 s entre disparos, LED
pisca 3x a cada um. O protocolo inteiro está no cabeçalho do `.ino` e no
README da raiz.

## Testar sem hardware (Wokwi)

1. https://wokwi.com -> New Project -> Arduino Uno
2. colar o `.ino` no editor
3. Library Manager: `DHT sensor library` e `HX711 Arduino Library`
4. adicionar as peças com o "+" e ligar conforme o mapa de pinos do topo do
   sketch: PIR (OUT->2), DHT22 (SDA->4), HX711 + célula (DT->5, SCK->6) e
   MicroSD (CS->10, MOSI->11, MISO->12, SCK->13). VCC no 5V, GND no GND
5. rodar. clicar no PIR simula presença, o peso se ajusta no HX711. As linhas
   `G;...` aparecem no Serial Monitor

## Gravar na placa real

1. IDE do Arduino, instalar as bibliotecas do cabeçalho pelo Gerenciador de
   Bibliotecas
2. upload com a plataforma da balança vazia (ela zera ao ligar)
3. LED pisca 2x se o SD montou, 5x se falhou (confere FAT32 e o pino CS)
4. calibrar pelo Monitor Serial com "Nova linha": `T` com a plataforma vazia,
   um peso conhecido em cima e `C<gramas>`. O fator fica na EEPROM, então não
   precisa mexer no código. `R` mostra leitura crua, zero e fator

Pra regravar com o Arduino já dentro da caixa (via TV box) tem o passo a passo
no README da raiz.
