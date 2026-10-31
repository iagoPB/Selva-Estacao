# manda o código deste PC pra TV box e reinicia o serviço
# uso (na pasta dev\selva):  .\implantar.ps1                  (192.168.0.19)
#                            .implantar.ps1 -Caixa 10.172.17.229 (ip da caixa no hotspot)
# precisa da chave ssh em ~\.ssh\selva_box. estacao/dados não vai junto
param([string]$Caixa = "192.168.0.19")

# o PS5 trata qualquer aviso do scp/ssh no stderr como erro, então a gente
# só olha o código de saída em cada passo
$ErrorActionPreference = "Continue"
$chave = "$env:USERPROFILE\.ssh\selva_box"
$opcoes = @("-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=NUL", "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=10", "-i", $chave)

function Conferir($passo) {
  if ($LASTEXITCODE -ne 0) { Write-Output "falhou em: $passo (codigo $LASTEXITCODE)"; exit 1 }
}
$pacote = Join-Path $env:TEMP "selva-atualizacao.tgz"

Write-Output "1/3 empacotando o código..."
Push-Location (Split-Path $PSScriptRoot -Parent)
tar -czf $pacote --exclude=node_modules --exclude=dados --exclude=testes --exclude=mockups selva/estacao selva/app/ui
Pop-Location
Conferir "empacotar"

Write-Output "2/3 enviando para $Caixa..."
scp @opcoes $pacote "bemtevi@${Caixa}:/home/bemtevi/selva-atualizacao.tgz"
Conferir "enviar (a caixa esta ligada e na rede?)"

Write-Output "3/3 instalando e reiniciando a estação..."
# vai em base64 pra não brigar com aspas entre o PowerShell e o bash
$remoto = @'
set -e
cd ~ && tar -xzf selva-atualizacao.tgz && rm selva-atualizacao.tgz
cd ~/selva/estacao
npm install --omit=dev --no-fund --no-audit --loglevel=error
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "instalando ffmpeg (so na primeira vez)..."
  sudo apt-get install -y ffmpeg >/tmp/ffmpeg_apt.log 2>&1
fi
sudo systemctl restart selva
sleep 4
echo "servico: $(systemctl is-active selva)"
curl -s -o /dev/null -w "API: HTTP %{http_code}\n" http://localhost:3000/api/resumo
echo "webcam: $(node -e "console.log(require('./captura').acharWebcam() || 'nao encontrada')")"
'@
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoto))
ssh @opcoes "bemtevi@$Caixa" "echo $b64 | base64 -d | bash"
Conferir "instalar na caixa"
Write-Output "pronto."
