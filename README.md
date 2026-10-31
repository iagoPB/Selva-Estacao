# selva! Estação

Projeto do IFCiência (IFSP Salto). Um comedouro com Arduino, balança e webcam
que percebe quando um bicho pousa, tira foto, pergunta pra IA que espécie é e
registra a visita num app. A ideia veio do selva!, um app de guia de fauna
que a gente fez em IHC, e aqui ele ganhou um "corpo" físico.

Grupo: Iago Pereira de Barros, João Pedro Ribeiro e Gabriel Marinho Siqueira.
Orientadora: Scheila Guedes Garcez.

## Como funciona

Dentro da caixa tem um Arduino Uno com sensor de presença (PIR), DHT22, uma
célula de carga com HX711 e um módulo microSD. Quando o PIR dispara ou o peso
na balança sobe, o Arduino manda uma linha pela serial e grava no cartão.

Quem recebe é uma TV box velha com Linux (Armbian), que faz o trabalho pesado:
tira 3 fotos na webcam, manda pro Gemini, e se tiver animal guarda a melhor
foto, resolve o peso e registra a visita. Espécie que nunca apareceu é
catalogada na hora (foto e texto da Wikipédia ou iNaturalist, curiosidades
pela IA). Sem animal nas fotos (gente passando, folha, vento) o disparo é
descartado e só conta na estatística de alarme falso.

A TV box também serve o app. É a mesma página pra tudo: navegador do PC,
celular, TV, e o exe do Windows (Electron) que só abre essa página numa janela.

**Tudo funciona na mesma rede.** Na feira a gente ligou a TV box e o notebook
no hotspot do celular e pronto. Não tem acesso de fora.

## Hardware

Arduino Uno + sensor shield, PIR HC-SR501, DHT22, célula de carga 5 kg + HX711,
módulo microSD, webcam USB, TV box (Amlogic S905X3, 2 GB) com Armbian.

| Peça | Pino do Arduino |
|---|---|
| PIR OUT | D2 |
| DHT22 DATA | D4 |
| HX711 DT / SCK | D5 / D6 |
| SD CS | D10 |
| SD MOSI / MISO / SCK | D11 / D12 / D13 |

Manual de montagem, gabarito de furação da caixa e montagem da balança estão
em `docs/`.

Uma coisa que a gente aprendeu do jeito difícil: a fonte da TV box não aguenta
webcam + Arduino direito. Plugar a webcam com a caixa ligada reinicia ela. Liga
tudo antes de pôr na tomada.

## Rodar no PC (sem hardware)

```bash
cd estacao
npm install
npm start
```

