'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const MAX_OUTPUT = 128 * 1024;
const MAX_ARGUMENTS = 6000;
const MAX_TIMEOUT_MS = 120000;

const SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
function Get-WindowSummary($element) {
  $c = $element.Current
  $processName = ''
  try { $processName = (Get-Process -Id $c.ProcessId -ErrorAction Stop).ProcessName } catch {}
  return [ordered]@{ title=[string]$c.Name; processId=[int]$c.ProcessId; processName=[string]$processName; windowHandle=[int]$c.NativeWindowHandle; className=[string]$c.ClassName; enabled=[bool]$c.IsEnabled; offscreen=[bool]$c.IsOffscreen; bounds=@{x=[int]$c.BoundingRectangle.X;y=[int]$c.BoundingRectangle.Y;width=[int]$c.BoundingRectangle.Width;height=[int]$c.BoundingRectangle.Height} }
}
function Get-Windows {
  $root=[System.Windows.Automation.AutomationElement]::RootElement
  $children=$root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
  $items=@()
  foreach($w in $children){try{$s=Get-WindowSummary $w;if($A.includeUntitled -or -not [string]::IsNullOrWhiteSpace($s.title)){$items += [pscustomobject]$s}}catch{}}
  return @($items)
}
function Test-WindowMatch($window,$selector) {
  if($null -ne $selector.windowHandle -and [int]$window.windowHandle -ne [int]$selector.windowHandle){return $false}
  if($null -ne $selector.processId -and [int]$window.processId -ne [int]$selector.processId){return $false}
  if($selector.processName -and -not ([string]$window.processName).Equals([string]$selector.processName,[StringComparison]::OrdinalIgnoreCase)){return $false}
  if($selector.windowTitle){$title=[string]$window.title;if($selector.containsTitle){if($title.IndexOf([string]$selector.windowTitle,[StringComparison]::OrdinalIgnoreCase) -lt 0){return $false}}elseif(-not $title.Equals([string]$selector.windowTitle,[StringComparison]::OrdinalIgnoreCase)){return $false}}
  return $true
}
function Find-Window($selector) {
  if(-not ($selector.windowTitle -or $selector.processName -or $null -ne $selector.processId -or $null -ne $selector.windowHandle)){throw 'Specify windowTitle, processName, processId, or windowHandle to target a window.'}
  $all=@(Get-Windows | Where-Object {Test-WindowMatch $_ $selector})
  if($all.Count -eq 0){throw 'No matching top-level window was found. Run ui_list_windows and target an exact title, processName, processId, or windowHandle.'}
  if($all.Count -gt 1){throw ('The window selector matched '+$all.Count+' windows. Narrow it with an exact title, processId, or windowHandle.')}
  $root=[System.Windows.Automation.AutomationElement]::RootElement
  $condition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty,[int]$all[0].windowHandle)
  $element=$root.FindFirst([System.Windows.Automation.TreeScope]::Children,$condition)
  if($null -eq $element){throw 'The selected window disappeared before it could be inspected.'}
  return $element
}
function Get-PatternNames($element) {
  $names=@();$pattern=$null
  try { if($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){$names += 'Invoke'} } catch {}
  $pattern=$null;try { if($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)){$names += 'Value'} } catch {}
  $pattern=$null;try { if($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern,[ref]$pattern)){$names += 'Toggle'} } catch {}
  $pattern=$null;try { if($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)){$names += 'SelectionItem'} } catch {}
  $pattern=$null;try { if($element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$pattern)){$names += 'ExpandCollapse'} } catch {}
  $pattern=$null;try { if($element.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern,[ref]$pattern)){$names += 'Window'} } catch {}
  return ,$names
}
function Get-ControlSummary($element,$parentHandle) {
  $c=$element.Current
  return [ordered]@{name=[string]$c.Name;controlType=[string]($c.ControlType.ProgrammaticName -replace '^ControlType\.','');automationId=[string]$c.AutomationId;className=[string]$c.ClassName;processId=[int]$c.ProcessId;windowHandle=[int]$c.NativeWindowHandle;parentHandle=[int]$parentHandle;enabled=[bool]$c.IsEnabled;offscreen=[bool]$c.IsOffscreen;patterns=@(Get-PatternNames $element);bounds=@{x=[int]$c.BoundingRectangle.X;y=[int]$c.BoundingRectangle.Y;width=[int]$c.BoundingRectangle.Width;height=[int]$c.BoundingRectangle.Height}}
}
function Get-Controls($window,$maxDepth,$maxElements) {
  $controls=New-Object System.Collections.Generic.List[object]
  $script:uiTruncated=$false
  function Visit($parent,$depth,$parentHandle) {
    if($depth -gt $maxDepth -or $controls.Count -ge $maxElements){$script:uiTruncated=$true;return}
    try{$children=$parent.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)}catch{return}
    foreach($child in $children){if($controls.Count -ge $maxElements){$script:uiTruncated=$true;return};try{$summary=Get-ControlSummary $child $parentHandle;$controls.Add([pscustomobject]$summary);Visit $child ($depth+1) ([int]$summary.windowHandle)}catch{}}
  }
  Visit $window 1 ([int]$window.Current.NativeWindowHandle)
  return @{controls=@($controls);truncated=[bool]$script:uiTruncated}
}
function Find-Control($window,$selector) {
  if(-not ($selector.controlName -or $selector.automationId -or $selector.controlType)){throw 'Specify at least one control selector: controlName, automationId, or controlType.'}
  $all=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  $matches=@();$index=0
  foreach($element in $all){if($index -ge 5000){break};$index++;try{$c=$element.Current;$ok=$true
    if($selector.automationId -and -not ([string]$c.AutomationId).Equals([string]$selector.automationId,[StringComparison]::OrdinalIgnoreCase)){$ok=$false}
    if($selector.controlType -and -not ([string]($c.ControlType.ProgrammaticName -replace '^ControlType\.','')).Equals([string]$selector.controlType,[StringComparison]::OrdinalIgnoreCase)){$ok=$false}
    if($selector.controlName){if($selector.containsName){if(([string]$c.Name).IndexOf([string]$selector.controlName,[StringComparison]::OrdinalIgnoreCase) -lt 0){$ok=$false}}elseif(-not ([string]$c.Name).Equals([string]$selector.controlName,[StringComparison]::OrdinalIgnoreCase)){$ok=$false}}
    if($ok){$matches += $element}
  }catch{}}
  if($matches.Count -eq 0){throw 'No control matched the requested selector. Inspect the window and use its exact controlName, automationId, and/or controlType.'}
  if($null -ne $selector.occurrence){$n=[int]$selector.occurrence;if($n -lt 0 -or $n -ge $matches.Count){throw ('occurrence must be within the '+$matches.Count+' matching controls.')};return $matches[$n]}
  if($matches.Count -gt 1){throw ('The control selector matched '+$matches.Count+' controls. Add automationId/controlType or choose an explicit zero-based occurrence.')}
  return $matches[0]
}
try {
  $action=[string]$A.action
  switch($action) {
    'list_windows' {
      $windows=@(Get-Windows | Where-Object {Test-WindowMatch $_ $A})
      $limit=[Math]::Min([Math]::Max([int]$A.maxResults,1),200)
      @{ok=$true;count=[Math]::Min($windows.Count,$limit);truncated=($windows.Count -gt $limit);windows=@($windows | Select-Object -First $limit)} | ConvertTo-Json -Depth 8 -Compress
      break
    }
    'inspect_window' {
      $window=Find-Window $A;$summary=Get-WindowSummary $window
      $tree=Get-Controls $window ([Math]::Min([Math]::Max([int]$A.maxDepth,1),12)) ([Math]::Min([Math]::Max([int]$A.maxElements,1),1000))
      @{ok=$true;window=$summary;count=@($tree.controls).Count;truncated=$tree.truncated;controls=$tree.controls} | ConvertTo-Json -Depth 10 -Compress
      break
    }
    'wait_for_window' {
      $deadline=[DateTime]::UtcNow.AddMilliseconds([Math]::Min([Math]::Max([int]$A.timeoutMs,1000),120000));$found=$null
      do{$found=@(Get-Windows | Where-Object {Test-WindowMatch $_ $A}) | Select-Object -First 1;if($null -eq $found){Start-Sleep -Milliseconds 200}}while($null -eq $found -and [DateTime]::UtcNow -lt $deadline)
      if($null -eq $found){throw 'Timed out waiting for the requested window.'}
      @{ok=$true;window=$found} | ConvertTo-Json -Depth 8 -Compress
      break
    }
    'invoke_control' {
      $window=Find-Window $A;$control=Find-Control $window $A;$c=$control.Current;$name=[string]$c.Name;$controlType=[string]($c.ControlType.ProgrammaticName -replace '^ControlType\.','')
      switch([string]$A.operation) {
        'invoke' {$p=$null;if(-not $control.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$p)){throw 'The selected control does not expose InvokePattern. Inspect supported patterns or use ui_send_keys for a keyboard-accessible action.'};[void]$p.Invoke()}
        'select' {$p=$null;if(-not $control.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$p)){throw 'The selected control does not expose SelectionItemPattern.'};[void]$p.Select()}
        'toggle' {$p=$null;if(-not $control.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern,[ref]$p)){throw 'The selected control does not expose TogglePattern.'};[void]$p.Toggle()}
        'expand' {$p=$null;if(-not $control.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$p)){throw 'The selected control does not expose ExpandCollapsePattern.'};[void]$p.Expand()}
        'collapse' {$p=$null;if(-not $control.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$p)){throw 'The selected control does not expose ExpandCollapsePattern.'};[void]$p.Collapse()}
        default {throw 'operation must be invoke, select, toggle, expand, or collapse.'}
      }
      @{ok=$true;operation=[string]$A.operation;controlName=$name;controlType=$controlType;invoked=$true} | ConvertTo-Json -Depth 8 -Compress
      break
    }
    'set_value' {
      $window=Find-Window $A;$control=Find-Control $window $A;$p=$null
      if(-not $control.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$p)){throw 'The selected control does not expose ValuePattern. Inspect the control or focus it and use ui_send_keys.'}
      if($p.Current.IsReadOnly){throw 'The selected control is read-only.'}
      [void]$p.SetValue([string]$A.value)
      @{ok=$true;controlName=[string]$control.Current.Name;valueSet=$true;characters=([string]$A.value).Length} | ConvertTo-Json -Depth 8 -Compress
      break
    }
    'send_keys' {
      $window=Find-Window $A;$target=$window
      if($A.controlName -or $A.automationId -or $A.controlType){$target=Find-Control $window $A}
      [void]$target.SetFocus();Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.SendKeys]::SendWait([string]$A.keys)
      @{ok=$true;keysSent=[string]$A.keys;targetName=[string]$target.Current.Name;focused=$true;note='Keyboard input was sent after focusing the selected window/control.'} | ConvertTo-Json -Depth 8 -Compress
      break
    }
    default {throw 'Unknown Windows UI automation action.'}
  }
} catch { @{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Depth 8 -Compress }
`;

function validateArgs(action, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('Windows UI automation arguments must be an object.');
  const hasWindow = Boolean(args.windowTitle || args.processName || Number.isInteger(args.processId) || Number.isInteger(args.windowHandle));
  if (['inspect_window', 'invoke_control', 'set_value', 'send_keys'].includes(action) && !hasWindow) throw new Error('Specify windowTitle, processName, processId, or windowHandle.');
  if (['invoke_control', 'set_value'].includes(action) && !(args.controlName || args.automationId || args.controlType)) throw new Error('Specify controlName, automationId, or controlType.');
  if (action === 'send_keys' && !(typeof args.keys === 'string' && args.keys.length > 0)) throw new Error('keys must be a non-empty SendKeys expression.');
  if (action === 'set_value' && typeof args.value !== 'string') throw new Error('value must be a string.');
  if (args.windowTitle !== undefined && (typeof args.windowTitle !== 'string' || !args.windowTitle.length || args.windowTitle.length > 300)) throw new Error('windowTitle must be 1–300 characters.');
  if (args.processName !== undefined && (typeof args.processName !== 'string' || !args.processName.length || args.processName.length > 120)) throw new Error('processName must be 1–120 characters.');
  if (args.controlName !== undefined && (typeof args.controlName !== 'string' || args.controlName.length > 500)) throw new Error('controlName must be at most 500 characters.');
  if (args.automationId !== undefined && (typeof args.automationId !== 'string' || args.automationId.length > 300)) throw new Error('automationId must be at most 300 characters.');
  if (args.controlType !== undefined && (typeof args.controlType !== 'string' || args.controlType.length > 100)) throw new Error('controlType must be at most 100 characters.');
  if (args.value !== undefined && (typeof args.value !== 'string' || args.value.length > 4000)) throw new Error('value must be a string of at most 4,000 characters.');
  if (args.keys !== undefined && (typeof args.keys !== 'string' || args.keys.length > 4000)) throw new Error('keys must be at most 4,000 characters.');
  if (args.occurrence !== undefined && (!Number.isInteger(args.occurrence) || args.occurrence < 0 || args.occurrence > 5000)) throw new Error('occurrence must be a zero-based integer from 0 to 5000.');
}

function runWindowsUiAutomation(action, args = {}) {
  if (process.platform !== 'win32') return Promise.reject(new Error('Windows UI automation is available only on Windows.'));
  try { validateArgs(action, args); } catch (error) { return Promise.reject(error); }
  const payload = {
    ...args, action, includeUntitled: args.includeUntitled === true,
    maxResults: Number.isInteger(args.maxResults) ? args.maxResults : 50,
    maxDepth: Number.isInteger(args.maxDepth) ? args.maxDepth : 6,
    maxElements: Number.isInteger(args.maxElements) ? args.maxElements : 250,
    timeoutMs: Number.isInteger(args.timeoutMs) ? Math.min(Math.max(args.timeoutMs, 1000), MAX_TIMEOUT_MS) : 15000,
    containsTitle: args.containsTitle === true, containsName: args.containsName === true,
    occurrence: Number.isInteger(args.occurrence) ? args.occurrence : null,
    processId: Number.isInteger(args.processId) ? args.processId : null,
    windowHandle: Number.isInteger(args.windowHandle) ? args.windowHandle : null
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  if (encoded.length > MAX_ARGUMENTS) return Promise.reject(new Error('Windows UI automation arguments exceed the supported size.'));
  const command = '$A = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(\'' + encoded + '\')) | ConvertFrom-Json\n' + SCRIPT;
  const exe = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
  const timeoutMs = payload.timeoutMs + 5000;
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = []; let outBytes = 0, errBytes = 0, settled = false;
    const append = (arr, chunk, current, cap) => { const room = Math.max(0, cap - current); if (room) arr.push(chunk.subarray(0, room)); return current + chunk.length; };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Windows UI automation timed out after ' + timeoutMs + ' ms.')); }, timeoutMs);
    function finish(error, value) { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value); }
    child.stdout.on('data', chunk => { outBytes = append(out, chunk, outBytes, MAX_OUTPUT); });
    child.stderr.on('data', chunk => { errBytes = append(err, chunk, errBytes, 16000); });
    child.once('error', error => finish(new Error('Could not start PowerShell UI automation: ' + error.message)));
    child.once('close', code => {
      if (settled) return;
      const stdout = Buffer.concat(out).toString('utf8').trim(), stderr = Buffer.concat(err).toString('utf8').trim();
      if (code !== 0 && !stdout) return finish(new Error(stderr || ('PowerShell UI automation exited with code ' + code + '.')));
      let result; try { result = JSON.parse(stdout); } catch { return finish(new Error('PowerShell UI automation returned invalid JSON. ' + (stderr || stdout.slice(0, 800))); }
      if (result && result.ok === false) return finish(new Error(String(result.error || 'Windows UI automation failed.')));
      if (outBytes > MAX_OUTPUT) result.outputTruncated = true;
      if (errBytes) result.stderr = stderr.slice(0, 4000);
      finish(null, result);
    });
  });
}

module.exports = { runWindowsUiAutomation, validateArgs };
