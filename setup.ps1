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

# Optional downloads: if one fails, Sidequest still runs (English voice only,
# or word-level pronunciation feedback only), so setup carries on.
function Get-Files($label, $base, $dir, $files) {
  try {
    foreach ($src in $files.Keys) {
      $dest = Join-Path $dir $files[$src]
      if (Test-Path $dest) { continue }
      New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
      Write-Host "Downloading $label $src ..."
      Invoke-WebRequest "$base/$src" -OutFile "$dest.part"
      Move-Item -Force "$dest.part" $dest
    }
    Write-Host "$label ready in $dir"
  } catch {
    Write-Warning "$label download failed ($_). Re-run setup.ps1 later to retry."
  }
}

# 3b. Arabic voice (Supertonic 3 by Supertone, ~400 MB, OpenRAIL-M weights) ---
Step 'Arabic voice'
$stFiles = [ordered]@{}
foreach ($f in @('LICENSE', 'onnx/tts.json', 'onnx/unicode_indexer.json',
                 'onnx/duration_predictor.onnx', 'onnx/text_encoder.onnx',
                 'onnx/vector_estimator.onnx', 'onnx/vocoder.onnx')) { $stFiles[$f] = $f }
foreach ($v in @('F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5')) {
  $stFiles["voice_styles/$v.json"] = "voice_styles/$v.json"
}
Get-Files 'Supertonic 3' `
  'https://huggingface.co/Supertone/supertonic-3/resolve/3cadd1ee6394adea1bd021217a0e650ede09a323' `
  'models\supertonic-3' $stFiles

# 3c. Pronunciation model (wav2vec2 phonemes, 4-bit ONNX, ~240 MB, Apache-2.0)
Step 'Pronunciation model'
Get-Files 'Phoneme model' `
  'https://huggingface.co/onnx-community/wav2vec2-lv-60-espeak-cv-ft-ONNX/resolve/c69750f5043e5e1f8a71ab95dd3b98338c280c92' `
  'models\phoneme' ([ordered]@{ 'onnx/model_q4.onnx' = 'model.onnx'; 'vocab.json' = 'vocab.json' })

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
