import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Windows-only native file/folder picker. Shells out to PowerShell so the
// dialog renders as a real Windows Explorer window; the user picks (or
// cancels); we capture the path on stdout. Non-Windows platforms get a
// typed `platform_not_supported` response so the UI can fall back to the
// typed-path input.

export type PickKind = 'folder' | 'rom-or-archive';

export interface PickResult {
  readonly kind: PickKind;
  /** Absolute path if the user picked something; null on cancel. */
  readonly path: string | null;
  /** Set when the picker can't run on this platform. UI falls back. */
  readonly error?: 'platform_not_supported' | 'picker_failed';
  readonly message?: string;
}

// Both scripts host the dialog inside a hidden, TopMost, off-screen Form so
// the dialog is GUARANTEED to appear in front of the browser even though
// we spawn PowerShell with `windowsHide: true` (no console window to be the
// natural parent). Without this, the OpenFileDialog opens behind the browser
// + the click handler stays in "Picking…" forever waiting for the user to
// alt-tab to a window they can't see.
//
// UseDescriptionForTitle is intentionally NOT used - it requires .NET
// Framework 4.6.2+, and PowerShell 5.1 on Windows 10 may load an older
// System.Windows.Forms assembly version that lacks it.

const PS_FOLDER_SCRIPT = `
$ErrorActionPreference = "Stop"
# Force stdout to UTF-8 so paths containing non-ASCII characters (e.g. é
# in "Pokémon Unbound") round-trip cleanly to the Node parent. Without this
# PowerShell writes stdout in the system OEM codepage and the bytes get
# mangled on the way back.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$parent = New-Object System.Windows.Forms.Form
$parent.TopMost = $true
$parent.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
$parent.ShowInTaskbar = $false
$parent.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$parent.Location = New-Object System.Drawing.Point(-32000, -32000)
$parent.Show()
try {
    $d = New-Object System.Windows.Forms.FolderBrowserDialog
    $d.Description = "Pick a project folder"
    $d.ShowNewFolderButton = $false
    if ($d.ShowDialog($parent) -eq [System.Windows.Forms.DialogResult]::OK) {
        Write-Output $d.SelectedPath
    }
} finally {
    $parent.Close()
    $parent.Dispose()
}
`.trim();

const PS_FILE_SCRIPT = `
$ErrorActionPreference = "Stop"
# Force stdout to UTF-8 so paths containing non-ASCII characters (e.g. é
# in "Pokémon Unbound") round-trip cleanly to the Node parent. Without this
# PowerShell writes stdout in the system OEM codepage and the bytes get
# mangled on the way back.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$parent = New-Object System.Windows.Forms.Form
$parent.TopMost = $true
$parent.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
$parent.ShowInTaskbar = $false
$parent.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$parent.Location = New-Object System.Drawing.Point(-32000, -32000)
$parent.Show()
try {
    $d = New-Object System.Windows.Forms.OpenFileDialog
    $d.Title = "Pick a GBA ROM or ZIP archive"
    $d.Filter = "GBA ROM or ZIP (*.gba;*.zip)|*.gba;*.zip|GBA ROM (*.gba)|*.gba|ZIP archive (*.zip)|*.zip|All files (*.*)|*.*"
    $d.CheckFileExists = $true
    $d.Multiselect = $false
    if ($d.ShowDialog($parent) -eq [System.Windows.Forms.DialogResult]::OK) {
        Write-Output $d.FileName
    }
} finally {
    $parent.Close()
    $parent.Dispose()
}
`.trim();

interface PickerDeps {
  readonly platform: NodeJS.Platform;
  readonly spawnFn: typeof spawn;
}

const DEFAULT_DEPS: PickerDeps = { platform: process.platform, spawnFn: spawn };

export async function pickPath(
  kind: PickKind,
  deps: PickerDeps = DEFAULT_DEPS,
): Promise<PickResult> {
  if (deps.platform !== 'win32') {
    return {
      kind,
      path: null,
      error: 'platform_not_supported',
      message: `Native file picker is only wired up on Windows; current platform is '${deps.platform}'. Paste the path into the text input instead.`,
    };
  }

  const script = kind === 'folder' ? PS_FOLDER_SCRIPT : PS_FILE_SCRIPT;

  // Write the PowerShell script to a temp file and invoke it via -File
  // rather than -Command. -Command with a multi-line script embedded in argv
  // is fragile (Windows quoting rules clip newlines and special chars);
  // -File <path> is the well-defined, robust path for any non-trivial script.
  const scriptPath = path.join(tmpdir(), `rom-editor-picker-${randomUUID()}.ps1`);
  let tempWritten = false;
  try {
    // Prepend the UTF-8 BOM (EF BB BF) so PowerShell parses the .ps1 file
    // as UTF-8 instead of the host's default CP1252. Without the BOM, a
    // string literal like "Pokémon" in the script would be misread on
    // load and the path round-trip would corrupt.
    const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
    await fsp.writeFile(scriptPath, Buffer.concat([BOM, Buffer.from(script, 'utf-8')]));
    tempWritten = true;
  } catch (e) {
    return {
      kind,
      path: null,
      error: 'picker_failed',
      message: `Could not stage picker script: ${(e as Error).message}`,
    };
  }

  return new Promise<PickResult>((resolve) => {
    const child = deps.spawnFn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', scriptPath],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let err = '';
    child.stdout?.on('data', (b) => { out += b.toString(); });
    child.stderr?.on('data', (b) => { err += b.toString(); });
    const cleanup = async () => {
      if (tempWritten) {
        try { await fsp.unlink(scriptPath); } catch { /* best-effort */ }
      }
    };
    child.on('error', async (e) => {
      await cleanup();
      resolve({
        kind,
        path: null,
        error: 'picker_failed',
        message: `Could not spawn PowerShell: ${e.message}`,
      });
    });
    child.on('exit', async (code) => {
      await cleanup();
      if (code !== 0) {
        resolve({
          kind,
          path: null,
          error: 'picker_failed',
          message: err.trim() || `PowerShell exited with code ${code}`,
        });
        return;
      }
      const picked = out.trim();
      resolve({ kind, path: picked.length > 0 ? picked : null });
    });
  });
}
