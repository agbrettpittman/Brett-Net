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

**Keeping the PC awake.** Top right, next to the theme buttons, there's a
dropdown with three settings — useful during a long download or a transfer you
don't want interrupted.

| Setting | What it does |
|---|---|
| **Off** | Normal power behaviour. |
| **Keep awake** | Stops the PC sleeping. The screen can still switch off, and the session can still lock. |
| **Keep active** | Also stops the session going idle, so it doesn't lock either. |

**Keep awake is enough for a download.** Locking doesn't pause anything —
transfers, copies and background jobs all carry on behind the lock screen.
Sleeping is the thing that interrupts them, and that's what this blocks.

**Keep active** is for when you need the session to stay unlocked. It works by
sending a single harmless keystroke — F15, a key no physical keyboard has, so
nothing is bound to it and it can't type anything. It only fires after a full
minute with no input of your own, so it never interferes while you're using the
machine; the moment you touch the keyboard or mouse it goes quiet again. Once
the PC has actually locked it can't do anything, so it prevents locking rather
than undoing it.

**There's always a time limit.** It defaults to 5 minutes and goes up to 8
hours, with **No limit** last if you really want it. When the timer runs out it
releases itself, and the remaining time is shown beside the dropdown. Nothing is
remembered between runs either — so it can't quietly keep a laptop awake in a
bag.

**Adding hosts.** Click **+ Add hosts** for a small spreadsheet with four
columns:

| Column | Meaning |
|---|---|
| **Host** | An IP, a hostname, or a CIDR range like `192.168.1.0/24`, which expands to every address in it. The only required column. |
| **Name** | What to call it. Defaults to the host. |
| **Colour** | A hex colour like `#4f8ef7`, or click the swatch to pick one. Blank picks one for you. |
| **TCP port** | Leave empty to ping. Fill it in to check that port instead — see *When ping is blocked*, below. |

Type across it with **Comma** or **Tab** to move between boxes, and **Enter** to
drop down a row. A new blank row appears as you fill the last one.

**Pasting a list is the fast way.** Copy a block of cells straight out of Excel
and paste it in, or open a CSV in Notepad and paste that — either works, and a
header row like `host,name,color,port` is recognised and skipped. Whatever cell
you paste into is where the block starts, so you can paste just a column of
names into the Name field if that is all you have. A plain list of addresses,
one per line, still works exactly as before.

**Sharing a list.** **Copy hosts** puts your whole list on the clipboard in that
same four-column CSV, ready to paste into Excel or send to a colleague who can
paste it straight back into their own grid.

**Editing.** Click a host's name in the table to change its name, target,
colour, or how it is probed. Click ✕ to remove it.

**When ping is blocked.** Some networks and most VPNs drop ICMP, which makes
every host look permanently down. Edit the host and switch **Probe with** from
*Ping* to *TCP port* — it opens a connection to that port instead, and graphs
how long the handshake took. Those rows are marked `TCP 443` in the table.

Two things to know. A handshake is slower than a ping on the same path, so a TCP
row sits above the others on the chart; that is the measurement, not the network.
And if the port turns out to have nothing listening, the row reads **Refused —
host is up** in amber rather than red: the check failed, but you have learned the
machine is alive, and it is usually a sign to pick a different port.

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

## DNS and ports

**Look up** resolves a name and lists every address it points at, in the order a
client would try them. The first is flagged, because that is the one that will
actually be used.

**Check ports** tries a TCP connection to each port you list. Ranges work:
`80, 443, 8000-8010`, and the presets go up to the whole port space.

| Result | What it means |
|---|---|
| **Open** | Something is listening. |
| **Refused** | Nothing is listening — **but the host answered**, so it is up. |
| **No answer** | Nothing came back. A firewall is dropping it, or the host is down. |

The Refused/No answer distinction is the useful part: a refusal proves the
machine is alive even though that particular service is not.

**A refusal is not always fast.** It can take a couple of seconds to arrive, so
if everything reads *No answer* on a host you expect to be up, raise **Wait**
and try again — a short wait cannot see an answer that has not arrived yet.

This is also the way to monitor something that blocks ping entirely: if a host
answers on a TCP port but never replies to ping, the network is filtering ICMP
rather than the host being down.

### Wide scans

Scanning a whole range works — the presets go from a dozen common ports up to
all 65,535. Two hundred and fifty-six ports are checked at once, so:

| Range | Roughly |
|---|---|
| 1–1024 | a few seconds |
| 1–10000 | a minute or so |
| 1–65535 | 5–10 minutes |

The estimate next to the port count is a **ceiling** — it assumes every port
times out, which only happens against a host that drops everything. Anything
that answers is far quicker. Progress and a **Stop** button appear while it runs.

