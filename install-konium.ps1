<#
.SYNOPSIS
  Sets up Konium Designer's website and services from scratch, or brings them up to date.

.DESCRIPTION
  Run it from the folder of a Konium build (the zip extracted), on Windows. In order:
    site    the website and the app in its app\ folder (site\) uploaded to the web host by SFTP, or copied to a folder
    ai      the AI service (konium-ai): OpenRouter key, salt
    parts   part searches (konium-parts): Digi-Key and Mouser keys, salt
    report  bug reports (konium-report): Email Routing, the address reports go to, a GitHub token
    vcs     version control (konium-vcs): the R2 bucket, salt
    check   every part tried from outside, as a user would
  It signs in to Cloudflare once (a browser window), deploys each Worker with its routes on
  konium.app, and sets each secret: the salts are made here and never shown; keys and the report
  address are typed into hidden prompts and kept only as Cloudflare secrets (nothing secret is
  written to disk). Run again after each new build: it deploys the new code and site and leaves
  what is set up as it is (a salt is never replaced: it would cut users off their data).

.PARAMETER Steps
  The steps to run (default: all), e.g. -Steps ai,check

.PARAMETER ReplaceKeys
  Ask again for keys already set (OpenRouter, Digi-Key, Mouser, the report address, GitHub).

.EXAMPLE
  .\install-konium.ps1
  .\install-konium.ps1 -Steps site,check
#>
param(
  [string[]]$Steps = @('site', 'ai', 'parts', 'report', 'vcs', 'check'),
  [switch]$ReplaceKeys
)

