'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const MAX_UIA_NODES = 120;
const MAX_UIA_CONTROLS = 80;
const UIA_TIMEOUT_MS = 6500;

function validSize(value) {
  return Number.isInteger(value) && value > 0 && value <= 16384;
}

function safeText(value, limit = 160) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, limit) : '';
}

function rectForFrame(rawRect, screen, frame) {
  if (!Array.isArray(rawRect) || rawRect.length !== 4 ||
      !rawRect.every(value => Number.isFinite(value)) ||
      !validSize(screen.width) || !validSize(screen.height) ||
      !validSize(frame.width) || !validSize(frame.height)) return null;
  let [left, top, right, bottom] = rawRect;
  if (right <= left || bottom <= top || right <= 0 || bottom <= 0 ||
      left >= screen.width || top >= screen.height) return null;
  left = Math.max(0, Math.min(screen.width, left));
  top = Math.max(0, Math.min(screen.height, top));
  right = Math.max(0, Math.min(screen.width, right));
  bottom = Math.max(0, Math.min(screen.height, bottom));
  const xScale = frame.width / screen.width;
  const yScale = frame.height / screen.height;
  const bbox = [
    Math.max(0, Math.floor(left * xScale)),
    Math.max(0, Math.floor(top * yScale)),
    Math.min(frame.width, Math.ceil(right * xScale)),
    Math.min(frame.height, Math.ceil(bottom * yScale))
  ];
  if (bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) return null;
  return {
    bbox_screen_px: rawRect.map(value => Math.round(value * 100) / 100),
    bbox_1000: [
      Math.round(bbox[0] / frame.width * 1000),
      Math.round(bbox[1] / frame.height * 1000),
      Math.round(bbox[2] / frame.width * 1000),
      Math.round(bbox[3] / frame.height * 1000)
    ],
    bbox_px: bbox,
    center_px: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]
  };
}

function normalizeUiaElement(element, screen, frame, index = 0) {
  if (!element || typeof element !== 'object') return null;
  const role = safeText(element.role || element.control_type || 'unknown', 40).replace(/^ControlType\./, '');
  // UI Automation Edit names can expose entered text. Never forward text-field contents.
  const name = role.toLowerCase() === 'edit' || role.toLowerCase() === 'password'
    ? '' : safeText(element.name || element.label, 120);
  const box = rectForFrame(element.bbox_screen_px || element.bounds || element.bounding_rectangle, screen, frame);
  if (!box || (!name && !element.automation_id && !['Edit', 'Password', 'Document'].includes(role))) return null;
  return {
    id: 'uia-' + String(index + 1),
    label: name || (['Edit', 'Password'].includes(role) ? 'Text input (value not read)' : ''),
    role,
    automation_id: safeText(element.automation_id, 100),
    class_name: safeText(element.class_name, 100),
    enabled: typeof element.enabled === 'boolean' ? element.enabled : null,
    focused: element.focused === true,
    source: 'windows_uia',
    grounding: 'windows_accessibility_bounds',
    ...box
  };
}

