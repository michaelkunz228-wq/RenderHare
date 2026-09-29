# Render Hare — fire Premiere's own Clip > Render and Replace / Restore
# Unrendered on Windows.
#
# Premiere's menu bar is a native Win32 menu, so the item is found by its label
# (every language Premiere ships, from ../locales/menu-strings.json) and the
# command is posted to the main window as WM_COMMAND — the same as clicking it.
#
# -WaitSeconds N: afterwards, wait (up to N s) for the dialogs the command opens
# to appear and all close again. Dialogs are spotted as new titled windows of
# the Premiere process, so this works in any UI language.
#
# Prints one JSON line: { ok, command, id, label, grayed, dialogSeen, finished }
# | { ok: false, error }.
param(
    [Parameter(Mandatory = $true)][ValidateSet("renderAndReplace", "restoreUnrendered")][string]$Command,
    [int]$WaitSeconds = 0,
    [int]$ProcessId = 0
)
$ErrorActionPreference = "Stop"

Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class RhMenu {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr h);
    [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr m);
    [DllImport("user32.dll")] static extern IntPtr GetSubMenu(IntPtr m, int pos);
    [DllImport("user32.dll")] static extern uint GetMenuItemID(IntPtr m, int pos);
    [DllImport("user32.dll")] public static extern uint GetMenuState(IntPtr m, uint id, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetMenuString(IntPtr m, uint pos, StringBuilder s, int n, uint flags);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);

    static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }

    // Premiere's main window: visible, has a menu bar, title starts "Adobe Premiere".
    public static IntPtr MainWindow(uint pid) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, l) => {
            uint p; GetWindowThreadProcessId(h, out p);
            if ((pid == 0 || p == pid) && IsWindowVisible(h) && GetMenu(h) != IntPtr.Zero && Title(h).StartsWith("Adobe Premiere")) {
                found = h; return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    // Visible, titled top-level windows of main's process, other than main.
    public static List<long> Dialogs(IntPtr main) {
        uint pid; GetWindowThreadProcessId(main, out pid);
        var list = new List<long>();
        EnumWindows((h, l) => {
            uint p; GetWindowThreadProcessId(h, out p);
            if (p == pid && h != main && IsWindowVisible(h) && Title(h).Length > 0) list.Add(h.ToInt64());
            return true;
        }, IntPtr.Zero);
        return list;
    }

    // Menu label -> comparable key: drop mnemonics ("&", "(&R)"), accelerator
    // text after a tab, trailing dots/ellipsis; case-insensitive.
    public static string Norm(string s) {
        int tab = s.IndexOf('\t'); if (tab >= 0) s = s.Substring(0, tab);
        s = System.Text.RegularExpressions.Regex.Replace(s, @"\(&.\)", "");
        s = s.Replace("&", "").Trim();
        while (s.EndsWith(".") || s.EndsWith("…")) s = s.Substring(0, s.Length - 1);
        return s.Trim().ToLowerInvariant();
    }

    // Depth-first search for a command item whose label matches one of targets.
    public static uint Find(IntPtr menu, HashSet<string> targets, out IntPtr owner, out string label) {
        owner = IntPtr.Zero; label = null;
        int n = GetMenuItemCount(menu);
        for (int i = 0; i < n; i++) {
            IntPtr sub = GetSubMenu(menu, i);
            if (sub != IntPtr.Zero) {
                uint id = Find(sub, targets, out owner, out label);
                if (id != 0) return id;
                continue;
            }
            var s = new StringBuilder(256); GetMenuString(menu, (uint)i, s, 256, 0x400);
            if (targets.Contains(Norm(s.ToString()))) { owner = menu; label = s.ToString(); return GetMenuItemID(menu, i); }
        }
        return 0;
    }
}
"@

function Out-Json($o) { $o | ConvertTo-Json -Compress }

try {
    $hwnd = [RhMenu]::MainWindow([uint32]$ProcessId)
    if ($hwnd -eq [IntPtr]::Zero -and $ProcessId -ne 0) { $hwnd = [RhMenu]::MainWindow(0) }
    if ($hwnd -eq [IntPtr]::Zero) { Out-Json @{ ok = $false; error = "Premiere's main window wasn't found." }; exit 1 }

    $strings = Get-Content (Join-Path $PSScriptRoot "..\locales\menu-strings.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $targets = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($p in $strings.$Command.PSObject.Properties) { [void]$targets.Add([RhMenu]::Norm([string]$p.Value)) }

    $owner = [IntPtr]::Zero; $label = $null
    $id = [RhMenu]::Find([RhMenu]::GetMenu($hwnd), $targets, [ref]$owner, [ref]$label)
    if ($id -eq 0) { Out-Json @{ ok = $false; error = "The menu item wasn't found (unsupported Premiere language or version)." }; exit 1 }

    $grayed = (([RhMenu]::GetMenuState($owner, $id, 0) -band 3) -ne 0)   # MF_GRAYED | MF_DISABLED
    $baseline = New-Object 'System.Collections.Generic.HashSet[long]'
    foreach ($w in [RhMenu]::Dialogs($hwnd)) { [void]$baseline.Add($w) }

    [void][RhMenu]::PostMessage($hwnd, 0x0111, [IntPtr][int]$id, [IntPtr]::Zero)   # WM_COMMAND

    function Test-NewDialog { foreach ($w in [RhMenu]::Dialogs($hwnd)) { if (-not $baseline.Contains($w)) { return $true } }; return $false }

    $seen = $false; $finished = $null
    if ($WaitSeconds -gt 0) {
        # Phase 1: a dialog should appear within a few seconds (none = no dialog).
        $deadline = (Get-Date).AddSeconds(4)
        while ((Get-Date) -lt $deadline) {
            if (Test-NewDialog) { $seen = $true; break }
            Start-Sleep -Milliseconds 250
        }
        # Phase 2: done once no new dialog has been open for 2 s straight
        # (bridges the gap between the settings dialog and the progress window).
        $finished = -not $seen
        if ($seen) {
            $deadline = (Get-Date).AddSeconds($WaitSeconds); $clearSince = $null
            while ((Get-Date) -lt $deadline) {
                if (Test-NewDialog) { $clearSince = $null }
                elseif (-not $clearSince) { $clearSince = Get-Date }
                elseif (((Get-Date) - $clearSince).TotalSeconds -ge 2) { $finished = $true; break }
                Start-Sleep -Milliseconds 500
            }
        }
    }
    Out-Json @{ ok = $true; command = $Command; id = $id; label = $label; grayed = $grayed; dialogSeen = $seen; finished = $finished }
} catch {
    Out-Json @{ ok = $false; error = $_.Exception.Message }
    exit 1
}