$ErrorActionPreference = 'Stop'
# "ai,check" as one word too (from install-konium.cmd)
$AllSteps = @('site', 'ai', 'parts', 'report', 'vcs', 'check')
$Steps = @($Steps | ForEach-Object { $_ -split '[,\s]+' } | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
foreach ($st in $Steps) { if ($AllSteps -notcontains $st) { throw "Not a step: $st (the steps: $($AllSteps -join ', '))" } }
$Steps = @($AllSteps | Where-Object { $Steps -contains $_ })
$Root = $PSScriptRoot
$Domain = 'konium.app'
$Bucket = 'konium-vcs'
# Wrangler, Cloudflare's tool, at a version this build was checked with (fetched by npx on first use)
$WranglerVersion = '4.152.0'
$env:WRANGLER_SEND_METRICS = 'false'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
$SettingsFile = Join-Path $env:APPDATA 'Konium Designer\install-settings.json'
$Results = New-Object System.Collections.Generic.List[object]

# ---- Output and questions -------------------------------------------------------------------

function Title([string]$Text) { Write-Host ''; Write-Host "== $Text ==" -ForegroundColor Cyan }
function Say([string]$Text) { Write-Host $Text }
function Good([string]$Text) { Write-Host "  OK  $Text" -ForegroundColor Green }
function Warn([string]$Text) { Write-Host "  !!  $Text" -ForegroundColor Yellow }
function Bad([string]$Text) { Write-Host "  XX  $Text" -ForegroundColor Red }
function Result([string]$Step, [string]$State, [string]$Note) { $Results.Add([pscustomobject]@{ Step = $Step; Result = $State; Note = $Note }) }

function Ask([string]$Question, [string]$Default = '') {
  $shown = if ($Default) { "$Question [$Default]" } else { $Question }
  $a = Read-Host $shown
  if ([string]::IsNullOrWhiteSpace($a)) { return $Default }
  return $a.Trim()
}
function Yes([string]$Question, [bool]$Default = $true) {
  $hint = if ($Default) { 'Y/n' } else { 'y/N' }
  while ($true) {
    $a = Read-Host "$Question ($hint)"
    if ([string]::IsNullOrWhiteSpace($a)) { return $Default }
    if ($a -match '^(y|yes)$') { return $true }
    if ($a -match '^(n|no)$') { return $false }
  }
}
function WaitFor([string]$What) { [void](Read-Host "  $What, then press Enter") }
function Open([string]$Url) { try { Start-Process $Url } catch { Say "  Open $Url" } }

function LoadSettings {
  if (Test-Path $SettingsFile) { try { return Get-Content $SettingsFile -Raw | ConvertFrom-Json } catch { } }
  return [pscustomobject]@{}
}
function SaveSettings($s) {
  New-Item -ItemType Directory -Force -Path (Split-Path $SettingsFile) | Out-Null
  $s | ConvertTo-Json | Set-Content -Path $SettingsFile -Encoding UTF8
}
function Setting($s, [string]$Name, [string]$Default = '') {
  if ($s.PSObject.Properties[$Name]) { return [string]$s.$Name }
  return $Default
}
function SetSetting($s, [string]$Name, [string]$Value) {
  if ($s.PSObject.Properties[$Name]) { $s.$Name = $Value } else { $s | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}

# ---- Wrangler -------------------------------------------------------------------------------

# Run in a folder straight on the console (its prompts, hidden ones too, and the browser sign-in
# work as typed); its exit code in $LASTEXITCODE. (No argument here has a space in it.)
function Wr([string]$Dir, [string[]]$Arguments) {
  $npx = (Get-Command npx.cmd -ErrorAction Stop).Source
  $p = Start-Process -FilePath $npx -ArgumentList (@('--yes', "wrangler@$WranglerVersion") + $Arguments) -WorkingDirectory $Dir -NoNewWindow -Wait -PassThru
  $global:LASTEXITCODE = $p.ExitCode
}
# Run and keep what it says (exit code in $script:WrCode); -InputText goes in as if typed
function WrOut([string]$Dir, [string[]]$Arguments, [string]$InputText) {
  $ErrorActionPreference = 'Continue'
  Push-Location $Dir
  try {
    if ($PSBoundParameters.ContainsKey('InputText')) { $out = $InputText | & npx.cmd --yes "wrangler@$WranglerVersion" @Arguments 2>&1 }
    else { $out = & npx.cmd --yes "wrangler@$WranglerVersion" @Arguments 2>&1 }
    $script:WrCode = $LASTEXITCODE
  } finally { Pop-Location }
  return (($out | ForEach-Object { "$_" }) -join "`n")
}
function WorkerDir([string]$Name) { return Join-Path $Root "cloudflare\$Name" }

# The secrets a Worker has (names only)
function SecretsOf([string]$Name) {
  $text = WrOut (WorkerDir $Name) @('secret', 'list', '--format', 'json')
  return @([regex]::Matches($text, '"name"\s*:\s*"([A-Za-z0-9_]+)"') | ForEach-Object { $_.Groups[1].Value })
}
# A long random salt, made here and sent straight to Cloudflare (never shown or written down)
function NewSalt {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes); $rng.Dispose()
  return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}
function PutSalt([string]$Name) {
  if ((SecretsOf $Name) -contains 'SALT') { Good "$Name's salt is set (kept as it is)"; return }
  $out = WrOut (WorkerDir $Name) @('secret', 'put', 'SALT') (NewSalt)
  if ($script:WrCode -eq 0) { Good "$Name's salt made and set" } else { Bad "$Name's salt wasn't set:`n$out"; throw "salt" }
}
# A key typed by you into Wrangler's hidden prompt
function PutKey([string]$Name, [string]$Secret, [string]$What, [bool]$Optional = $false) {
  $has = (SecretsOf $Name) -contains $Secret
  if ($has -and -not $ReplaceKeys) { Good "$What is set"; return $true }
  if ($Optional -and -not (Yes "  Set $What now?" (-not $has))) { if ($has) { Good "$What kept" } else { Warn "$What not set (later: .\install-konium.ps1 -Steps $Name)" }; return $has }
  Say "  Paste $What at the prompt (it isn't shown):"
  Wr (WorkerDir $Name) @('secret', 'put', $Secret)
  if ($LASTEXITCODE -eq 0) { Good "$What set"; return $true }
  Bad "$What wasn't set"; return $false
}
function Deploy([string]$Name) {
  while ($true) {
    Say "  Deploying $Name..."
    Wr (WorkerDir $Name) @('deploy')
    if ($LASTEXITCODE -eq 0) { Good "$Name deployed"; return $true }
    Bad "$Name's deploy failed (the reason is above)"
    if (-not (Yes '  Try again?')) { return $false }
  }
}

# ---- Before anything ------------------------------------------------------------------------

function CheckFolder {
  foreach ($p in @('site\index.html', 'cloudflare\ai\wrangler.toml', 'cloudflare\parts\wrangler.toml', 'cloudflare\report\wrangler.toml', 'cloudflare\vcs\wrangler.toml')) {
    if (-not (Test-Path (Join-Path $Root $p))) { throw "Run this from the folder of a Konium build (the zip extracted): $p is missing" }
  }
}

function CheckNode {
  $v = $null
  try { $v = (& node -v) 2>$null } catch { }
  if ($v -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) { Good "Node.js $v"; return }
  if ($v) { Warn "Node.js $v is too old: Wrangler needs 22 or newer" } else { Warn 'Node.js is not installed' }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget -and (Yes '  Install Node.js LTS now with winget?')) {
    & winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  } else {
    Open 'https://nodejs.org/'
    WaitFor 'Install Node.js LTS (22 or newer)'
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }
  $v = $null
  try { $v = (& node -v) 2>$null } catch { }
  if ($v -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) { Good "Node.js $v"; return }
  throw 'Node.js 22 or newer is needed: install it, open a new window and run this again'
}

