<#
.SYNOPSIS
  打包韭菜面板为可发布 zip，并输出 SHA-256。

.DESCRIPTION
  只打包运行所需文件（plugin.json 位于 zip 根目录），不包含源码仓库里的
  docs、scripts、dist 等目录。输出文件名与市场索引条目约定的 asset 一致。

.EXAMPLE
  pwsh -File scripts/package.ps1
  pwsh -File scripts/package.ps1 -Version 1.0.0
#>
param(
  [string]$Version = "",
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$manifestPath = Join-Path $root "plugin.json"
if (-not (Test-Path $manifestPath)) {
  throw "plugin.json 不存在：$manifestPath"
}

$manifest = Get-Content -Raw $manifestPath | ConvertFrom-Json
if (-not $Version) { $Version = $manifest.version }
if (-not $Version) { throw "无法确定版本号：请在 plugin.json 写 version 或传入 -Version" }

if (-not $OutDir) { $OutDir = Join-Path $root "dist" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# 运行所需 + 发布所需；plugin.json 必须在 zip 根目录
$include = @("plugin.json", "index.js", "style.css", "README.md", "CHANGELOG.md", "LICENSE")
$missing = @()
foreach ($name in $include) {
  if (-not (Test-Path (Join-Path $root $name))) { $missing += $name }
}
if ($missing.Count -gt 0) { throw ("缺少待打包文件：" + ($missing -join ", ")) }

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("snow-stock-panel-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $staging | Out-Null

try {
  foreach ($name in $include) {
    Copy-Item -LiteralPath (Join-Path $root $name) -Destination (Join-Path $staging $name) -Force
  }

  $zipName = "snow-leek-box-v$Version.zip"
  $zipPath = Join-Path $OutDir $zipName
  if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

  Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zipPath -CompressionLevel Optimal

  $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLower()
  $size = (Get-Item -LiteralPath $zipPath).Length

  Write-Host ""
  Write-Host "PACKAGE  $zipPath"
  Write-Host ("SIZE     {0:N0} bytes" -f $size)
  Write-Host "VERSION  $Version"
  Write-Host "SHA256   $hash"
  Write-Host ""
  Write-Host "下一步："
  Write-Host "  1. 创建 GitHub Release（tag: v$Version），上传 $zipName"
  Write-Host "  2. 在 snow-plugin-store 提交 app/plugins/$($manifest.id).json"
  Write-Host "  3. sha256 填上面的值；下载地址按 tag/asset 推导"
}
finally {
  if (Test-Path $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}

