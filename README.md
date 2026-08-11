# Brett-Net

A network monitoring toolkit for Windows. Ping many hosts at once and watch
latency graphed live, one line per host.

## Status

Phase 0 — project scaffold. The app shell builds and runs; the ping engine
lands in Phase 1.

## Stack

- **[Tauri 2](https://v2.tauri.app)** (Rust core) — ships a ~6–10 MB installer
  and can call the Windows ICMP API directly, so pinging never needs
  administrator rights.
- **React 19 + TypeScript + Vite** — the UI.
- **[uPlot](https://github.com/leeoniya/uPlot)** — the live latency chart. It's
  the same library Grafana's time-series panel is built on.

## Getting started

See [docs/SETUP.md](docs/SETUP.md) for the one-time Windows toolchain setup,
then:

```powershell
npm install
npm run tauri dev
```

## Layout

```
src/              React app
  features/       one directory per tool (ping, path, dns, adapters)
  lib/            ring buffers, typed IPC wrappers
  store/          zustand state
src-tauri/        Rust core
  src/icmp/       Windows ICMP FFI + backend trait
  src/monitor/    scheduler and host registry
  src/commands/   the #[tauri::command] surface
docs/             setup and install guides
```