Abre http://localhost:3000. Sem Arduino na USB o simulador de visitas fica
ligado, então o feed já nasce cheio. Chave do Gemini é grátis
(https://aistudio.google.com/apikey) e pode ser colada na aba Laboratório.

Testes do fluxo (câmera e IA falsas):

```bash
cd estacao
node testes/testar.js
```

## Exe do Windows

```bash
cd app
npm install
npm run dist
```

Sai em `app/dist/selva-0.1.0.exe`, portátil. Ao abrir ele varre a rede local
procurando a estação (porta 3000) e carrega a interface direto dela. Se não
achar nada, pergunta se quer procurar de novo ou entrar no modo demonstração
(sobe uma estação embutida com simulador).

Pra ter a aba Laboratório e o Registro (coisas de admin) coloca um
`selva.config.json` do lado do exe:

```json
{ "token": "conteudo do arquivo estacao/dados/admin-token da caixa" }
```

Quem entra sem token (visitante no hotspot) só vê o painel e o guia. Qualquer
POST sem token recebe 403.

## TV box

Armbian com Node 18, ffmpeg e avrdude. O serviço `selva` (systemd) sobe no boot
e roda `estacao/servidor.js`. Pra mandar código novo do PC:

```powershell
.\implantar.ps1 -Caixa 10.172.17.229
```

Empacota `estacao/` e `app/ui/`, manda por scp, roda `npm install` e reinicia o
serviço. Precisa de chave SSH em `~\.ssh\selva_box`. A pasta `dados/` da caixa
não é tocada. O IP muda conforme o hotspot, o console do serviço mostra qual é.

Regravar o firmware sem tirar o Arduino da caixa:

```bash
# no PC
arduino-cli compile --fqbn arduino:avr:uno --output-dir build firmware/selva_estacao_fase1
# na caixa, depois de copiar o .hex
sudo systemctl stop selva
avrdude -c arduino -p atmega328p -P /dev/ttyUSB0 -b 115200 -D -U flash:w:firmware.hex:i
sudo systemctl start selva
```

## Protocolo serial

9600 baud, uma linha por mensagem, campos com `;`.

```
G;millis;n;pend|na;temp_c;umid_pct;motivo    na hora do disparo (motivo: pir, peso, pir+peso)
P;n;peso_g|na                                 até 5 s depois, peso estável
S;pronta;sd=ok;balanca=ok                     ao ligar, e outros avisos S;...
```

`pend` quer dizer que a balança ainda está medindo. A estação espera o `P`
por até uns segundos sem segurar a câmera. No SD vai só a linha `G` com o peso
final. O Arduino não tem relógio, então o tempo é `millis` e a caixa põe a
hora.

Comandos no Monitor Serial (com "Nova linha"): `L` lista o cartão, `T` zera a
balança, `R` mostra leitura crua, `C188` calibra com 188 g em cima (o fator
fica na EEPROM).

Sobre a balança:

- ao ligar ela zera com o que estiver em cima, então liga com a plataforma
  vazia. Se zerar errado, 60 s parado vira o novo zero
- disparo por peso só rearma depois que a plataforma esvazia
- HX711 mudo ou saturado desliga a balança sozinha e a estação segue só no PIR
- o Monitor Serial da IDE tem que estar fechado quando a estação roda

## Peso que aparece no feed

Balança, se o valor for razoável pra espécie (entre 0,3x e 3x o peso de
referência). Se for surreal (só a pata do gato na balança, mão segurando),
entra a referência como estimativa e o que a balança leu fica anotado.
Sem medida, média do que a estação já pesou daquela espécie, senão a
referência. Estimado aparece com "~".

## Variáveis de ambiente

Servidor:

| Variável | Pra quê |
|---|---|
| `PORTA` | porta HTTP (3000) |
| `SIMULAR=0` | desliga o simulador |
| `SERIAL=0` | desliga o leitor serial |
| `PORTA_SERIAL=COM5` | fixa a porta do Arduino |
| `CAMERA=0` | desliga a câmera |
| `WEBCAM=/dev/videoN` | fixa a webcam |
| `GEMINI_API_KEY` | chave do Gemini (ganha da salva em config.json) |
| `ADMIN_REDE_LOCAL=1` | deixa toda a rede local ser admin (uso em casa) |
| `SELVA_DADOS` | pasta de dados em outro lugar |

App: `ESTACAO=http://ip:3000` força o endereço da estação.

## Pastas

```
firmware/selva_estacao_fase1/   sketch do Arduino
firmware/balanca_ao_vivo/       sketch de bancada pra ver a balança
estacao/                        serviço da TV box (Node)
  servidor.js                   API + WebSocket, serve o app
  serial-arduino.js             lê a serial e traduz G/P/S
  gatilho.js                    disparo: fotos -> IA -> visita
  captura.js                    webcam (ffmpeg)
  identificador.js              Gemini
  peso.js                       regra do peso
  catalogo.js / especies.js     espécies e fichas
  eventos.js                    registro do que a estação fez (aba Registro)
  estatisticas.js               contadores de disparo
  push.js                       notificações (só funciona em https/localhost)
  simulador.js                  visitas falsas pra desenvolver
  armazenamento.js              JSON em dados/
  testes/testar.js              testes
app/                            cliente Electron
  main.js                       acha a estação e abre a janela
  ui/                           a interface
docs/                           manuais em PDF
implantar.ps1                   manda o código pra caixa
```

## TODO

- SQLite no lugar dos JSON
- mais análises: curva de acumulação, Shannon, heatmap hora x dia, exportar CSV
- hub USB com fonte pra webcam e Arduino (a fonte da TV box é fraca)
