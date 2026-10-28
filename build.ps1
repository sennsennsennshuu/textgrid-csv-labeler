# 单文件构建入口：仅生成 textgrid-csv-labeler.exe，不创建 target、PDB 或资源副本。
# 在仓库根目录运行 powershell -ExecutionPolicy Bypass -File .\build.ps1。
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$rustCompiler = Get-Command rustc -ErrorAction Stop
$sourcePath = '.\src\main.rs'
$pagePath = '.\ui\textgrid.html'
$outputPath = '.\textgrid-csv-labeler.exe'
if (!(Test-Path -LiteralPath $sourcePath) -or !(Test-Path -LiteralPath $pagePath)) {
    throw 'Missing src/main.rs or ui/textgrid.html'
}
# 直接 include_str! 读取原始 UTF-8 字节；网页快照不得经过行尾转换。
$compilerArguments = @(
    '--crate-name', 'textgrid_csv_labeler', '--edition=2021', '--crate-type', 'bin',
    '-C', 'opt-level=s', '-C', 'panic=abort', '-C', 'debuginfo=0', '-C', 'strip=symbols',
    '-C', 'codegen-units=1', '-C', 'target-feature=+crt-static', '-C', 'link-arg=/DEBUG:NONE',
    '-D', 'warnings', '-o', $outputPath, $sourcePath
)
& $rustCompiler.Source @compilerArguments
if ($LASTEXITCODE -ne 0) { throw 'Rust compilation failed' }
& $outputPath --self-test
if ($LASTEXITCODE -ne 0) { throw 'Executable self-test failed' }
# 哈希只显示在终端，不生成额外 sidecar；版本与证据在 GitHub 管理。
Get-FileHash -Algorithm SHA256 -LiteralPath $outputPath | Format-List