function SignIn {
  Say "  Getting Wrangler $WranglerVersion ready (the first time it downloads)..."
  $who = WrOut $Root @('whoami')
  if ($who -match 'not authenticated') {
    Say '  A browser window opens: sign in to Cloudflare (make an account if you have none) and allow Wrangler.'
    Wr $Root @('login')
    $who = WrOut $Root @('whoami')
    if ($who -match 'not authenticated') { throw 'Not signed in to Cloudflare' }
  }
  # The account: the one there is, or the one you pick
  $accounts = @()
  foreach ($line in ($who -split "`n")) {
    $m = [regex]::Match($line, '\b([0-9a-f]{32})\b')
    if ($m.Success) {
      $name = ($line.Replace($m.Value, '') -replace '[^\w .&''-]', ' ' -replace '\s+', ' ').Trim()
      $accounts += [pscustomobject]@{ Id = $m.Value; Name = $name }
    }
  }
  $accounts = @($accounts | Sort-Object Id -Unique)
  if ($accounts.Count -eq 0) { Warn 'No account ID found in whoami: Wrangler will ask when it needs one'; return }
  if ($accounts.Count -eq 1) { $pick = $accounts[0] }
  else {
    Say '  Your Cloudflare accounts:'
    for ($i = 0; $i -lt $accounts.Count; $i++) { Say ("   {0}. {1} ({2})" -f ($i + 1), $accounts[$i].Name, $accounts[$i].Id) }
    $n = 1
    [void][int]::TryParse((Ask "  Which one holds $Domain?" '1'), [ref]$n)
    $pick = $accounts[[Math]::Max(0, [Math]::Min($accounts.Count - 1, $n - 1))]
  }
  $env:CLOUDFLARE_ACCOUNT_ID = $pick.Id
  Good "Cloudflare account: $($pick.Name) ($($pick.Id))"
}

