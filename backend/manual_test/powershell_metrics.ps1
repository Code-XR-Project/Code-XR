<#
  .SYNOPSIS
  Block comment
#>
function Get-Greeting {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [string] $Name,
        [int] $Count = 1
    )
    if ($Name -eq 'root' -and $Count -gt 0) {
        Write-Output "Hello root $($Name.Length)"
    } elseif ($Count -lt 0 -or $Count -gt 10) {
        throw "bad `"count`""
    } else {
        foreach ($i in 1..$Count) {
            Write-Output 'hi'   # comment
        }
    }
}

function Test-Items($Path, $Filter) {
    switch -Wildcard ($Filter) {
        '*.txt' { 'text' }
        '*.md'  { 'markdown' }
        default { 'other' }
    }
    do {
        $Path = $Path.Trim()
    } while ($Path.Length -gt 3)
    try {
        Get-ChildItem $Path | Where-Object { $_.Length -gt 0 } | ForEach-Object { $_.Name }
    } catch [System.IO.IOException] {
        Write-Error $_
    } finally {
        $x = $null ?? 'none'
    }
    $text = @"
if ($x) { not code }
"@
}

class Account {
    [string] $Owner
    [int] $Balance

    Account([string] $owner) {
        $this.Owner = $owner
    }

    [bool] Withdraw([int] $amount) {
        if ($amount -gt $this.Balance) { return $false }
        $this.Balance -= $amount
        return $true
    }
}
