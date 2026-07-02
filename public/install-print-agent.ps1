# Printward local print agent installer for Windows.
# Run in PowerShell on the PC that has the printer installed:
#   powershell -ExecutionPolicy Bypass -File .\install-print-agent.ps1

$ErrorActionPreference = "Stop"

$InstallRoot = Join-Path $env:LOCALAPPDATA "PrintwardAgent"
$AppDir = Join-Path $InstallRoot "app"
$NodeDir = Join-Path $InstallRoot "node"
$ToolsDir = Join-Path $InstallRoot "tools"
$LogPath = Join-Path $InstallRoot "agent.log"
$TempDir = Join-Path $env:TEMP ("printward-agent-install-" + [guid]::NewGuid().ToString("N"))
$Port = 37951
$RepoZipUrl = "https://codeload.github.com/grossmanj/printward/zip/refs/heads/main"
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

function Assert-LastExitCode($Label) {
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }
}

function Show-AgentLog($Path) {
  Write-Host ""
  Write-Host "Agent log: $Path"
  if (Test-Path $Path) {
    Write-Host "Last agent log lines:"
    Get-Content -Path $Path -Tail 80 | ForEach-Object { Write-Host $_ }
  } else {
    Write-Host "Agent log file was not created."
  }
}

function Get-AgentHealth($Url) {
  $request = [System.Net.HttpWebRequest]::Create($Url)
  $request.Proxy = $null
  $request.Timeout = 3000
  $request.ReadWriteTimeout = 3000
  $response = $request.GetResponse()
  try {
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
    try {
      return ($reader.ReadToEnd() | ConvertFrom-Json)
    } finally {
      $reader.Dispose()
    }
  } finally {
    $response.Dispose()
  }
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
  $npmCmd = Join-Path $NodeDir "npm.cmd"
  if ((Test-Path $nodeExe) -and (Test-Path $npmCmd)) {
    return $nodeExe
  }

  Write-Step "Installing local Node.js runtime"
  if (Test-Path $NodeDir) {
    Remove-Item -Path $NodeDir -Recurse -Force
  }
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
  $oldPath = $env:Path
  $oldPrependNodePath = $env:npm_config_scripts_prepend_node_path
  try {
    $env:Path = "$NodeDir;$env:Path"
    $env:npm_config_scripts_prepend_node_path = "true"
    & $NpmCmd ci --omit=dev --no-audit --no-fund
    Assert-LastExitCode "npm dependency install"
  } finally {
    $env:Path = $oldPath
    if ($null -eq $oldPrependNodePath) {
      Remove-Item Env:\npm_config_scripts_prepend_node_path -ErrorAction SilentlyContinue
    } else {
      $env:npm_config_scripts_prepend_node_path = $oldPrependNodePath
    }
    Pop-Location
  }

  if (-not (Test-Path (Join-Path $AppDir "node_modules\pdf-lib\package.json"))) {
    throw "npm install completed, but pdf-lib was not installed."
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
  $content = @"
@echo off
set "PRINTWARD_AGENT_PORT=$Port"
set "PRINTWARD_PDF_PRINT_EXE=$SumatraExe"
echo Starting Printward Agent %DATE% %TIME% > "$LogPath"
echo Node: $NodeExe >> "$LogPath"
echo App: $AppDir >> "$LogPath"
if not exist "$NodeExe" (
  echo Node executable missing: $NodeExe >> "$LogPath"
  exit /b 1
)
if not exist "$AppDir\src\local-agent.js" (
  echo Agent script missing: $AppDir\src\local-agent.js >> "$LogPath"
  exit /b 1
)
cd /d "$AppDir"
"$NodeExe" "$AppDir\src\local-agent.js" >> "$LogPath" 2>&1
echo Agent exited with code %ERRORLEVEL% >> "$LogPath"
exit /b %ERRORLEVEL%
"@
  Set-Content -Path $startCmd -Value $content -Encoding ASCII
  return $startCmd
}

function Register-StartupLauncher($StartCmd) {
  Write-Step "Registering Printward Agent startup"
  $startupDir = [Environment]::GetFolderPath("Startup")
  if (-not $startupDir) {
    Write-Host "Windows Startup folder was not found; automatic startup was skipped."
    return
  }

  New-Item -ItemType Directory -Force -Path $startupDir | Out-Null
  $launcher = Join-Path $startupDir "PrintwardAgent.vbs"
  $escapedStartCmd = $StartCmd.Replace('"', '""')
  $content = @"
Set shell = CreateObject("WScript.Shell")
shell.Run Chr(34) & "$escapedStartCmd" & Chr(34), 0, False
"@
  Set-Content -Path $launcher -Value $content -Encoding ASCII
  Write-Host "Startup launcher: $launcher"
}

function Start-And-Verify($StartCmd) {
  Write-Step "Starting Printward Agent"
  $process = Start-Process -FilePath $StartCmd -WindowStyle Hidden -PassThru
  $healthUrl = "http://127.0.0.1:$Port/health"
  $deadline = (Get-Date).AddSeconds(45)
  $lastError = $null

  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 750

    try {
      $health = Get-AgentHealth $healthUrl
      if ($health.ok) {
        Write-Host ""
        Write-Host "Printward Agent is installed and running."
        Write-Host "Health URL: $healthUrl"
        Write-Host "Install path: $InstallRoot"
        Write-Host "Log path: $LogPath"
        return
      }
    } catch {
      $lastError = $_.Exception.Message
    }

    if ($process.HasExited) {
      break
    }
  }

  Write-Host ""
  if ($process.HasExited) {
    Write-Host "Printward Agent process exited with code $($process.ExitCode)."
  } else {
    Write-Host "Printward Agent process is still running, but health check did not answer."
  }
  if ($lastError) {
    Write-Host "Last health check error: $lastError"
  }
  Show-AgentLog $LogPath
  throw "Printward Agent did not answer at $healthUrl."
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
  Register-StartupLauncher $startCmd
  Start-And-Verify $startCmd
} finally {
  Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}
