# Installing Brett-Net

Brett-Net is a network monitoring tool for Windows. It pings a list of hosts
continuously and graphs their latency, one line per host.

**You do not need administrator rights.** It installs into your own user
profile, not `Program Files`, so there is no UAC prompt and nothing to get
approved.

---

## Install

1. Get `Brett-Net_x.y.z_x64-setup.exe`.
2. Run it. See the warning below — it is expected.
3. Brett-Net appears in the Start menu.

### "Windows protected your PC"

You will almost certainly see this the first time:

> **Windows protected your PC**
> Microsoft Defender SmartScreen prevented an unrecognised app from starting.

Click **More info**, then **Run anyway**.

This is not a virus warning. SmartScreen shows it for any installer that has not
been signed with a commercial code-signing certificate, which costs a few
hundred dollars a year. Nothing is wrong with the file, and the warning stops
appearing once enough people have run it.

If your workplace blocks unsigned installers outright (AppLocker or a similar
policy), the install will fail rather than warn. That needs whoever manages your
machines — no version of this file will get around it.

---

## Using it

The app starts monitoring as soon as it opens, with three default hosts. It
keeps running until you close it.

| Control | What it does |
|---|---|
| **Stop / Start** | Pauses and resumes probing. Resuming clears the graph. |
| **Every** | How often each host is pinged, 250 ms to 5 s. |
| **Average** | Smooths the lines by averaging into buckets. Raw shows every sample. |
| **Span** | How much history the chart shows. |
| **Keep** | How long history is stored on disk. |
| **Export CSV** | Writes everything stored to your Downloads folder. |

**Adding hosts.** Click **+ Add hosts** and paste a list — IPs, hostnames, or a
CIDR range like `192.168.1.0/24`. Commas, spaces, and new lines all work. Write
`Name=target` to label one, e.g. `Gateway=192.168.1.1`.

**Editing.** Click a host's name in the table to change its name, target, or
colour. Click ✕ to remove it.

**Zooming.** Drag across the chart to zoom in. Double-click, or use **Reset
zoom**, to go back to following live data.

**Reading a failure.** A host that stops replying drops to a dashed line in the
band *below* the chart, so an outage is obvious rather than just being an
absent line. A solid segment connects the moment it failed and the moment it
came back.

---

## Tracing a path

The **Path** tab walks the route to a host, one line per router in between.

| Control | What it does |
|---|---|
| **Give up after** | Stops once this many hops in a row fail to answer. **Never** walks all 30, like `tracert`. |
| **Look up networks** | Names the operator behind each public hop. |

**`no reply` is normal.** Plenty of routers are configured not to answer, and
the trace carries straight on past them. Only an unbroken run of them means the
path is filtered — which is common on a corporate network and does *not* mean
anything is broken. Raise **Give up after**, or set it to Never, if you want to
keep pushing past it.

**Times are the best of three probes.** A router answering a ping does so
whenever it gets round to it, so a slow reply means a busy router rather than a
slow path. All three probes are shown so an intermittent hop is visible.

### What "Look up networks" sends

It asks `whois.cymru.com` (port 43) which network owns each hop, which is where
the `AS15169 GOOGLE` column comes from.

**Only public addresses are ever sent.** Private ranges (`10.x`, `192.168.x`,
`172.16–31.x`), loopback, link-local and carrier-grade NAT (`100.64–127.x`) are
filtered out before anything leaves the machine — so internal hops on your own
network stay internal. That is also why those rows show a blank network: it is
expected, not missing data.

Turn the checkbox off if you would rather nothing left the machine at all.
Everything else on the tab works the same either way, and if port 43 is blocked
the column is simply empty.

---

## Where your data lives

Both locations survive upgrades — installing a newer version keeps your hosts
and your history.

| What | Where |
|---|---|
| Hosts and chart settings | `%APPDATA%\net.brett.brettnet\settings.json` |
| Ping history | `%LOCALAPPDATA%\net.brett.brettnet\history.db` |

History defaults to 7 days and is capped at 256 MB regardless. To clear it,
close Brett-Net and delete `history.db`.

To move your hosts to another machine, copy `settings.json` across.

---

## If something looks wrong

**Every host shows as down, immediately.** Some networks and most VPNs block
ICMP echo entirely. Try `ping 8.8.8.8` in a terminal — if that fails too, it is
the network, not Brett-Net.

**One host is always slow but others are fine.** Many routers and public DNS
servers deprioritise ICMP, so a high ping to `8.8.8.8` does not necessarily mean
a slow connection. Compare against a host on your own network.

**Latency spikes on every host at the same moment.** That is your own link or
your machine, not the targets.

**The chart is empty after reopening.** History is only replayed if the gap
since the last sample is under five minutes. Longer than that and the chart
starts fresh — the data is still in the database and still exports.

**Settings would not load.** If `settings.json` is unreadable it is renamed to
`settings.json.bad` and defaults are used, so nothing is lost. The error appears
in the app.

---

## Uninstalling

Settings → Apps → Installed apps → Brett-Net → Uninstall.

That leaves your settings and history behind. Delete
`%APPDATA%\net.brett.brettnet` and `%LOCALAPPDATA%\net.brett.brettnet` to remove
those too.
