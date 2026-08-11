# Developer setup (Windows)

One-time setup to build Brett-Net. Everything below runs as your normal user —
**none of it needs administrator rights** except the Visual Studio Build Tools
installer, which may prompt once.

The repo lives at `C:\Users\agbre\code\Brett-Net`. Build from the Windows
filesystem, not from `\\wsl$\...` — Cargo does a huge amount of small-file I/O
and building across the WSL boundary is dramatically slower, with unreliable
hot-reload.

The fastest path is winget. Steps 1 and 3 install per-user and never prompt for
admin; step 2 elevates once.

## 1. Rust

```powershell
winget install --id Rustlang.Rustup --accept-package-agreements --accept-source-agreements
```

Installs to `%USERPROFILE%\.cargo\bin` with the
`stable-x86_64-pc-windows-msvc` toolchain, plus clippy and rustfmt.

## 2. Visual Studio Build Tools

Rust's MSVC toolchain needs the Microsoft linker. This is the big one — roughly
5–7 GB — and it **requires admin**, so expect one UAC prompt.

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools `
  --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended" `
  --accept-package-agreements --accept-source-agreements
```

`--includeRecommended` pulls in the Windows SDK, which Rust also needs. If you'd
rather use the GUI, download [Build Tools for Visual Studio](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022)
and tick the **"Desktop development with C++"** workload.

## 3. Node.js

```powershell
winget install --id OpenJS.NodeJS.LTS --scope user --accept-package-agreements --accept-source-agreements
```

`--scope user` avoids the admin prompt. This is separate from any Node inside
WSL — Tauri uses the Windows one.

> **Restart your terminal (and VS Code) after installing.** winget updates the
> `PATH` environment variable, but already-open shells keep their old copy, so
> `node` and `cargo` will appear missing until you reopen them.

## 4. Defender exclusion (strongly recommended)

Real-time scanning of Rust's build directory makes compiles crawl, because
Cargo writes thousands of small files. Add an exclusion:

**Windows Security → Virus & threat protection → Manage settings →
Exclusions → Add an exclusion → Folder**

```
C:\Users\agbre\code\Brett-Net\src-tauri\target
```

Or from an **elevated** PowerShell:

```powershell
Add-MpPreference -ExclusionPath "C:\Users\agbre\code\Brett-Net\src-tauri\target"
```

This matters more than it sounds. Without it, `npm install` alone took nine
minutes on this machine, and Cargo writes far more files than npm does.

## 5. Verify

Open **Windows Terminal** (not WSL) and run:

```powershell
cd C:\Users\agbre\code\Brett-Net
rustc --version
node --version
npm install
npm run tauri dev
```

A window titled **Brett-Net** should open showing your hostname, OS, and app
version. That confirms the whole chain works: Vite builds the frontend, Cargo
builds the Rust core, and IPC between them is wired up.

The first `npm run tauri dev` compiles all Rust dependencies from scratch and
takes several minutes. Later runs are incremental and start in seconds.

## Building an installer

```powershell
npm run tauri build
```

Output: `src-tauri\target\release\bundle\nsis\Brett-Net_0.1.0_x64-setup.exe`

The installer uses NSIS `currentUser` mode, so it installs to `%LOCALAPPDATA%`
with no UAC prompt — that's what makes it safe to hand to coworkers who don't
have local admin.

## Troubleshooting

**`link.exe not found`** — the Build Tools C++ workload didn't install. Re-run
the installer and confirm "Desktop development with C++" is checked.

**`error: Microsoft Visual C++ 14.0 or greater is required`** — same cause.

**Vite port 1420 already in use** — a previous `tauri dev` is still running.
Close it, or `Get-Process node | Stop-Process`.

**Rust builds are extremely slow** — the Defender exclusion in step 4 is missing.
