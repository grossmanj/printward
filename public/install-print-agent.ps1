# Printward local print agent installer for Windows.
# Run in PowerShell on the PC that has the printer installed:
#   powershell -ExecutionPolicy Bypass -File .\install-print-agent.ps1

$ErrorActionPreference = "Stop"

$InstallRoot = Join-Path $env:LOCALAPPDATA "PrintwardAgent"
$AppDir = Join-Path $InstallRoot "app"
$NodeDir = Join-Path $InstallRoot "node"
$ToolsDir = Join-Path $InstallRoot "tools"
$TempDir = Join-Path $env:TEMP ("printward-agent-install-" + [guid]::NewGuid().ToString("N"))
$Port = 37951
$RepoZipUrl = "https://github.com/grossmanj/printward/archive/refs/heads/main.zip"
$NodeIndexUrl = "https://nodejs.org/dist/latest-v20.x/"
$SumatraZipUrl = "https://www.sumatrapdfreader.org/dl/rel/3.6.1/SumatraPDF-3.6.1-64.zip"

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Step($Message) {
  Write-Host ""
  Write-Host "==> $Message"
}

function Download-File($Url, $Destination) {
  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
}

function Stop-AgentOnPort($LocalPort) {
  try {
    $connections = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue
    foreach ($connection in $connections) {
      if ($connection.OwningProcess) {
        Stop-Process -Id $connection.OwningProcess -Force -ErrorAction SilentlyContinue
      }
    }
  } catch {
    Write-Host "Existing agent check skipped: $($_.Exception.Message)"
  }
}

function Install-Node {
  $nodeExe = Join-Path $NodeDir "node.exe"
  if (Test-Path $nodeExe) {
    return $nodeExe
  }

  Write-Step "Installing local Node.js runtime"
  New-Item -ItemType Directory -Force -Path $NodeDir | Out-Null

  $index = Invoke-WebRequest -Uri $NodeIndexUrl -UseBasicParsing
  $zipName = [regex]::Match($index.Content, 'node-v20\.[^"]+-win-x64\.zip').Value
  if (-not $zipName) {
    throw "Could not find a Windows x64 Node.js zip in $NodeIndexUrl"
  }

  $nodeZip = Join-Path $TempDir $zipName
  Download-File ($NodeIndexUrl + $zipName) $nodeZip
  Expand-Archive -Path $nodeZip -DestinationPath $TempDir -Force

  $expanded = Get-ChildItem -Path $TempDir -Directory |
    Where-Object { $_.Name -like "node-v*-win-x64" } |
    Select-Object -First 1
  if (-not $expanded) {
    throw "Node.js archive did not contain the expected directory."
  }

  Copy-Item -Path (Join-Path $expanded.FullName "*") -Destination $NodeDir -Recurse -Force
  return $nodeExe
}

function Install-PrintwardApp($NpmCmd) {
  Write-Step "Installing Printward agent files"
  $repoZip = Join-Path $TempDir "printward-main.zip"
  Download-File $RepoZipUrl $repoZip
  Expand-Archive -Path $repoZip -DestinationPath $TempDir -Force

  $source = Get-ChildItem -Path $TempDir -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName "package.json") } |
    Select-Object -First 1
  if (-not $source) {
    throw "Downloaded Printward archive did not contain package.json."
  }

  if (Test-Path $AppDir) {
    Remove-Item -Path $AppDir -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
  Copy-Item -Path (Join-Path $source.FullName "*") -Destination $AppDir -Recurse -Force

  Write-Step "Installing production npm dependencies"
  Push-Location $AppDir
  try {
    & $NpmCmd install --omit=dev
  } finally {
    Pop-Location
  }
}

function Install-Sumatra {
  Write-Step "Installing portable PDF print bridge"
  New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
  $targetExe = Join-Path $ToolsDir "SumatraPDF.exe"
  $sumatraZip = Join-Path $TempDir "SumatraPDF.zip"
  $sumatraDir = Join-Path $TempDir "sumatra"

  Download-File $SumatraZipUrl $sumatraZip
  Expand-Archive -Path $sumatraZip -DestinationPath $sumatraDir -Force
  $sumatraExe = Get-ChildItem -Path $sumatraDir -Recurse -Filter "SumatraPDF*.exe" |
    Select-Object -First 1
  if (-not $sumatraExe) {
    throw "SumatraPDF executable was not found in the downloaded archive."
  }

  Copy-Item -Path $sumatraExe.FullName -Destination $targetExe -Force
  return $targetExe
}

function Write-StartScript($NodeExe, $SumatraExe) {
  $startCmd = Join-Path $InstallRoot "start-agent.cmd"
  $logPath = Join-Path $InstallRoot "agent.log"
  $content = @"
@echo off
set PRINTWARD_AGENT_PORT=$Port
set PRINTWARD_PDF_PRINT_EXE=$SumatraExe
cd /d "$AppDir"
"$NodeExe" "$AppDir\src\local-agent.js" >> "$logPath" 2>&1
"@
  Set-Content -Path $startCmd -Value $content -Encoding ASCII
  return $startCmd
}

function Register-StartupTask($StartCmd) {
  Write-Step "Registering Printward Agent startup task"
  $taskName = "PrintwardAgent"
  $taskRun = "`"$StartCmd`""
  & schtasks.exe /Create /TN $taskName /TR $taskRun /SC ONLOGON /F | Out-Null
}

function Start-And-Verify($StartCmd) {
  Write-Step "Starting Printward Agent"
  Start-Process -FilePath $StartCmd -WindowStyle Hidden
  Start-Sleep -Seconds 3

  $healthUrl = "http://127.0.0.1:$Port/health"
  $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 10
  if (-not $health.ok) {
    throw "Printward Agent did not return ok=true."
  }

  Write-Host ""
  Write-Host "Printward Agent is installed and running."
  Write-Host "Health URL: $healthUrl"
  Write-Host "Install path: $InstallRoot"
}

try {
  Write-Step "Preparing install folders"
  New-Item -ItemType Directory -Force -Path $InstallRoot, $ToolsDir, $TempDir | Out-Null

  Stop-AgentOnPort $Port
  $nodeExe = Install-Node
  $npmCmd = Join-Path $NodeDir "npm.cmd"
  Install-PrintwardApp $npmCmd
  $sumatraExe = Install-Sumatra
  $startCmd = Write-StartScript $nodeExe $sumatraExe
  Register-StartupTask $startCmd
  Start-And-Verify $startCmd
} finally {
  Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}
