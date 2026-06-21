param(
  [Parameter(Mandatory=$true)][string]$InputPath,
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [int]$TimeoutSec = 15
)
$ErrorActionPreference = 'Stop'
$vmName = $env:NAUTILUS_WINDOWS_REVIEW_VM
$user = $env:NAUTILUS_WINDOWS_REVIEW_USER
$password = $env:NAUTILUS_WINDOWS_REVIEW_PASSWORD
$snapshotName = if ($env:NAUTILUS_WINDOWS_REVIEW_SNAPSHOT) { $env:NAUTILUS_WINDOWS_REVIEW_SNAPSHOT } else { 'NautilusClean' }
if (-not (Get-Command Get-VM -ErrorAction SilentlyContinue)) { throw 'Hyper-V PowerShell module is unavailable' }
if (-not $vmName -or -not $user -or -not $password) { throw 'NAUTILUS_WINDOWS_REVIEW_VM/USER/PASSWORD are required' }
$vm = Get-VM -Name $vmName -ErrorAction Stop
$snapshot = Get-VMSnapshot -VMName $vmName -Name $snapshotName -ErrorAction Stop
New-Item -ItemType Directory -Force -Path $OutputPath | Out-Null
$started = Get-Date
$status = 'error'; $exitCode = $null; $errorText = $null; $produced = @()
try {
  if ($vm.State -ne 'Off') { Stop-VM -Name $vmName -TurnOff -Force }
  Restore-VMSnapshot -VMSnapshot $snapshot -Confirm:$false
  Get-VMNetworkAdapter -VMName $vmName | Disconnect-VMNetworkAdapter
  Start-VM -Name $vmName | Out-Null
  $secure = ConvertTo-SecureString $password -AsPlainText -Force
  $credential = [PSCredential]::new($user, $secure)
  $ready = $false
  for ($i=0; $i -lt 30 -and -not $ready; $i++) {
    try { Invoke-Command -VMName $vmName -Credential $credential -ScriptBlock { $true } -ErrorAction Stop | Out-Null; $ready=$true } catch { Start-Sleep 2 }
  }
  if (-not $ready) { throw 'PowerShell Direct guest did not become ready' }
  $guestInput = 'C:\NautilusReview\input.exe'
  Copy-VMFile -VMName $vmName -SourcePath $InputPath -DestinationPath $guestInput -FileSource Host -CreateFullPath -Force
  $result = Invoke-Command -VMName $vmName -Credential $credential -ArgumentList $guestInput,$TimeoutSec -ScriptBlock {
    param($Path,$Timeout)
    $work='C:\NautilusReview\work'; New-Item -ItemType Directory -Force $work | Out-Null
    $before=Get-ChildItem $work -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
    $proc=Start-Process -FilePath $Path -WorkingDirectory $work -PassThru
    if (-not $proc.WaitForExit($Timeout*1000)) { Stop-Process -Id $proc.Id -Force; return @{Status='timeout';ExitCode=$null;Files=@()} }
    $files=@()
    $total=0
    foreach ($file in Get-ChildItem $work -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notin $before } | Select-Object -First 25) {
      if ($file.Length -le 16MB -and ($total + $file.Length) -le 128MB) {
        $files += @{Name=$file.Name;Content=[Convert]::ToBase64String([IO.File]::ReadAllBytes($file.FullName))}
        $total += $file.Length
      }
    }
    return @{Status='completed';ExitCode=$proc.ExitCode;Files=$files}
  }
  $status=$result.Status; $exitCode=$result.ExitCode
  $index=0
  foreach ($file in @($result.Files)) {
    $safeName=[IO.Path]::GetFileName([string]$file.Name)
    if ($safeName) {
      $name=('produced-{0:D3}-{1}' -f $index,$safeName)
      [IO.File]::WriteAllBytes((Join-Path $OutputPath $name),[Convert]::FromBase64String([string]$file.Content))
      $produced += $name; $index++
    }
  }
  $result | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $OutputPath 'hyperv.log')
} catch { $errorText=$_.Exception.Message; $errorText | Set-Content -Encoding UTF8 (Join-Path $OutputPath 'hyperv.log') }
finally {
  Stop-VM -Name $vmName -TurnOff -Force -ErrorAction SilentlyContinue
  Restore-VMSnapshot -VMSnapshot $snapshot -Confirm:$false -ErrorAction SilentlyContinue
}
@{status=$status;worker='hyperv';exitCode=$exitCode;durationSec=((Get-Date)-$started).TotalSeconds;screenshots=@();logFile='hyperv.log';producedFiles=$produced;error=$errorText} | ConvertTo-Json -Compress