# konium.app on this Cloudflare account (its Email Routing settings say so); returns them
function CheckDomain {
  while ($true) {
    $s = WrOut $Root @('email', 'routing', 'settings', $Domain)
    if ($script:WrCode -eq 0) { Good "$Domain is on this Cloudflare account"; return $s }
    if ($s -notmatch 'Could not find zone') { Warn "Couldn't confirm $Domain on this account ($((($s -split "`n") | Select-Object -Last 1).Trim())): going on"; return $s }
    Warn "$Domain isn't on this Cloudflare account yet"
    Say "  In Cloudflare: Add a domain > $Domain (the Free plan is enough), then at the domain's registrar"
    Say '  change its nameservers to the two Cloudflare gives. It becomes Active within minutes to hours.'
    Open 'https://dash.cloudflare.com/'
    if (-not (Yes '  Check again?')) { throw "$Domain must be on Cloudflare for the services' routes" }
  }
}

# ---- Steps ----------------------------------------------------------------------------------

function StepSite {
  Title 'Website (site\)'
  $s = LoadSettings
  Say "  The site is the website with the built app in its app\ folder, as they are in site\ (version $((Get-Content (Join-Path $Root 'site\version.json') -Raw | ConvertFrom-Json).version))."
  Say '  1. Upload it to the web host by SFTP (the host''s control panel gives the server and the user)'
  Say '  2. Copy it to a folder (your own pipeline takes it from there)'
  Say '  3. Skip'
  $how = Ask '  Which?' (Setting $s 'siteMethod' '1')
  SetSetting $s 'siteMethod' $how
  $items = @(Get-ChildItem -Path (Join-Path $Root 'site') -Force | ForEach-Object { $_.FullName })
  if ($how -eq '1') {
    if (-not (Get-Command scp -ErrorAction SilentlyContinue)) { Bad "Windows' SSH client (scp) isn't installed: Settings > System > Optional features > OpenSSH Client"; Result 'Site' 'Failed' 'no scp'; return }
    $server = Ask '  SFTP server' (Setting $s 'sftpHost')
    $user = Ask '  SFTP user' (Setting $s 'sftpUser')
    $port = Ask '  Port' (Setting $s 'sftpPort' '22')
    $folder = Ask "  Folder on the server that $Domain shows (blank: the top)" (Setting $s 'sftpFolder')
    SetSetting $s 'sftpHost' $server; SetSetting $s 'sftpUser' $user; SetSetting $s 'sftpPort' $port; SetSetting $s 'sftpFolder' $folder
    SaveSettings $s
    $target = if ($folder) { "$user@${server}:$($folder.TrimEnd('/'))/" } else { "$user@${server}:" }
    Say '  Uploading (the server asks for the SFTP password; the first time, confirm its fingerprint with yes)...'
    & scp -r -P $port @items $target
    if ($LASTEXITCODE -eq 0) { Good "Site uploaded to $server"; Result 'Site' 'Uploaded' "$server $folder" } else { Bad 'The upload failed (the reason is above)'; Result 'Site' 'Failed' 'upload' }
  } elseif ($how -eq '2') {
    $dest = Ask '  Folder' (Setting $s 'siteFolder')
    SetSetting $s 'siteFolder' $dest; SaveSettings $s
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item -Path $items -Destination $dest -Recurse -Force
    Good "Site copied to $dest"; Result 'Site' 'Copied' $dest
  } else { SaveSettings $s; Result 'Site' 'Skipped' '' }
  Say ''
  Say "  For $Domain to show it, once: in Cloudflare > $Domain > DNS, an A record for $Domain (and a CNAME"
  Say "  for www to $Domain) pointing at the web host's IP address, Proxied (orange cloud); SSL/TLS: Full."
  Say '  The services below only answer on a proxied name.'
}

function StepAi {
  Title 'AI service (konium-ai)'
  Say '  Konium runs AI jobs for users on models through OpenRouter, paid from your OpenRouter credit:'
  Say '   - openrouter.ai: sign up and add credit (Settings > Credits)'
  Say "   - Keys > Create Key: name it konium-service and set a Credit limit (the month's budget); copy it"
  Say '   - Settings > Privacy: switch off training and logging for paid models'
  if ($ReplaceKeys -or -not ((SecretsOf 'ai') -contains 'OPENROUTER_KEY')) {
    if (Yes '  Open OpenRouter now?') { Open 'https://openrouter.ai/settings/keys'; Open 'https://openrouter.ai/settings/privacy' }
  }
  if (-not (Deploy 'ai')) { Result 'AI service' 'Failed' 'deploy'; return }
  try { PutSalt 'ai' } catch { Result 'AI service' 'Failed' 'salt'; return }
  $k = PutKey 'ai' 'OPENROUTER_KEY' 'the OpenRouter key (sk-or-...)'
  Result 'AI service' ($(if ($k) { 'Deployed' } else { 'Deployed, no key' })) 'konium.app/api/ai'
}

function StepParts {
  Title 'Part searches (konium-parts)'
  Say "  BOM part searches use your distributor keys (kept as Cloudflare secrets; users never see them):"
  Say '   - Digi-Key: developer.digikey.com > a production app with Product Information V4: Client ID and Client Secret'
  Say '   - Mouser: My Mouser > APIs > Search API key'
  Say '  A distributor without its keys shows as not set up in Konium; the other still works.'
  if (-not (Deploy 'parts')) { Result 'Part searches' 'Failed' 'deploy'; return }
  try { PutSalt 'parts' } catch { Result 'Part searches' 'Failed' 'salt'; return }
  $d1 = PutKey 'parts' 'DIGIKEY_CLIENT_ID' 'the Digi-Key Client ID' $true
  $d2 = if ($d1) { PutKey 'parts' 'DIGIKEY_CLIENT_SECRET' 'the Digi-Key Client Secret' } else { $false }
  $m = PutKey 'parts' 'MOUSER_KEY' 'the Mouser Search API key' $true
  $which = @(); if ($d1 -and $d2) { $which += 'Digi-Key' }; if ($m) { $which += 'Mouser' }
  Result 'Part searches' 'Deployed' ($(if ($which.Count) { $which -join ', ' } else { 'no distributor keys' }))
}

function StepReport {
  Title 'Bug reports (konium-report)'
  Say "  Help > Report a Bug sends each report by email (Cloudflare Email Routing, from reports@$Domain)"
  Say '  to one address of yours, kept only as a Cloudflare secret.'
  $settings = WrOut $Root @('email', 'routing', 'settings', $Domain)
  if ($settings -notmatch 'Enabled:\s*true') {
    Say "  Email Routing sets $Domain's MX and SPF records to Cloudflare's. If mail for @$Domain is handled"
    Say '  elsewhere (a mailbox at the web host, say), answer no and set it up in the dashboard instead.'
    $on = $false
    if (Yes "  Switch on Email Routing for $Domain?") { Wr $Root @('email', 'routing', 'enable', $Domain); $on = ($LASTEXITCODE -eq 0) }
    if (-not $on) {
      Warn "Email Routing couldn't be switched on here (a mail service already on $Domain, say)"
      Open 'https://dash.cloudflare.com/'
      WaitFor "In Cloudflare > $Domain > Email > Email Routing, switch it on"
    }
  } else { Good 'Email Routing is on' }
  $has = (SecretsOf 'report') -contains 'REPORT_TO'
  if (-not $has -or $ReplaceKeys) {
    $to = Ask '  The address reports go to (not stored anywhere but Cloudflare)'
    if ($to -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { Bad 'Not an email address'; Result 'Bug reports' 'Failed' 'address'; return }
    $list = WrOut $Root @('email', 'routing', 'addresses', 'list')
    $line = ($list -split "`n" | Where-Object { $_ -match [regex]::Escape($to) } | Select-Object -First 1)
    if (-not $line) {
      Wr $Root @('email', 'routing', 'addresses', 'create', $to)
      Say "  Cloudflare sent a verification email to that address."
    }
    while ($true) {
      $list = WrOut $Root @('email', 'routing', 'addresses', 'list')
      $line = ($list -split "`n" | Where-Object { $_ -match [regex]::Escape($to) } | Select-Object -First 1)
      if ($line -and $line -notmatch 'pending') { Good 'The address is verified'; break }
      WaitFor 'Click the link in the verification email'
      if (-not $line -and -not (Yes '  Not listed yet: check again?')) { break }
    }
  }
  if (-not (Deploy 'report')) { Result 'Bug reports' 'Failed' 'deploy'; return }
  if (-not $has -or $ReplaceKeys) {
    $out = WrOut (WorkerDir 'report') @('secret', 'put', 'REPORT_TO') $to
    if ($script:WrCode -eq 0) { Good 'The address is set' } else { Bad "The address wasn't set:`n$out" }
  } else { Good 'The address is set' }
  # Reports filed in a GitHub repository too (for the AI assistant), optional
  $repo = ([regex]::Match((Get-Content (Join-Path (WorkerDir 'report') 'wrangler.toml') -Raw), 'REPORTS_REPO\s*=\s*"([^"]+)"')).Groups[1].Value
  $gh = (SecretsOf 'report') -contains 'GITHUB_TOKEN'
  if ($repo -and (-not $gh -or $ReplaceKeys)) {
    Say "  Optionally, each report is also filed in the private GitHub repository $repo (as an issue)."
    if (Yes '  Set that up now?' $false) {
      Say "   - Make the private repository $repo if it isn't there (an empty README is enough)"
      Say '   - GitHub > Settings > Developer settings > Fine-grained tokens > Generate new token:'
      Say "     only $repo; Contents: Read and write; Issues: Read and write; an expiry you note down"
      Open 'https://github.com/settings/personal-access-tokens/new'
      $gh = PutKey 'report' 'GITHUB_TOKEN' 'the GitHub token'
    }
  }
  Result 'Bug reports' 'Deployed' ($(if ($gh) { "email and $repo" } else { 'email' }))
}

function StepVcs {
  Title 'Version control store (konium-vcs)'
  Say "  Teams' projects in Konium's store, sealed with each team's key, in the R2 bucket $Bucket."
  while ($true) {
    [void](WrOut (WorkerDir 'vcs') @('r2', 'bucket', 'info', $Bucket))
    if ($script:WrCode -eq 0) { Good "The bucket $Bucket is there"; break }
    $out = WrOut (WorkerDir 'vcs') @('r2', 'bucket', 'create', $Bucket)
    if ($script:WrCode -eq 0 -or $out -match 'already exists') { Good "The bucket $Bucket made"; break }
    Warn "The bucket couldn't be made: $(($out -split "`n" | Where-Object { $_ -match 'ERROR|error|enable' } | Select-Object -First 2) -join ' ')"
    Say '  R2 has to be switched on once for the account: Cloudflare > R2 Object Storage > Purchase/Enable'
    Say '  (the free allowance is enough; Cloudflare may ask for a payment method).'
    Open 'https://dash.cloudflare.com/?to=/:account/r2/overview'
    if (-not (Yes '  Done: try again?')) { Result 'Version control' 'Failed' 'R2'; return }
  }
  if (-not (Deploy 'vcs')) { Result 'Version control' 'Failed' 'deploy'; return }
  try { PutSalt 'vcs' } catch { Result 'Version control' 'Failed' 'salt'; return }
  Result 'Version control' 'Deployed' "konium.app/api/vcs, /api/git"
}

# ---- Checks, from outside -------------------------------------------------------------------

function Fetch([string]$Url, [string]$Method = 'GET', [hashtable]$Headers = @{}) {
  try {
    $r = Invoke-WebRequest -Uri $Url -Method $Method -Headers $Headers -UseBasicParsing -TimeoutSec 30
    return [pscustomobject]@{ Code = [int]$r.StatusCode; Body = [string]$r.Content }
  } catch {
    $resp = $_.Exception.Response
    if ($resp) { return [pscustomobject]@{ Code = [int]$resp.StatusCode; Body = '' } }
    return [pscustomobject]@{ Code = 0; Body = $_.Exception.Message }
  }
}

function StepCheck {
  Title "Checks (https://$Domain, from outside)"
  $want = (Get-Content (Join-Path $Root 'site\version.json') -Raw | ConvertFrom-Json).version
  $r = Fetch "https://$Domain/version.json?$(Get-Random)"
  if ($r.Code -eq 200 -and $r.Body -match [regex]::Escape($want)) { Good "The site answers with $want" ; Result 'Check: site' 'OK' $want }
  elseif ($r.Code -eq 200) { Warn "The site answers with an older version: $($r.Body)"; Result 'Check: site' 'Older' $r.Body }
  else { Bad "The site doesn't answer ($($r.Code) $($r.Body))"; Result 'Check: site' 'Failed' "$($r.Code)" }
  # (from 26.169 the website is at the top and Konium Designer itself at app/)
  $r = Fetch "https://$Domain/app/?$(Get-Random)"
  if ($r.Code -eq 200 -and $r.Body -match 'id="app"') { Good "Konium Designer answers at https://$Domain/app/"; Result 'Check: app' 'OK' '' }
  else { Bad "Konium Designer doesn't answer at https://$Domain/app/ ($($r.Code)): was all of site\ uploaded?"; Result 'Check: app' 'Failed' "$($r.Code)" }

  $r = Fetch "https://$Domain/api/ai/config"
  if ($r.Code -eq 200 -and $r.Body -match '"models"\s*:\s*\[\s*\{') { Good 'AI service: models offered'; Result 'Check: AI' 'OK' '' }
  elseif ($r.Code -eq 200) { Warn 'AI service answers but offers no models (the OpenRouter key?)'; Result 'Check: AI' 'No models' '' }
  else { Bad "AI service doesn't answer ($($r.Code))"; Result 'Check: AI' 'Failed' "$($r.Code)" }

  $r = Fetch "https://$Domain/api/parts/config"
  if ($r.Code -eq 200) {
    $ready = @([regex]::Matches($r.Body, '"name"\s*:\s*"([^"]+)"\s*,\s*"ready"\s*:\s*true') | ForEach-Object { $_.Groups[1].Value })
    Good "Part searches answer (ready: $(if ($ready.Count) { $ready -join ', ' } else { 'none' }))"; Result 'Check: parts' 'OK' ($ready -join ', ')
  } else { Bad "Part searches don't answer ($($r.Code))"; Result 'Check: parts' 'Failed' "$($r.Code)" }

  $r = Fetch "https://$Domain/api/report" 'OPTIONS'
  if ($r.Code -eq 204) { Good 'Bug reports answer (send a test: Help > Report a Bug)'; Result 'Check: reports' 'OK' 'send a test from the app' }
  else { Bad "Bug reports don't answer ($($r.Code))"; Result 'Check: reports' 'Failed' "$($r.Code)" }

  # A team nobody has: the store looks in the bucket and finds nothing (404); 503: no salt
  $r = Fetch "https://$Domain/api/vcs/blob/index" 'GET' @{ Authorization = "Bearer $(NewSalt)" }
  if ($r.Code -eq 404) { Good 'Version control store answers'; Result 'Check: store' 'OK' '' }
  else { Bad "Version control store: $($r.Code) (404 expected)"; Result 'Check: store' 'Failed' "$($r.Code)" }
}

# ---- Run ------------------------------------------------------------------------------------

Write-Host 'Konium Designer: set-up and deployment' -ForegroundColor Cyan
Say "From $Root; steps: $($Steps -join ', ')"
CheckFolder
$workers = @($Steps | Where-Object { $_ -in @('ai', 'parts', 'report', 'vcs') })
if ($workers.Count) { Title 'Before anything'; CheckNode; SignIn; [void](CheckDomain) }

foreach ($step in $Steps) {
  try {
    switch ($step) {
      'site' { StepSite }
      'ai' { StepAi }
      'parts' { StepParts }
      'report' { StepReport }
      'vcs' { StepVcs }
      'check' { StepCheck }
    }
  } catch {
    Bad "$step stopped: $($_.Exception.Message)"
    Result $step 'Failed' $_.Exception.Message
  }
}

Title 'Summary'
$Results | Format-Table -AutoSize | Out-String | Write-Host
Say 'Run this again after each new build: it deploys the new site and services and keeps what is set.'
