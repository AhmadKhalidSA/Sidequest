# Sidequest one-time setup (Windows). Safe to re-run: finished steps are skipped.
#   powershell -ExecutionPolicy Bypass -File setup.ps1
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # makes downloads much faster
Set-Location $PSScriptRoot

function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }

# 1. Python 3.11+ ----------------------------------------------------------
Step 'Python'
$py = $null
foreach ($cand in @('py -3.13', 'py -3.12', 'py -3.11', 'python')) {
  $exe, $arg = $cand.Split(' ', 2)
  if (Get-Command $exe -ErrorAction SilentlyContinue) {
    try {
      $ver = & $exe $arg -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
      if ($ver -and [version]$ver -ge [version]'3.11') { $py = $cand; break }
    } catch {}
  }
}
if (-not $py) { throw 'Python 3.11 or newer is required: https://www.python.org/downloads/' }
Write-Host "Using $py"

if (-not (Test-Path '.venv\Scripts\python.exe')) {
  $exe, $arg = $py.Split(' ', 2)
  & $exe $arg -m venv .venv
}
$venv = '.venv\Scripts\python.exe'
& $venv -m pip install --upgrade pip --quiet
& $venv -m pip install -r requirements.txt --quiet
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
  Write-Host 'NVIDIA GPU found: adding CUDA libraries for fast speech recognition'
  & $venv -m pip install nvidia-cublas-cu12==12.9.2.10 nvidia-cudnn-cu12==9.24.0.43 --quiet
}

# 2. Node / Electron --------------------------------------------------------
Step 'Node packages (Electron overlay)'
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw 'Node.js 18 or newer is required: https://nodejs.org/'
}
npm install --no-fund --no-audit

# 3. Voice model (Kokoro, ~350 MB) -------------------------------------------
Step 'Voice model'
New-Item -ItemType Directory -Force models | Out-Null
$base = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0'
foreach ($f in @('kokoro-v1.0.onnx', 'voices-v1.0.bin')) {
  if (Test-Path "models\$f") { Write-Host "models\$f already there"; continue }
  Write-Host "Downloading $f ..."
  Invoke-WebRequest "$base/$f" -OutFile "models\$f.part"
  Move-Item "models\$f.part" "models\$f"
}

# 4. Claude sign-in ------------------------------------------------------------
Step 'Claude'
if (Get-Command claude -ErrorAction SilentlyContinue) {
  Write-Host 'Claude Code found. If you have never signed in, run "claude" once and log in.'
} else {
  $bundled = '.venv\Lib\site-packages\claude_agent_sdk\_bundled\claude.exe'
  Write-Host 'Sign in to Claude once (a Claude Pro/Max subscription, or an Anthropic API key):'
  Write-Host "  $bundled"
  Write-Host 'then type /login, finish in the browser, and /exit.'
  Write-Host 'Alternatively set the ANTHROPIC_API_KEY environment variable (billed per use).'
}

Step 'Done'
Write-Host 'Start Sidequest with start.bat. The first launch takes ~30-40 s (speech models download on first use).'