function normalizeSnapshotForFrame(raw, screen, frame) {
  if (!raw || raw.available !== true) {
    return {
      available: false,
      source: 'windows_uia',
      reason: safeText(raw && raw.reason || 'unavailable', 100)
    };
  }
  if (!screen || !frame || !validSize(screen.width) || !validSize(screen.height) ||
      !validSize(frame.width) || !validSize(frame.height)) {
    return { available: false, source: 'windows_uia', reason: 'invalid_frame_dimensions' };
  }
  const activeWindowRaw = raw.active_window && typeof raw.active_window === 'object' ? raw.active_window : null;
  let activeWindow = null;
  if (activeWindowRaw) {
    const box = rectForFrame(activeWindowRaw.bbox_screen_px || activeWindowRaw.bounds, screen, frame);
    if (box) activeWindow = {
      title: safeText(activeWindowRaw.title, 160),
      process_id: Number.isInteger(activeWindowRaw.process_id) ? activeWindowRaw.process_id : null,
      source: 'windows_uia',
      ...box
    };
  }
  const focusedRaw = raw.focused_control && typeof raw.focused_control === 'object' ? raw.focused_control : null;
  const focused = focusedRaw ? normalizeUiaElement({ ...focusedRaw, focused: true }, screen, frame, 0) : null;
  const rawControls = Array.isArray(raw.controls) ? raw.controls.slice(0, MAX_UIA_NODES) : [];
  let cursor = null;
  const cursorPoint = raw.cursor_screen_px;
  if (Array.isArray(cursorPoint) && cursorPoint.length === 2 &&
      cursorPoint.every(Number.isFinite) &&
      cursorPoint[0] >= 0 && cursorPoint[0] < screen.width &&
      cursorPoint[1] >= 0 && cursorPoint[1] < screen.height) {
    const x = Math.max(0, Math.min(frame.width - 1, Math.round(cursorPoint[0] * frame.width / screen.width)));
    const y = Math.max(0, Math.min(frame.height - 1, Math.round(cursorPoint[1] * frame.height / screen.height)));
    cursor = {
      x_screen_px: Math.round(cursorPoint[0] * 100) / 100,
      y_screen_px: Math.round(cursorPoint[1] * 100) / 100,
      x_px: x, y_px: y, source: 'windows_native_cursor',
      coordinate_space: 'screenshot_jpeg_px'
    };
  }
  const controls = rawControls.map((item, index) => normalizeUiaElement(item, screen, frame, index))
    .filter(Boolean).slice(0, MAX_UIA_CONTROLS);
  return {
    available: true,
    source: 'windows_uia',
    coordinate_space: 'screenshot_jpeg_px',
    active_window: activeWindow,
    focused_control: focused,
    controls,
    cursor,
    truncated: raw.truncated === true,
    node_count: Number.isInteger(raw.node_count) ? Math.max(0, raw.node_count) : rawControls.length
  };
}

