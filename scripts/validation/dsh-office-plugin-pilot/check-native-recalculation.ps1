# Consumer validation of a plugin-generated fixture. Does not change the source.
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$pilot = Join-Path $repo '.data/plugin-pilot-20261018'
$source = Join-Path $PSScriptRoot 'fixtures/metrics-plugin-generated.xlsx'
$out = Join-Path $pilot ('consumer-runs/' + [Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $out | Out-Null
$copy = Join-Path $out 'metrics-native-recalculated.xlsx'
Copy-Item -LiteralPath $source -Destination $copy
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
$report = [ordered]@{ kind='native-consumer-test-not-employee-acceptance'; source=$source; sourceSha256=$sourceHash; output=$copy; passed=$false; checks=@(); modelCalls=0 }
$app = $null; $book = $null; $sheet = $null; $cell = $null; $ownsInstance = $false
try {
  $app = New-Object -ComObject Excel.Application
  if ($app.Workbooks.Count -ne 0) { throw 'Application already contains workbooks; leaving user workbooks untouched.' }
  $ownsInstance = $true
  $report.engine = @{ reportedName=$app.Name; version=$app.Version; path=$app.Path; note='Identify the real vendor by executable path; Excel COM may be implemented by WPS.' }
  $app.Visible = $false
  $app.DisplayAlerts = $false
  $app.AskToUpdateLinks = $false
  $app.AutomationSecurity = 3
  $book = $app.Workbooks.Open($copy, 0, $false)
  $sheet = $book.Worksheets.Item(1)
  $cell = $sheet.Range('C2')
  $sheet.Calculate()
  if ($cell.Formula -ne '=B2/A2' -or [Math]::Abs([double]$cell.Value2 - 0.2) -gt 1e-10) { throw 'Original formula did not compute 0.2.' }
  $report.checks += @{ name='original-formula-computes'; formula=$cell.Formula; value=$cell.Value2; text=$cell.Text }
  $sheet.Range('B2').Value2 = 5
  $sheet.Calculate()
  if ([Math]::Abs([double]$cell.Value2 - 0.5) -gt 1e-10) { throw 'Changed input did not update formula to 0.5.' }
  $report.checks += @{ name='changed-input-recalculates'; B2=5; value=$cell.Value2 }
  $sheet.Range('A2').Value2 = 0
  $sheet.Calculate()
  if ($cell.Text -notmatch '#DIV/0!') { throw 'Zero denominator did not produce the expected formula error.' }
  $report.checks += @{ name='zero-denominator-reported'; A2=0; text=$cell.Text }
  $sheet.Range('A2').Value2 = 10
  $sheet.Range('B2').Value2 = 2
  $sheet.Calculate()
  if ([Math]::Abs([double]$cell.Value2 - 0.2) -gt 1e-10 -or $cell.Formula -ne '=B2/A2') { throw 'Restoring inputs did not retain the formula and expected value.' }
  $book.Save()
  $book.Close($false)
  $book = $null
  $report.checks += @{ name='consumer-saved-recalculated-copy'; restoredA2=10; restoredB2=2; expectedC2=0.2 }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($copy)
  $reader = $null
  try {
    $reader = [IO.StreamReader]::new($zip.GetEntry('xl/worksheets/sheet1.xml').Open())
    [xml]$xml = $reader.ReadToEnd()
    $ns = [Xml.XmlNamespaceManager]::new($xml.NameTable)
    $ns.AddNamespace('s', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
    $savedFormula = $xml.SelectSingleNode('//s:c[@r="C2"]/s:f', $ns).InnerText
    $savedValue = [double]::Parse($xml.SelectSingleNode('//s:c[@r="C2"]/s:v', $ns).InnerText, [Globalization.CultureInfo]::InvariantCulture)
    if ($savedFormula -ne 'B2/A2' -or [Math]::Abs($savedValue - 0.2) -gt 1e-10) { throw 'Saved file did not retain the formula and recalculated cache.' }
    $report.checks += @{ name='independent-zip-formula-and-cache'; formula=$savedFormula; value=$savedValue }
    $report.outputSha256 = (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash
  } finally { if ($null -ne $reader) { $reader.Dispose() }; $zip.Dispose() }
  $report.passed = $true
} catch {
  $report.failure = $_.Exception.Message
} finally {
  if ($null -ne $book) { $book.Close($false) }
  if ($ownsInstance -and $null -ne $app -and $app.Workbooks.Count -eq 0) { $app.Quit() }
  foreach ($comObject in @($cell, $sheet, $book, $app)) {
    if ($null -ne $comObject -and [Runtime.InteropServices.Marshal]::IsComObject($comObject)) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($comObject) }
  }
  $report.sourceUnchanged = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -eq $sourceHash
  if (-not $report.sourceUnchanged) { $report.passed = $false }
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $out 'result.json') -Encoding utf8
  $report | ConvertTo-Json -Depth 8
}
if (-not $report.passed) { exit 1 }
