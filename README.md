# Brett-Net

A network monitoring toolkit for Windows. Ping many hosts at once and watch
latency graphed live, one line per host.

Installs per-user with no administrator rights, and the installer is under
2 MB.

**Just want to run it?** See [docs/INSTALL.md](docs/INSTALL.md).

## What it does

- **Live latency chart** — one line per host, curved, with selectable probe
  rate, averaging interval, and visible time span. Drag to zoom.
- **Failures are visible, not absent.** A host that stops replying drops to a
  dashed lane below the chart, stacked so several outages never overlap, with a
  solid connector marking exactly when it failed and recovered.
- **Bulk host entry** — paste IPs, hostnames, or CIDR ranges; `Name=target` to
  label one.
- **History on disk** — every sample persists to SQLite, so restarting resumes
  the graph instead of starting blank. Configurable retention, and CSV export.
- **No administrator rights**, for either installing or pinging.

## Stack

- **[Tauri 2](https://v2.tauri.app)** (Rust core) — small installer, and it can
  call the Windows ICMP API directly, so pinging never needs elevation.
- **React 19 + TypeScript + Vite** — the UI.
- **[uPlot](https://github.com/leeoniya/uPlot)** — the live chart. The same
  library Grafana's time-series panel is built on.
- **SQLite** via `rusqlite`, compiled in — nothing to install separately.

Pinging goes through `IcmpSendEcho2` in `iphlpapi.dll`, called over FFI. That is
the only way to send ICMP on Windows without being an administrator: raw sockets
are restricted to the Administrators group. It is hand-rolled rather than taken
from a crate because the maintained options discard the *responding* address,
which traceroute needs.

## Getting started

See [docs/SETUP.md](docs/SETUP.md) for the one-time Windows toolchain setup,
then:

```powershell
npm install
npm run tauri dev
```

## Checks

```powershell
npm run typecheck
npx vitest run
cd src-tauri; cargo test --lib
cd src-tauri; cargo clippy --lib --tests -- -D warnings
```

Tests that launch the app must set `BRETT_NET_DATA_DIR` to a scratch directory,
or they will overwrite the real host list:

```powershell
$env:BRETT_NET_DATA_DIR = "$env:TEMP\brett-net-scratch"
```

## Releasing

See [docs/RELEASING.md](docs/RELEASING.md), including how to activate the
updater, which ships wired but dormant.

## Layout

```
src/                    React app
  features/ping/        the latency chart
  components/           host entry, editing, theme toggle, update banner
  lib/                  series storage, aggregation, lanes, palette, IPC
src-tauri/
  src/icmp/             Windows ICMP FFI + backend trait
  src/monitor/          scheduler, DNS cache
  src/db/               history storage, retention, CSV export
docs/                   setup, install, and release guides
```
