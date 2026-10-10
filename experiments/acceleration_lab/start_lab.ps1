param([int]$Port = 8190, [string]$RunName = '')

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -ne 7) {
    throw 'PowerShell 7 is required'
}
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $Utf8NoBom
[Console]::OutputEncoding = $Utf8NoBom
$global:OutputEncoding = $Utf8NoBom
chcp.com 65001 > $null

$Lab = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo = (Resolve-Path -LiteralPath (Join-Path $Lab '..\..')).Path
$Comfy = (Resolve-Path -LiteralPath (Join-Path $Repo '..\..')).Path
if ($RunName -and $RunName -notmatch '^[A-Za-z0-9_-]+$') { throw 'Invalid run name' }
$Root = if ($RunName) { Join-Path $Lab "local\runs\$RunName\runtime" } else { Join-Path $Lab 'local\runtime' }
$LogRoot = if ($RunName) { Join-Path $Lab "local\runs\$RunName" } else { Join-Path $Lab 'local' }
New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
foreach ($name in @('lab_stdout.log','lab_stderr.log','lab_pid.txt')) {
    if (Test-Path -LiteralPath (Join-Path $LogRoot $name)) { throw "Run artifact exists: $name" }
}
$Nodes = Join-Path $Root 'custom_nodes'
foreach ($name in @('input','output','temp','user','custom_nodes')) {
    New-Item -ItemType Directory -Path (Join-Path $Root $name) -Force | Out-Null
}
$targets = @{
    'TerryDirector' = $Repo
    'comfyui-kjnodes' = Join-Path $Comfy 'custom_nodes\comfyui-kjnodes'
    'terry-acceleration-lab' = $Lab
}
foreach ($name in $targets.Keys) {
    $target = (Resolve-Path -LiteralPath $targets[$name]).Path
    $destination = Join-Path $Nodes $name
    if (Test-Path -LiteralPath $destination) {
        $existing = Get-Item -LiteralPath $destination
        if ($existing.LinkType -ne 'Junction' -or (Resolve-Path -LiteralPath $existing.Target).Path -ne $target) {
            throw "Unexpected existing custom node path: $destination"
        }
    } else {
        New-Item -ItemType Junction -Path $destination -Target $target | Out-Null
    }
}
$Python = Join-Path $Comfy '.venv\python.exe'
if (!(Test-Path -LiteralPath $Python)) { throw "Missing Python: $Python" }
foreach ($name in @('TERRYDIRECTOR_TRACE','TERRYDIRECTOR_OP_PROFILE','TERRYDIRECTOR_BACKEND_VERIFY')) {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
}
$arguments = @(
    (Join-Path $Comfy 'main.py'), '--listen', '127.0.0.1', '--port', [string]$Port,
    '--base-directory', $Root,
    '--models-directory', (Join-Path $Comfy 'models'),
    '--extra-model-paths-config', (Join-Path $Comfy 'extra_model_paths.yaml'),
    '--input-directory', (Join-Path $Comfy 'input'),
    '--output-directory', (Join-Path $Root 'output'),
    '--temp-directory', (Join-Path $Root 'temp'),
    '--user-directory', (Join-Path $Root 'user'),
    '--use-sage-attention', '--disable-auto-launch', '--disable-manager-ui'
)
$process = Start-Process -FilePath $Python -ArgumentList $arguments -WorkingDirectory $Comfy -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogRoot 'lab_stdout.log') `
    -RedirectStandardError (Join-Path $LogRoot 'lab_stderr.log')
$process.Id | Set-Content -LiteralPath (Join-Path $LogRoot 'lab_pid.txt') -Encoding utf8
Write-Output "Lab PID $($process.Id), port $Port, root $Root"
