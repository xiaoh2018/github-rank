# 生成站点社交分享图 og-image.png（1200x630）
# 用法：powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\make-og-image.ps1
# 依赖：Windows 自带的 .NET Framework GDI+（System.Drawing），不需要任何第三方库
# 注意：本文件必须保存为「UTF-8 带 BOM」，否则 Windows PowerShell 5.1 会按 ANSI 读中文导致乱码
param(
  [string]$Out = "og-image.png"
)

Add-Type -AssemblyName System.Drawing

$W = 1200
$H = 630
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

function C([string]$hex) {
  return [System.Drawing.ColorTranslator]::FromHtml($hex)
}

# 底色：深蓝渐变
$rectAll = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rectAll, (C "#0a0e1a"), (C "#161f36"), 25.0)
$g.FillRectangle($bg, $rectAll)

# 右上角金色光晕
$glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$glowPath.AddEllipse(820, -220, 620, 620)
$glow = New-Object System.Drawing.Drawing2D.PathGradientBrush($glowPath)
$glow.CenterColor = [System.Drawing.Color]::FromArgb(70, 240, 180, 41)
$glow.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 240, 180, 41))
$g.FillPath($glow, $glowPath)

# 左侧金色竖条
$accent = New-Object System.Drawing.SolidBrush((C "#f0b429"))
$g.FillRectangle($accent, 72, 96, 8, 96)

# 字体
$fTitle = New-Object System.Drawing.Font("Microsoft YaHei", 54, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fSub = New-Object System.Drawing.Font("Microsoft YaHei", 28, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$fMeta = New-Object System.Drawing.Font("Microsoft YaHei", 22, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$fChip = New-Object System.Drawing.Font("Microsoft YaHei", 20, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fUrl = New-Object System.Drawing.Font("Segoe UI", 24, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)

$white = New-Object System.Drawing.SolidBrush((C "#e8ecf4"))
$muted = New-Object System.Drawing.SolidBrush((C "#8b95a7"))
$gold = New-Object System.Drawing.SolidBrush((C "#f0b429"))

$g.DrawString("GitHub 热门项目排行榜", $fTitle, $white, 104, 118)
$g.DrawString("按星标 · 增速 · 活跃度发现热门开源项目", $fSub, $muted, 108, 208)

# 三个信息胶囊
$chips = @("近 7 天 / 30 天 / 1 年 / 全部", "今日增量 · 语言分布", "每 3 小时自动更新")
$x = 108
foreach ($t in $chips) {
  $size = $g.MeasureString($t, $fChip)
  $cw = [int]$size.Width + 44
  $ch = 58
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = 16
  $path.AddArc($x, 300, $r * 2, $r * 2, 180, 90)
  $path.AddArc($x + $cw - $r * 2, 300, $r * 2, $r * 2, 270, 90)
  $path.AddArc($x + $cw - $r * 2, 300 + $ch - $r * 2, $r * 2, $r * 2, 0, 90)
  $path.AddArc($x, 300 + $ch - $r * 2, $r * 2, $r * 2, 90, 90)
  $path.CloseFigure()
  $chipFill = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 26, 35, 56))
  $chipLine = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 44, 56, 82), 2)
  $g.FillPath($chipFill, $path)
  $g.DrawPath($chipLine, $path)
  $g.DrawString($t, $fChip, $gold, ($x + 22), 312)
  $x = $x + $cw + 16
}

# 右侧装饰柱状图（金色渐变，示意排名）
$bars = @(140, 190, 240, 285, 330)
$bx = 982
for ($i = 0; $i -lt $bars.Count; $i++) {
  $bh = $bars[$i]
  $top = 470 - $bh
  $bw = 34
  $alpha = 90 + ($i * 34)
  if ($alpha -gt 255) { $alpha = 255 }
  $barBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($alpha, 240, 180, 41))
  $g.FillRectangle($barBrush, ($bx + $i * 44), $top, $bw, $bh)
}

# 底部信息
$g.DrawString("500 个仓库 · 50 位开发者 · 50 个组织", $fMeta, $muted, 108, 400)
$g.DrawString("github.661026.xyz", $fUrl, $gold, 108, 470)

$line = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(80, 240, 180, 41), 2)
$g.DrawLine($line, 72, 555, 1128, 555)
$g.DrawString("数据来自 GitHub Search API · 静态托管 · 开源项目", $fMeta, $muted, 108, 572)

$g.Dispose()
$bmp.Save((Join-Path (Get-Location) $Out), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("已生成 " + $Out)