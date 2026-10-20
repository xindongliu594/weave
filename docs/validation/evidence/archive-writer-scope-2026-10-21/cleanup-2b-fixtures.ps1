$ErrorActionPreference='Stop'
$taskPlanRoot=$PSScriptRoot
$taskTempRoot=(Get-Item -LiteralPath ([IO.Path]::GetTempPath())).FullName.TrimEnd('\')
$taskLogs=@('task-2b-heartbeat-red.txt','task-2b-coordinator-green.txt','task-2b-callers-green.txt')
$taskTargets=@()
foreach($taskLog in $taskLogs){
  $taskLines=Get-Content -LiteralPath (Join-Path $taskPlanRoot $taskLog)
  if($taskLines[-1] -notmatch '^EXIT=[01]$'){throw "Original runner has no completed exit evidence: $taskLog"}
  foreach($taskLine in $taskLines){if($taskLine -match '^ARCHIVE_WRITER_EXIT_CLEANUP=(.+)$'){$taskTargets += [IO.Path]::GetFullPath($Matches[1])}}
}
foreach($taskTarget in ($taskTargets | Select-Object -Unique)){
  if([IO.Path]::GetDirectoryName($taskTarget) -ine $taskTempRoot -or [IO.Path]::GetFileName($taskTarget) -notmatch '^run-terminal-maintenance-[A-Za-z0-9]+$'){throw "Unexpected fixture target: $taskTarget"}
  if(Test-Path -LiteralPath $taskTarget){
    $taskItem=Get-Item -LiteralPath $taskTarget -Force
    if(-not $taskItem.PSIsContainer -or ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw "Unsafe fixture target: $taskTarget"}
    if((Resolve-Path -LiteralPath $taskTarget).ProviderPath -ine $taskTarget){throw "Unresolved fixture identity: $taskTarget"}
    Write-Output "Completed original process; verified exclusive synthetic target: $taskTarget"
    Remove-Item -LiteralPath $taskTarget -Recurse -Force
    Write-Output "Removed after process exit: $taskTarget"
  }
}
