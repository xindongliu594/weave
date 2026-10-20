param([Parameter(Mandatory=$true)][string[]]$LogNames)
$ErrorActionPreference='Stop'
$taskPlanRoot=(Get-Item -LiteralPath $PSScriptRoot).FullName
$taskTempRoot=(Get-Item -LiteralPath ([IO.Path]::GetTempPath())).FullName.TrimEnd('\')
$taskTargets=@()
foreach($taskLogName in $LogNames){
  if($taskLogName -notmatch '^task-2c\.2-[a-z0-9-]+\.(log|txt)$'){throw "Unexpected task log name"}
  $taskLogPath=Join-Path $taskPlanRoot $taskLogName
  $taskLines=@(Get-Content -LiteralPath $taskLogPath)
  if(-not $taskLines.Count -or $taskLines[-1] -notmatch '^EXIT=[01]$'){throw "Original runner has no completed exit evidence: $taskLogName"}
  foreach($taskLine in $taskLines){
    if($taskLine -match '^ARCHIVE_WRITER_EXIT_CLEANUP=(.+)$'){$taskTargets += [IO.Path]::GetFullPath($Matches[1])}
  }
}
foreach($taskTarget in ($taskTargets | Select-Object -Unique)){
  if([IO.Path]::GetDirectoryName($taskTarget) -ine $taskTempRoot -or [IO.Path]::GetFileName($taskTarget) -notmatch '^run-terminal-maintenance-[A-Za-z0-9]+$'){throw "Unexpected fixture target: $taskTarget"}
  if(-not (Test-Path -LiteralPath $taskTarget)){continue}
  $taskAncestor=$taskTarget
  while($taskAncestor){
    $taskItem=Get-Item -LiteralPath $taskAncestor -Force
    if(-not $taskItem.PSIsContainer -or ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw "Unsafe fixture ancestor: $taskAncestor"}
    $taskAncestor=[IO.Path]::GetDirectoryName($taskAncestor)
  }
  if((Resolve-Path -LiteralPath $taskTarget).ProviderPath -ine $taskTarget){throw "Unresolved fixture identity: $taskTarget"}
  $taskLinked=@(Get-ChildItem -LiteralPath $taskTarget -Force -Recurse | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
  if($taskLinked.Count){throw "Linked fixture descendant found; preserve target: $taskTarget"}
  Write-Output "Completed original runner; verified exclusive synthetic target: $taskTarget"
  Remove-Item -LiteralPath $taskTarget -Recurse -Force
  if(Test-Path -LiteralPath $taskTarget){throw "Fixture removal incomplete: $taskTarget"}
  Write-Output "Removed after process exit: $taskTarget"
}
