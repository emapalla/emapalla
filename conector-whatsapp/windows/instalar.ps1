# Bitacora de Perforacion - instalador del Conector WhatsApp para Windows 10/11.
# Uso: abrir PowerShell (sin administrador) y pegar:
#   irm https://raw.githubusercontent.com/emapalla/emapalla/claude/bitacora-perforacion/conector-whatsapp/windows/instalar.ps1 | iex
# Volver a ejecutarlo actualiza el conector y conserva la vinculacion, la clave y los mensajes.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Rama   = 'claude/bitacora-perforacion'
$Base   = Join-Path $env:LOCALAPPDATA 'BitacoraConector'
$App    = Join-Path $Base 'app'
$CfgF   = Join-Path $Base 'conector.env'
$Puerto = 3000

function Paso($t) { Write-Host ''; Write-Host "==> $t" -ForegroundColor Cyan }
function Aviso($t) { Write-Host "    $t" -ForegroundColor Yellow }
function RefrescarPath { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }
function TieneWinget { [bool](Get-Command winget -ErrorAction SilentlyContinue) }

try {
  New-Item -ItemType Directory -Force -Path $Base | Out-Null

  # 1. Node.js
  Paso 'Paso 1 de 6: Node.js'
  RefrescarPath
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    if (-not (TieneWinget)) { throw 'Falta "Instalador de aplicacion" (winget). Instalalo desde Microsoft Store y volve a ejecutar.' }
    Aviso 'Instalando Node.js. Si Windows pide permiso, toca "Si".'
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent | Out-Host
    RefrescarPath
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'No se pudo instalar Node.js. Cerra PowerShell, abrilo de nuevo y volve a ejecutar.' }
  }
  $NodeExe = (Get-Command node).Source
  $NpmCmd  = Join-Path (Split-Path $NodeExe) 'npm.cmd'
  $ver = [int](& $NodeExe -p "process.versions.node.split('.')[0]")
  if ($ver -lt 20) { throw "Node.js $ver es muy viejo. Desinstalalo desde Configuracion > Aplicaciones y volve a ejecutar." }
  Write-Host "    Node.js $ver listo."

  # 2. Tailscale
  Paso 'Paso 2 de 6: Tailscale (la direccion segura para que Claude llegue a esta PC)'
  $Ts = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
  if (-not (Test-Path $Ts)) {
    if (-not (TieneWinget)) { throw 'Falta winget para instalar Tailscale.' }
    Aviso 'Instalando Tailscale. Si Windows pide permiso, toca "Si".'
    winget install -e --id Tailscale.Tailscale --accept-source-agreements --accept-package-agreements --silent | Out-Host
    Start-Sleep -Seconds 8
    if (-not (Test-Path $Ts)) { throw 'No se pudo instalar Tailscale.' }
  }
  function EstadoTs { try { (& $Ts status --json 2>$null | Out-String | ConvertFrom-Json) } catch { $null } }
  $st = EstadoTs
  if (-not $st -or $st.BackendState -ne 'Running') {
    Aviso 'Inicia sesion en Tailscale (gratis) con tu cuenta de Google o Microsoft.'
    Aviso 'Si no se abre el navegador solo, abri el enlace que aparece abajo (Ctrl + clic).'
    & $Ts up --unattended | Out-Host
    for ($i = 0; $i -lt 60; $i++) { $st = EstadoTs; if ($st -and $st.BackendState -eq 'Running') { break }; Start-Sleep -Seconds 5 }
    if (-not $st -or $st.BackendState -ne 'Running') { throw 'Tailscale no quedo conectado. Abri Tailscale desde el menu Inicio, inicia sesion y volve a ejecutar.' }
  }
  $Dns = ($st.Self.DNSName).TrimEnd('.')
  $PublicUrl = "https://$Dns"
  Write-Host "    Tailscale listo: $Dns"

  # 3. Descargar el conector
  Paso 'Paso 3 de 6: Descargando el conector'
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*BitacoraConector*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*BitacoraConector*iniciar.cmd*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  $Zip = Join-Path $env:TEMP 'bitacora-conector.zip'
  $Tmp = Join-Path $env:TEMP 'bitacora-conector'
  Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/emapalla/emapalla/archive/refs/heads/$Rama.zip" -OutFile $Zip
  if (Test-Path $Tmp) { Remove-Item $Tmp -Recurse -Force }
  Expand-Archive -Path $Zip -DestinationPath $Tmp -Force
  $Src = Get-ChildItem $Tmp -Directory | Select-Object -First 1
  if (Test-Path $App) { Remove-Item $App -Recurse -Force }
  Move-Item $Src.FullName $App
  Push-Location (Join-Path $App 'conector-whatsapp')
  & $NpmCmd ci --omit=dev --no-audit --no-fund | Out-Host
  $npmOk = ($LASTEXITCODE -eq 0)
  Pop-Location
  if (-not $npmOk) { throw 'Fallo la instalacion de las librerias (npm). Revisa la conexion a internet y volve a ejecutar.' }

  # 4. Clave y configuracion
  Paso 'Paso 4 de 6: Configuracion'
  $Token = $null
  if (Test-Path $CfgF) {
    $m = Select-String -Path $CfgF -Pattern '^TOKEN=(.+)$' | Select-Object -First 1
    if ($m) { $Token = $m.Matches[0].Groups[1].Value.Trim() }
  }
  if (-not $Token) {
    $b = New-Object byte[] 16
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    $Token = -join ($b | ForEach-Object { $_.ToString('x2') })
  }
  $cfg = "TOKEN=$Token`r`nPUBLIC_URL=$PublicUrl`r`nHOST=127.0.0.1`r`nPORT=$Puerto`r`n"
  [IO.File]::WriteAllText($CfgF, $cfg, [Text.Encoding]::ASCII)

  # 5. Arranque automatico (cada vez que inicias sesion en Windows)
  Paso 'Paso 5 de 6: Arranque automatico'
  $Cmd = Join-Path $Base 'iniciar.cmd'
  $Vbs = Join-Path $Base 'iniciar.vbs'
  $cmdTxt = "@echo off`r`ncd /d `"%~dp0`"`r`n:loop`r`nif exist conector.log for %%A in (conector.log) do if %%~zA GTR 5000000 del conector.log`r`n`"$NodeExe`" `"app\conector-whatsapp\src\index.js`" >> conector.log 2>&1`r`ntimeout /t 10 /nobreak >nul`r`ngoto loop`r`n"
  [IO.File]::WriteAllText($Cmd, $cmdTxt, [Text.Encoding]::ASCII)
  $vbsTxt = "CreateObject(`"WScript.Shell`").Run `"`"`"`" & `"$Cmd`" & `"`"`"`", 0, False`r`n"
  [IO.File]::WriteAllText($Vbs, $vbsTxt, [Text.Encoding]::ASCII)
  $Startup = [Environment]::GetFolderPath('Startup')
  Copy-Item $Vbs (Join-Path $Startup 'Bitacora Conector WhatsApp.vbs') -Force
  try { powercfg /change standby-timeout-ac 0 | Out-Null } catch { }
  Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$Vbs`""

  # 6. Direccion publica con Tailscale Funnel
  Paso 'Paso 6 de 6: Publicando la direccion segura'
  Aviso 'Si aparece un enlace para habilitar "Funnel" o "HTTPS", abrilo (Ctrl + clic) y toca Enable / Habilitar.'
  & $Ts funnel --bg $Puerto | Out-Host

  $ok = $false
  for ($i = 0; $i -lt 30; $i++) {
    try { Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Puerto/salud" -TimeoutSec 3 | Out-Null; $ok = $true; break } catch { Start-Sleep -Seconds 2 }
  }

  $Admin = "http://localhost:$Puerto/admin?token=$Token"
  $Mcp   = "$PublicUrl/mcp/$Token"
  $txt = @"
BITACORA DE PERFORACION - CONECTOR WHATSAPP
No compartas este archivo: da acceso a los mensajes.

1) Pagina de administracion (QR y grupos). Se abre solo en ESTA PC:
   $Admin

2) Conector para claude.ai (Configuracion > Conectores > Agregar conector personalizado)
   Nombre: Bitacora WhatsApp
   URL:    $Mcp

Para actualizar: volve a pegar en PowerShell el mismo comando de instalacion.
Carpeta del programa: $Base
"@
  $Desk = [Environment]::GetFolderPath('Desktop')
  $TxtF = Join-Path $Desk 'Bitacora - direcciones del conector.txt'
  [IO.File]::WriteAllText($TxtF, $txt, [Text.Encoding]::UTF8)

  Write-Host ''
  if ($ok) { Write-Host 'LISTO. El conector esta funcionando.' -ForegroundColor Green }
  else { Aviso 'El conector todavia no responde. Espera un minuto y abri la pagina de administracion.' }
  Write-Host "Deje las direcciones en el Escritorio: $TxtF"
  Start-Process notepad.exe "`"$TxtF`""
  Start-Process $Admin
}
catch {
  Write-Host ''
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Saca una captura de esta ventana y mandasela a Claude.'
}
