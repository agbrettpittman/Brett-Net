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
- **Bulk host entry as a grid** — host, name, colour and TCP port in four
  columns, so a list pastes straight in from Excel or a CSV, and copies back out
  the same way. CIDR ranges expand.
- **TCP probe mode per host** — where ICMP is filtered, graph a host by opening
  a TCP port instead. A refusal is reported as its own state, since it proves
  the host is up.
- **History on disk** — every sample persists to SQLite, so restarting resumes
  the graph instead of starting blank. Configurable retention, and CSV export.
- **Traceroute** that streams hops as it finds them, names the network behind
  each public hop, and gives up on a filtered path when you tell it to.
- **DNS lookup and TCP port checks**, including full-range scans — and
  *refused* is reported separately from *no answer*, because a refusal proves
  the host is up.
- **Adapter info** — address, gateway, DNS, DHCP, MAC, MTU and link speed.
- **Live bandwidth per interface** — send and receive rates, session totals, and
  a chart with received above the line and sent below.
- **Keep awake / keep active** — block sleep, and optionally keep the session
  from locking, on a timer that releases itself.
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
  features/path/        traceroute
  features/dns/         DNS lookup and port checks
  features/adapters/    interface configuration and live bandwidth
  components/           host grid, editing, theme toggle, keep awake, update banner
  lib/                  series storage, aggregation, lanes, palette, CSV grid, IPC
src-tauri/
  src/icmp/             Windows ICMP FFI + backend trait
  src/monitor/          scheduler, DNS cache
  src/db/               history storage, retention, CSV export
  src/trace/            traceroute over the ICMP FFI
  src/probe/            name resolution and TCP port checks
  src/asn/              IP to network-operator lookup
  src/adapters/         GetAdaptersAddresses FFI
  src/awake/            SetThreadExecutionState, the keep-awake lock
  src/traffic/          GetIfTable2 FFI, per-interface byte counters
docs/                   setup, install, and release guides
```