Above 64 ports, only the **open** ones are listed. A live host refuses every
closed port, and 65,000 rows saying "closed" is unreadable; the totals still
appear in the summary underneath, so nothing is lost but the noise.

> **Scan things you are responsible for.** This makes an ordinary TCP
> connection to every port, which is exactly what it looks like to an intrusion
> detection system — no different from `nmap` or `PortQry` in that respect. On
> your own network that is routine; pointed at someone else's it may well
> generate an alert, and in some places break policy or law.

---

## Connections

Every open TCP connection on this machine, and the process behind it —
`netstat -ano` with the process already looked up for you. It refreshes every
two seconds.

Established connections come first and are grouped by application, so one
program's conversations stay together. Two filters are on by default:

- **Established only** hides listeners and the debris of closing sockets. Untick
  it to see what this machine is listening *for*, and the `Time wait` sockets
  left behind by connections that have already finished.
- **Hide loopback** hides traffic that never leaves the machine. There is
  usually a surprising amount of it, and none of it is a network concern.

The filter box narrows by process, address, port, PID or state, and several
words narrow by all of them — `chrome 443` means both, not that exact phrase.

`unknown` in the Process column means the owning process belongs to another user
account. Reading its name would need privileges this app deliberately doesn't
ask for; the PID beside it is still correct.

### Watching a connection

Hover a row and three buttons appear, each narrower than the last:

| Button | Watches |
|---|---|
| **Process** | Whether that application is talking to *anything* at all. |
| **Peer** | Whether it's still talking to *that host and port*. |
| **Socket** | That one exact connection, and nothing else. |

**Peer is the right default for most things.** Software keeps a pool of
connections to a server and replaces them constantly — six sockets to the same
host, each lasting seconds, is one healthy conversation. Watching a single
socket there would report a death every few seconds.

**Process is for applications that move between addresses.** A sync client like
Google Drive spreads its work across a rotating set of front-end IPs, so no
single peer stays put for long; watching the process asks the question you
actually care about, which is whether it can reach its service at all.

**Socket** is for when one specific connection genuinely is the thing that
matters — a VPN tunnel, an RDP session, a database connection.

Process watches only appear on rows Brett-Net could name, since there's nothing
to identify an unnamed process by.

Watching keeps running whether or not this tab is showing, and whether or not
the connection is on screen — the point is catching a drop you weren't looking
at. Your watches are remembered between runs.

When a watched connection goes away, Brett-Net says **why**, using what Windows
leaves behind:

| Verdict | Means |
|---|---|
| **Closed by far end** | The server hung up first, properly. |
| **Closed locally** | This machine hung up, properly. |
| **Process exited** | The application closed. Nothing to do with the network. |
| **Never connected** | The handshake never completed — nothing answered. |
| **Dropped** | It vanished mid-conversation with no shutdown at all. |

Only **Dropped** is a fault, and it's shown in red for that reason — the others
are normal endings, however abruptly your application may have reported them.

## Adapters

Everything `ipconfig /all` would tell you, without reading `ipconfig /all`:
address and subnet, gateway, DNS servers, DHCP server, MAC address, MTU and link
speed, for each network interface — plus **how much is flowing through each one
right now**.

Every interface shows a live rate (`↓` received, `↑` sent) and a running total
for this session. Click an interface to chart it: received above the line, sent
below, so a big upload can't hide underneath a big download.

**Stack all** charts every visible interface at once instead, one colour per
interface, stacked so the top of the shape is your machine's total. Useful when
traffic could be going out over more than one route — a VPN and the physical
adapter, say — and you want to see which one is carrying it.

**Reading the colours.** Each interface gets one hue, and the two directions are
the same hue at different lightness: **the lighter shade is always sent.** The
two-tone swatch on each card shows that interface's pair, dark over light, the
same way round as the chart.

Two things worth knowing about the numbers:

- **Rates are in bits per second, totals in bytes.** That's deliberate, not
  inconsistent — a link speed is quoted in bits, so `28 Mbps on a 433 Mbps link`
  compares directly, while *how much have I used* is a question about bytes.
  Divide by 8 to convert.
- **Totals count from when you opened Brett-Net**, not since the machine booted,
  and they keep counting while you're on another tab. Closing the app resets
  them.

This measures traffic **leaving this machine**, which is not the same as your
internet connection's load — everything else on the network is invisible here.
It answers "am *I* the one saturating the link", which is usually the first
thing worth ruling out.

Only interfaces that are **up and have an address** are shown, sorted so the one
carrying your traffic — the one with a default gateway — is first. Tick **Show
inactive** for the rest; a typical Windows machine has several tunnel and
virtual adapters sitting idle.

`none` against a field means that interface genuinely has none, which is normal
— a VPN often has no gateway of its own, and loopback has no hardware address.

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
the network, not Brett-Net. Switch those hosts to **TCP port** probing, above,
and the graph works anyway.

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
