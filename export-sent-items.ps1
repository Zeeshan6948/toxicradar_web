param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [Parameter(Mandatory = $false)]
  [string]$OverwriteExisting = "false"
)

$ErrorActionPreference = "Stop"

function Release-ComObject {
  param([object]$ComObject)

  if ($null -ne $ComObject -and [System.Runtime.InteropServices.Marshal]::IsComObject($ComObject)) {
    [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($ComObject)
  }
}

function Convert-ToBoolean {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    $normalized = ""
  } else {
    $normalized = $Value.Trim().ToLowerInvariant()
  }

  return $normalized -in @("true", "1", "yes", "y")
}

$startedOutlook = $false
$outlook = $null
$namespace = $null
$sentFolder = $null
$targetStore = $null
$targetRoot = $null
$jsonTempPath = $null

try {
  $shouldOverwrite = Convert-ToBoolean $OverwriteExisting
  $fullOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
  $targetDirectory = [System.IO.Path]::GetDirectoryName($fullOutputPath)

  if ([string]::IsNullOrWhiteSpace($targetDirectory)) {
    throw "The selected PST path is invalid."
  }

  if (Test-Path -LiteralPath $fullOutputPath) {
    if (-not $shouldOverwrite) {
      throw "The target PST file already exists. Please choose a new file name."
    }

    Remove-Item -LiteralPath $fullOutputPath -Force
  }

  if (-not (Test-Path -LiteralPath $targetDirectory)) {
    New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
  }

  try {
    $outlook = [System.Runtime.InteropServices.Marshal]::GetActiveObject("Outlook.Application")
  } catch {
    $outlook = New-Object -ComObject Outlook.Application
    $startedOutlook = $true
  }

  if ($null -eq $outlook) {
    throw "Classic Outlook for Windows is required for PST export automation."
  }

  $namespace = $outlook.GetNamespace("MAPI")
  $namespace.Logon($null, $null, $false, $false)

  $sentFolder = $namespace.GetDefaultFolder(5)
  if ($null -eq $sentFolder) {
    throw "Could not access the default Sent Items folder."
  }

  $emailRecords = New-Object System.Collections.Generic.List[object]
  foreach ($item in $sentFolder.Items) {
    try {
      $subject = [string]$item.Subject
      $recipients = [string]$item.To
      $body = [string]$item.Body
      $sentOn = $item.SentOn
      $sender = [string]$item.SenderName
      $messageClass = [string]$item.MessageClass

      if (
        [string]::IsNullOrWhiteSpace($subject) -and
        [string]::IsNullOrWhiteSpace($body) -and
        [string]::IsNullOrWhiteSpace($recipients)
      ) {
        continue
      }

      if (-not [string]::IsNullOrWhiteSpace($messageClass) -and -not $messageClass.StartsWith("IPM.Note")) {
        continue
      }

      $isoDate = ""
      if ($sentOn -is [DateTime]) {
        $isoDate = $sentOn.ToString("o")
      }

      $emailRecords.Add([PSCustomObject]@{
        id = [string]::Concat("outlook-sent-", $emailRecords.Count + 1)
        subject = $(if ([string]::IsNullOrWhiteSpace($subject)) { "(No Subject)" } else { $subject.Trim() })
        recipients = $(if ([string]::IsNullOrWhiteSpace($recipients)) { "(No Recipients)" } else { $recipients.Trim() })
        date = $isoDate
        folderPath = "Outlook / Sent Items"
        sender = $(if ([string]::IsNullOrWhiteSpace($sender)) { "" } else { $sender.Trim() })
        body = $(if ([string]::IsNullOrWhiteSpace($body)) { "" } else { $body.Trim() })
        textForAnalysis = $(if ([string]::IsNullOrWhiteSpace($body)) { "" } else { $body.Trim() })
      }) | Out-Null
    } catch {
    }
  }

  $tempFile = [System.IO.Path]::GetTempFileName()
  Remove-Item -LiteralPath $tempFile -Force
  $jsonTempPath = [System.IO.Path]::ChangeExtension($tempFile, ".json")
  $emailRecords | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $jsonTempPath -Encoding UTF8

  # 3 = olStoreUnicode
  $namespace.AddStoreEx($fullOutputPath, 3)

  foreach ($store in $namespace.Stores) {
    if ($store.FilePath -eq $fullOutputPath) {
      $targetStore = $store
      break
    }
  }

  if ($null -eq $targetStore) {
    throw "Outlook created the PST, but the new store could not be located."
  }

  $targetRoot = $targetStore.GetRootFolder()
  [void]$sentFolder.CopyTo($targetRoot)
  $namespace.RemoveStore($targetRoot)
  Start-Sleep -Milliseconds 1500

  [PSCustomObject]@{
    success = $true
    path = $fullOutputPath
    emailsJsonPath = $jsonTempPath
    count = $emailRecords.Count
  } | ConvertTo-Json -Compress
} catch {
  throw $_.Exception.Message
} finally {
  if ($null -ne $namespace -and $null -ne $targetRoot) {
    try {
      $namespace.RemoveStore($targetRoot)
    } catch {
    }
  }

  if ($startedOutlook -and $null -ne $outlook) {
    try {
      $outlook.Quit()
    } catch {
    }
  }

  Release-ComObject $targetRoot
  Release-ComObject $targetStore
  Release-ComObject $sentFolder
  Release-ComObject $namespace
  Release-ComObject $outlook
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