const POWERSHELL_SNAPSHOT = "$ErrorActionPreference = 'Stop'\nAdd-Type -AssemblyName UIAutomationClient\nAdd-Type -AssemblyName UIAutomationTypes\nAdd-Type -TypeDefinition @'\nusing System;\nusing System.Text;\nusing System.Runtime.InteropServices;\npublic struct WRBPOINT { public int X; public int Y; }\npublic static class WRBForegroundNative {\n  [DllImport(\"user32.dll\")] public static extern bool GetCursorPos(out WRBPOINT point);\n  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();\n  [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);\n  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);\n}\n'@\n$hwnd = [WRBForegroundNative]::GetForegroundWindow()\n[uint32]$foregroundPid = 0\n[void][WRBForegroundNative]::GetWindowThreadProcessId($hwnd, [ref]$foregroundPid)\n$titleBuilder = New-Object System.Text.StringBuilder 512\n[void][WRBForegroundNative]::GetWindowText($hwnd, $titleBuilder, $titleBuilder.Capacity)\n$foregroundTitle = $titleBuilder.ToString()\n$cursorPoint = New-Object WRBPOINT\n$cursorScreen = $null\ntry { if ([WRBForegroundNative]::GetCursorPos([ref]$cursorPoint)) { $cursorScreen = @([int]$cursorPoint.X, [int]$cursorPoint.Y) } } catch {}\n$active = $null\ntry {\n  if ($hwnd -ne [IntPtr]::Zero) {\n    $active = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)\n  }\n} catch {}\nfunction Get-Rect($element) {\n  try {\n    $r = $element.Current.BoundingRectangle\n    if ($r.Width -gt 0 -and $r.Height -gt 0) {\n      return @([double]$r.Left, [double]$r.Top, [double]$r.Right, [double]$r.Bottom)\n    }\n  } catch {}\n  return $null\n}\nfunction Get-Name($element, $role) {\n  if ($role -eq 'Edit' -or $role -eq 'Password') { return '' }\n  try {\n    $value = [string]$element.Current.Name\n    return $value.Substring(0, [Math]::Min(120, $value.Length))\n  } catch { return '' }\n}\n$activeWindow = $null\n$items = New-Object System.Collections.ArrayList\n$visited = 0\n$truncated = $false\nif ($null -ne $active) {\n  $activeRect = Get-Rect $active\n  $activeWindow = @{\n    title = $foregroundTitle\n    process_id = [int]$foregroundPid\n    bbox_screen_px = $activeRect\n  }\n  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker\n  $queue = New-Object 'System.Collections.Generic.Queue[object]'\n  $queue.Enqueue([pscustomobject]@{ Element = $active; Depth = 0 })\n  $wantedRoles = @('Button','Edit','Password','CheckBox','RadioButton','TabItem','ComboBox','ListItem','MenuItem','Hyperlink','Slider','Spinner','TreeItem','DataItem','Text','Document','Pane','Group','Window','SplitButton')\n  while ($queue.Count -gt 0 -and $visited -lt 120 -and $items.Count -lt 80) {\n    $entry = $queue.Dequeue()\n    $element = $entry.Element\n    $depth = [int]$entry.Depth\n    $visited++\n    try {\n      $current = $element.Current\n      $role = ([string]$current.ControlType.ProgrammaticName).Replace('ControlType.','')\n      $name = Get-Name $element $role\n      $rect = Get-Rect $element\n      $offscreen = [bool]$current.IsOffscreen\n      if (-not $offscreen -and $null -ne $rect -and $wantedRoles -contains $role -and\n          ($name.Length -gt 0 -or $role -eq 'Edit' -or $role -eq 'Document')) {\n        [void]$items.Add(@{\n          name = $name\n          role = $role\n          automation_id = [string]$current.AutomationId\n          class_name = [string]$current.ClassName\n          enabled = [bool]$current.IsEnabled\n          focused = [bool]$current.HasKeyboardFocus\n          bbox_screen_px = $rect\n        })\n      }\n      if ($depth -lt 6) {\n        $child = $walker.GetFirstChild($element)\n        while ($null -ne $child -and ($queue.Count + $visited) -lt 220) {\n          $queue.Enqueue([pscustomobject]@{ Element = $child; Depth = $depth + 1 })\n          $child = $walker.GetNextSibling($child)\n        }\n      }\n    } catch {}\n  }\n  $truncated = ($queue.Count -gt 0 -or $visited -ge 120 -or $items.Count -ge 80)\n}\n$focusedControl = $null\ntry {\n  $focus = [System.Windows.Automation.AutomationElement]::FocusedElement\n  if ($null -ne $focus) {\n    $focusCurrent = $focus.Current\n    $focusRole = ([string]$focusCurrent.ControlType.ProgrammaticName).Replace('ControlType.','')\n    $focusedControl = @{\n      name = Get-Name $focus $focusRole\n      role = $focusRole\n      automation_id = [string]$focusCurrent.AutomationId\n      class_name = [string]$focusCurrent.ClassName\n      enabled = [bool]$focusCurrent.IsEnabled\n      focused = $true\n      bbox_screen_px = Get-Rect $focus\n    }\n  }\n} catch {}\n@{\n  available = $true\n  active_window = $activeWindow\n  focused_control = $focusedControl\n  controls = @($items.ToArray())\n  cursor_screen_px = $cursorScreen\n  truncated = $truncated\n  node_count = $visited\n} | ConvertTo-Json -Depth 6 -Compress";

async function captureWindowsUiAutomationSnapshot(options = {}) {
  if (process.platform !== 'win32') {
    return { available: false, source: 'windows_uia', reason: 'unsupported_platform' };
  }
  const screen = options.screen || {};
  const frame = options.frame || {};
  if (!validSize(screen.width) || !validSize(screen.height) ||
      !validSize(frame.width) || !validSize(frame.height)) {
    return { available: false, source: 'windows_uia', reason: 'invalid_frame_dimensions' };
  }
  try {
    const encoded = Buffer.from(POWERSHELL_SNAPSHOT, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
    ], { windowsHide: true, timeout: UIA_TIMEOUT_MS, maxBuffer: 512 * 1024 });
    const raw = JSON.parse(String(stdout || '').trim());
    return normalizeSnapshotForFrame(raw, screen, frame);
  } catch (error) {
    const timedOut = error && (error.code === 'ETIMEDOUT' || error.killed);
    return {
      available: false,
      source: 'windows_uia',
      reason: timedOut ? 'uia_timeout' : 'uia_unavailable'
    };
  }
}

module.exports = {
  captureWindowsUiAutomationSnapshot,
  normalizeSnapshotForFrame,
  rectForFrame
};
