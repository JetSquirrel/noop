# Noop installer (Windows):  irm https://raw.githubusercontent.com/JetSquirrel/noop/main/install.ps1 | iex
# The first machine, once:   $env:NOOP_INIT_ARGS = "--primary"; irm <same url> | iex
$ErrorActionPreference = "Stop"
$HomeDir = if ($env:NOOP_HOME) { $env:NOOP_HOME } elseif ((Test-Path "$HOME\.agent-hub") -and -not (Test-Path "$HOME\.noop")) { "$HOME\.agent-hub" } else { "$HOME\.noop" }
$App = "$HomeDir\app"
$Log = "$HomeDir\install.log"
$Repo = if ($env:NOOP_REPO) { $env:NOOP_REPO } else { "https://github.com/JetSquirrel/noop.git" }
New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null
Set-Content -Path $Log -Value "" -Encoding utf8

function Step($name) { Write-Host ("  {0,-30}" -f $name) -NoNewline -ForegroundColor DarkGray }
function Ok($msg = "") { Write-Host "$([char]0x2713) $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "! $msg" -ForegroundColor Yellow }
# Details go to the log as plain UTF-8. Windows PowerShell 5.1 turns anything a program writes to stderr into an error
# record once it is redirected, which "Stop" would treat as fatal, and many tools print progress there. Callers check
# $LASTEXITCODE for real failures.
function Run { param([scriptblock]$b) $ErrorActionPreference = "Continue"; & $b *>&1 | ForEach-Object { "$_" } | Out-File -Append -Encoding utf8 $Log }
function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" } }

trap {
  Write-Host ([char]0x2717) -ForegroundColor Red
  Write-Host "`n  Something went wrong: $_`n  Asking the AI medic to fix it (details: $Log)`n"
  if ((Get-Command bun -ErrorAction SilentlyContinue) -and (Test-Path "$App\src\cli.ts")) { bun "$App\src\cli.ts" fix "install.ps1 failed: $_ . Log: $Log" }
  elseif (Get-Command claude -ErrorAction SilentlyContinue) { claude -p "Noop install.ps1 failed on Windows: $_ . Read $Log, fix the cause, then rerun the installer." }
  break
}

Write-Host "`nNoop - your own AI team`n"
if (Test-Path "$HOME\.bun\bin\bun.exe") { $env:Path += ";$HOME\.bun\bin" }  # installed earlier, this window just predates its PATH entry
Step "bun"
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Run { irm bun.sh/install.ps1 | iex }
  $env:Path += ";$HOME\.bun\bin"
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { throw "bun did not install" }
} else { Run { bun upgrade } }  # an old bun cannot read a newer bun.lock
Ok (bun --version)
Step "Noop"
if (Test-Path "$App\.git") { Run { git -C $App remote set-url origin $Repo; git -C $App pull -q --ff-only }; Check "git pull" } else { Run { git clone -q $Repo $App }; Check "git clone" }
Push-Location $App; Run { bun install --frozen-lockfile }; $deps = $LASTEXITCODE; Pop-Location
if ($deps -ne 0) { throw "bun install failed (exit $deps)" }
Ok
Step "AI tools"
$missing = @("claude", "codex", "gh") | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) }
if ($missing) { Warn "missing: $($missing -join ', ') (install and log in for full capability)" } else { Ok "claude, codex, gh" }
Write-Host ""

$env:NOOP_HOME = $HomeDir
# piped into iex, a script gets no arguments; NOOP_INIT_ARGS carries them
$InitArgs = if ($args.Count) { $args } elseif ($env:NOOP_INIT_ARGS) { $env:NOOP_INIT_ARGS -split "\s+" } else { @() }
bun "$App\src\cli.ts" init @InitArgs
if ($LASTEXITCODE -ne 0) {  # a wrong code or URL needs the owner, not the medic
  Write-Host "`n  This machine has not joined your Noop. Fix the problem above and run the installer again." -ForegroundColor Yellow
  return
}
Step "background service"
Run { bun "$App\src\cli.ts" install }
if ($LASTEXITCODE -eq 0) { Ok } else { Warn "not installed, see $Log. Details: noop doctor" }
Run { powercfg /change standby-timeout-ac 0 }
Write-Host ""
bun "$App\src\cli.ts" status --brief
Write-Host ""
