param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 2147483647)]
  [int]$ModuleId,

  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path $_ -PathType Leaf })]
  [string]$SigningKeyFile,

  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path $_ -PathType Leaf })]
  [string]$BindingFile
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Join-Path $root 'BrooklynBowl.IikoFrontBridge\BrooklynBowl.IikoFrontBridge.csproj'
$output = Join-Path $root 'artifacts\BrooklynBowl.IikoFrontBridge'
$build = Join-Path $root 'BrooklynBowl.IikoFrontBridge\bin\Release\net472'

$signingKey = (Resolve-Path $SigningKeyFile).Path
dotnet build $project -c Release -p:IikoLicenseModuleId=$ModuleId -p:IikoSigningKeyFile=$signingKey
Remove-Item $output -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $output | Out-Null
Copy-Item (Join-Path $build 'BrooklynBowl.IikoFrontBridge.dll'), (Join-Path $build 'Newtonsoft.Json.dll'), (Join-Path $build 'Manifest.xml') -Destination $output
Copy-Item (Join-Path $root 'BridgeConfig.example.json') -Destination (Join-Path $output 'BridgeConfig.json')
Copy-Item (Resolve-Path $BindingFile).Path -Destination (Join-Path $output 'binding.jwt')
Compress-Archive -Path "$output\*" -DestinationPath (Join-Path $root "artifacts\BrooklynBowl-IikoFrontBridge-$ModuleId.zip") -Force
