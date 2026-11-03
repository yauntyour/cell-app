# FlowLink

Peer-to-peer networking between `cell` instances on the same network: device
discovery, one-time pairing, and an end-to-end encrypted channel that carries
mail, remote file reads and remote Teamwork jobs.

The implementation lives in the **core** — `cell.cpp/cell.cpp`, in the FlowLink
region just before `namespace link` — not in a frontend. The CLI (`/link …`),
the desktop app (the FlowLink page, `Ctrl+Shift+L`) and the agent tools (`fl`,
`tw cell=…`) all drive the same `cell::flowlink::service` instance, mounted by
`cell::link::enable()`.

It is **off by default**. Nothing is constructed until it is enabled: no
`io_context`, no thread, no socket, no allocation.

---

## 1. Model

```
cell A                                         cell B
  │  UDP <rand>: "I am here" → broadcast / multicast / unicast targets
  │  UDP 47821..47824: best-effort rendezvous (receive only, may be unavailable)
  │◄──────────────────────────────────────────────►│   discovery
  │                                                │
  │  TCP 47822 (or a random port): HELLO / HELLO_ACK / CONFIRM
  │◄──────────────────────────────────────────────►│   pairing (once) → link key
  │                                                │
  │  TCP <actual>: AEAD frames (mail, fs.*, tw.*)  │   sessions
  │◄──────────────────────────────────────────────►│
```

The ports on the wire are **discovered, not assumed**: a beacon carries the
transport port and the sender's own receive port, so a cell whose preferred
ports were taken by another process (or by the other OS under WSL2 mirrored
networking) still works.

* **Identity** — `client_id`, 16 random bytes from libsodium, 32 lowercase hex
  characters. It names the peer directory `.cell/links/<client_id>/` and is the
  value the `cell` field of the `tw` tool carries. It is generated once and
  kept in `.cell/links/identity.json`.
* **Discovery** — a beacon reveals only `client_id`, display name, the
  transport port, the sender's receive/rendezvous UDP ports and whether a
  pairing window is open. No payload, no key material.
* **Pairing** — *mutual*: each cell shows its own 512-bit code, and each side
  types the other's. Phase 1 proves knowledge of the responder's code (that is
  what shows up as a request on the responder), and the link key is only handed
  over sealed with a key derived from **both** codes — so a peer that knows just
  one code ends up with nothing. There is no PKI and no signature: the two codes
  together are the trust anchor.
* **Link key** — 32 random bytes handed over inside the encrypted handshake.
  Both sides store it sealed and use it as the PSK of every later session, so
  pairing happens once per pair of cells.
* **Sessions** — ephemeral X25519 + the PSK give each connection its own
  forward-secret traffic keys; the link key never encrypts payload directly.

## 2. Storage

Everything FlowLink owns lives under `<exe dir>/.cell/links/` — the agent's
global `config.json` holds **none** of it (see §8):

```
<exe dir>/.cell/
├── .key                          master secret (shared with the credential vault)
└── links/                        ← all FlowLink state
    ├── identity.json             {"client_id", "name", "created_at"}
    ├── links.json                service settings (incl. extra_targets) + paired links + workspaces
    ├── transmission.json         index of every transfer/mail received
    └── <client_id>/
        ├── .key                  the link key, sealed with Argon2id + AES-256-GCM
        └── <id>.jsonl            one stored conversation / transfer per received item
```

`.key` uses the same scheme as an API key in the vault: Argon2id over the master
secret with a per-file salt, then AES-256-GCM (XChaCha20-Poly1305 where AES-GCM
is unavailable). The file is owner-only (0600 on POSIX, read-only attribute on
Windows).

`links.json` is the single source of truth for FlowLink settings (including
`extra_targets`) **and** the paired-device list: each peer's metadata (name, last address/port, `paired_at`,
direction, OS/timezone/lang) is a record inside the `links` array — there is no
separate `meta.json`. Received mail/transfers are stored as `<id>.jsonl` files
under the peer dir and catalogued by `transmission.json` (the `/link inbox` /
`flowlink.transfers` listings read that index).

Deleting `links/<client_id>/` — or `/link forget <cell>` — revokes the pairing
on this side; the received `.jsonl` files remain.

## 3. Discovery protocol (UDP)

One JSON object per datagram, ≤ 1 KiB:

```json
{"m":"CELLFLNK","v":1,"t":"announce","id":"<client_id>","name":"laptop",
 "port":47822,"rp":51422,"dp":47821,"seq":41,"pair":false,
 "accept":false,"os":"windows","tz":"…","lang":"zh-CN","ts":1730563200}
```

| field | meaning |
|---|---|
| `m` / `v` | protocol marker / version (unchanged) |
| `t` | `announce` or `probe` |
| `id`, `name` | `client_id`, display name |
| `port` | this cell's TCP transport port — the **actual** one, which may be random |
| `rp` | this cell's beacon/receive UDP port (random; replies come here when `47821` is not ours) |
| `dp` | the rendezvous port this cell actually bound, `0` if it could not |
| `seq` | monotonically increasing per-process counter (dedupe aid) |
| `pair`, `accept` | pairing window open / accepts remote jobs |
| `os`, `tz`, `lang`, `ts` | display metadata, timestamp |

The additions are backwards compatible: older peers ignore `rp`/`dp`/`seq`.

### Socket model

Discovery never depends on winning a fixed port. When `announce` is on the
service opens:

* **beacon socket (always)** — UDP v4, `SO_REUSEADDR`, `SO_BROADCAST`, bound to
  `0.0.0.0:0`. This is the **random receive port** (`rx_port` in status). Every
  announce/probe is sent from it, so replies and probes aimed back at us land on
  the same port. Binding 0 is what lets a second instance — or the other OS under
  WSL2 mirrored networking — run next to the first one.
* **rendezvous socket (best effort)** — UDP v4, bound to the first free port
  of the configured `discovery` slot range (default `47821`..`47824`). It
  receives broadcast/multicast/probes addressed to those ports and joins the
  multicast group on every interface. If every slot is taken the service keeps
  running and reports `discovery_state = "probe-only"`; it still sends and
  receives unicast through the beacon socket. The range exists because one host
  (Windows + WSL mirrored, or a second cell) can give the well-known port to only
  one process; local addresses are probed on every slot, broadcast on the first.
* **multicast senders (best effort)** — one socket per IPv4 interface address,
  bound to that address with `IP_MULTICAST_IF` set, used only for multicast
  egress (never receive). This fixes per-interface multicast sends.

When `announce` is false no discovery sockets are created at all:
`discovery_state = "off"`. Interface enumeration still runs (on start and every
~10 s) so the page can render addresses and diagnostics.

### Target list

Rebuilt before **every** announce (adapters appear and vanish while the process
runs — WSL starts after the app, a VPN connects, a dock is plugged in). Each
entry has a `kind`; the page groups by it and prints the Chinese `label`.

| `kind` | target | why |
|---|---|---|
| `local` | each IPv4 interface's own address, plus `127.0.0.1`, on every rendezvous slot | mirrored-mode rendezvous: under WSL2 mirrored networking both stacks share the address, so a unicast to ourselves reaches the other stack (and a second cell may have taken a later slot) |
| `broadcast` | each interface's directed broadcast, `addr \| ~mask` (skipped on /31, /32) | the real subnet broadcast, never a `/24` guess |
| `broadcast` | `255.255.255.255` | the subnet-independent limited broadcast |
| `multicast` | `239.255.42.71` | survives APs that filter broadcast between clients (best effort) |
| `gateway` | each interface's default gateway, on every rendezvous slot | a real host on the same segment; for WSL2 NAT the gateway *is* the Windows host |
| `peer` | every discovered peer at its `rp` (and `dp`) port | **unicast keepalive** — this is what keeps WSL↔Windows discovery alive when broadcast cannot cross |
| `peer` | every paired peer's persisted address at the discovery port | bootstrap after both sides restarted (their random beacon ports are gone) |
| `extra` | user `extra_targets`, defaulting to the discovery port | cross-subnet, VPN, a peer behind NAT |

The list is rebuilt on every beacon; the count is bounded in practice by the
number of interfaces, peers and `extra_targets` (typically well under 64
datagrams per 5 s). Each target is deduplicated by `addr:port`.

The mask matters. A host on `100.2.22.110/18` has broadcast `100.2.63.255`;
guessing `/24` produces `100.2.22.255`, which is an ordinary host address, so the
datagram is a unicast to nobody and discovery silently finds nothing. WSL2 hands
its vEthernet a `/20`, which is the case this project hit first.

Replies:

* a `probe` is always answered with a unicast `announce` to the source endpoint;
* an `announce` is answered with a unicast `announce` when the peer is new or
  its source endpoint changed, rate-limited to once per 5 s per peer (a loop
  breaker; a `probe` reply is rate-limited to once per second). A cell never
  replies to its own `client_id`.

Dedupe: per peer, an `announce` carrying the same `ts` as the previous one is
ignored, so the copies that arrive once per interface are applied (and counted)
only once; `probe` and `announce` are tracked separately, so a pairing-state
change is never suppressed by a duplicate. Peers not seen for 30 s are evicted.

Receivers validate every field. Discovery is best effort: a peer that cannot be
seen can still be reached by typing its address — `flowlink.probe {addr}`
unicasts a probe to one `ip[:port]` (the FlowLink page's *按地址探测*), and
`/link join CODE IP` pairs with it directly.

### Evidence from WSL2 mirrored networking

Measured on this machine (`networkingMode=Mirrored`, `hostAddressLoopback=true`):

* the Windows cell held UDP 47821, so the WSL cell's `bind(47821)` failed with
  `EADDRINUSE` — under mirrored networking the two OSes share the UDP port space,
  exactly like they share TCP bindings. The old design then disabled discovery
  entirely, which is why the WSL page showed `地址: —`.
* **unicast works both ways** between the stacks: Windows→WSL and WSL→Windows were
  delivered to `100.2.22.110:<port>` and to `127.0.0.1:<port>`.
* **broadcast does not work WSL→Windows** (`100.2.63.255` and
  `255.255.255.255` were dropped), while Windows→WSL broadcast was delivered.
* multicast was not delivered in either direction (kept as best effort).
* WSL sees `eth4 100.2.22.110/18` — the same IP as the Windows host.

Conclusion: the fixed rendezvous port must be optional, and the reliable path is
a random receive port plus **unicast** to local addresses, gateways, discovered
peers and `extra_targets`. Do not depend on broadcast or on winning `47821`.

### Port policy

* FlowLink TCP: bind the preferred `port`; on failure retry with port 0 (random)
  and log a warning. `flowlink.status.port` is the actual port,
  `port_preferred` the configured one — the service never fails to start because
  of the TCP port.
* UDP beacon: always a random port.
* Rendezvous: first free `discovery` slot (default `47821`..`47824`), best
  effort; all slots busy is non-fatal (`probe-only`), and `discovery_bound`
  reports the slot actually bound (`0` = none).
* A second instance (or the other OS) on one machine therefore coexists with the
  first: it gets its own random receive/TCP ports and degrades to probe-only only
  if every rendezvous slot is taken.
* HTTP/webview backend: desktop and headless default to an OS-assigned random
  loopback port; an explicit `--serve PORT` / `--headless PORT` must bind that
  port or fail loudly. Any other listener also uses port 0 unless the user
  configured one.

### When nothing is discovered

`flowlink.status` carries the diagnostics: `interfaces` (every IPv4 interface
with its prefix, computed broadcast and gateway), `targets` (the exact endpoints
a beacon goes to, each with `kind` and a short Chinese `label`), `rx`
(`announce`/`probe`/`sent`/`errors` counters plus `last_from` and
`since`), and `hints` (state-aware Chinese sentences for the degraded cases).
The FlowLink page shows the actual discovery and receive ports under **本机**,
renders `hints` when the device list is empty, and offers a collapsible
**发现诊断** panel that groups `targets` by kind and prints the `rx` counters.

* `rx.announce == 0` — nothing reaches us at all. Broadcast is not crossing
  (different subnet, WSL2 NAT, a firewall) — probe the peer's address directly,
  or add it under `extra_targets`.
* `discovery_state == "probe-only"` — every rendezvous slot was taken; we can
  still probe and answer unicast, but inbound broadcast/multicast to those ports
  goes to the processes that own them. Change `discovery`, use
  `extra_targets`, or rely on the unicast paths.
* Two hosts on the same subnet that still cannot see each other are usually
  separated by a Wi-Fi AP with client isolation, or a host firewall dropping
  inbound UDP (`discovery` slot range and `rx_port`) or TCP (the actual
  transport port).
* WSL2: the Windows side announces into `vEthernet (WSL)`'s subnet and WSL
  unicasts to its gateway (the Windows host), so both directions work without
  mirrored networking. Under mirrored networking use the unicast paths above —
  WSL→Windows broadcast is dropped. Ports that must be reachable when something
  filters: UDP <rendezvous> (47821 by default, optional), UDP <rx_port> (random),
  TCP <actual transport port>.

## 4. Transport and framing (TCP)

The transport port defaults to `47822` (the `port` setting) but is only a
**preference**: if it is taken the service binds a random port and reports the
actual one as `flowlink.status.port` (`port_preferred` keeps the configured
value). Peers learn the actual port from the beacon's `port` field and from
HELLO. Each frame is a 4-byte big-endian length followed by a JSON body
(≤ 16 MiB).

Before the handshake:

| frame | contents |
|---|---|
| `hello` | `{m,v,id,name,eph,port,mode,pm,ts}` — `eph` = ephemeral X25519 public key, `mode` = `pair` \| `resume`, `pm` = `mutual` for the two-code flow (absent = the older one-code flow) |
| `hello_ack` | `{m,v,id,name,eph,port,mode,mac}` |
| `enc` (CONFIRM) | `{n,c}` — AEAD of `{t:"confirm",th[,link]}` under the handshake key |

After the handshake every frame is `{"t":"enc","n":…,"c":…}` — there is no
plaintext control channel to spoof. Inside, the payload is one of:

| payload | meaning |
|---|---|
| `{t:"req",id,m,p}` | RPC request (`m` = method, `p` = params) |
| `{t:"res",id,ok,r\|e}` | RPC response |
| `{t:"evt",m,p}` | one-way event from the peer |
| `{t:"hello",name,port,accept_remote}` | post-handshake identity refresh |
| `{t:"ping"}` / `{t:"pong"}` | keepalive |
| `{t:"pair_offer",offer}` | pairing channel only: the initiator's link key, sealed with a key that needs both codes |
| `{t:"pair_done",proof}` | pairing channel only: the responder proved it typed the initiator's code |

## 5. Handshake

```
A (initiator)                                    B (responder)
  eph_A = X25519 keypair
  ── HELLO {id_A, name, eph_A, port_A, mode} ──────────────►
                                     eph_B = X25519 keypair
                                     dh  = X25519(eph_B, eph_A)
                                     psk = PSK(mode, id_A, id_B)
                                     prk = HKDF-Extract(salt=psk, ikm=dh)
                                     th  = BLAKE2b("fl1|id_A|id_B|eph_A|eph_B|mode|port_A|port_B")
  ◄── HELLO_ACK {id_B, name, eph_B, port_B, mode, mac=HMAC(prk,"hs mac",th)} ──
  dh  = X25519(eph_A, eph_B)
  prk = HKDF-Extract(salt=psk, ikm=dh)
  verify mac  ── wrong code ends here ──
  ── CONFIRM {th, link} (AEAD, hs key) ───────────────────►
                                     verify th, store link key
  ◄── CONFIRM {th} (AEAD, hs key) ─────────────────────────
  both: k_c2s = HKDF-Expand(prk,"app c2s"), k_s2c = …("app s2c")
```

* `PSK(pair)` = `Argon2id(code, salt)` with `salt = BLAKE2b("cell-flowlink-pair|min(id)|max(id))[0..16]` —
  both sides derive it without sending anything.
* `PSK(resume)` = the stored link key.
* `hs` keys encrypt the CONFIRM frames; `app` keys encrypt everything after.
* Both ports are inside the transcript hash, so a forged port cannot poison the
  address remembered for reconnects.

A wrong code fails at `verify mac` — before any data is exchanged. The pairing
window closes on success, on `/link cancel`, or after its TTL (5 min default),
and a peer may only pair while a window is open.

### Mutual pairing (both sides type a code)

`pm: mutual` switches the handshake into the two-code flow. Phase 1 is the
diagram above with `PSK = Argon2id(B's code)`: it proves the initiator knows the
**responder's** code, and that is exactly what makes a request appear on the
responder. The connection is then kept as a *pairing channel* — not a session:
it accepts nothing but the two frames below, and no RPC.

```
A (initiator)                                  B (responder)
  ── HELLO {pm:mutual} ─────────────────────────────►   (B's window must be open)
  ◄── HELLO_ACK + MAC(PSK_B) ─────────────────────────   A learns it typed the right code
  ── CONFIRM ────────────────────────────────────────►
  ◄── CONFIRM ────────────────────────────────────────   B: "a request is waiting"
  ── pair_offer { aead(K_mutual, link_key) } ─────────►   K_mutual = HKDF-Extract(PSK_A, PSK_B)
                                                         B cannot open it yet → shows the request
        B's user types A's code
                                                         B opens the offer → stores the link key
  ◄── pair_done { HMAC(K_mutual, "fl pair done") } ────  A verifies, stores the same key
       both sides: paired, window closed, channel closed
```

`PSK_A` is Argon2id over **A's** code, `PSK_B` over **B's**, both with the same
`pair_salt`. A knows both (it typed B's and shows its own); B only learns `PSK_A`
when its user types A's code — which is the moment a link key can exist. A peer
that only knows one code can complete phase 1 but never produces a key the other
side accepts.

The pending request lives as long as the pairing window (≤ 5 min). A typo in the
approval keeps it (each attempt costs one Argon2id derivation); three wrong codes
close the window, exactly like a wrong code did before. The channel also closes
on `/link cancel`, when the request expires, or when either side goes away.

### If an existing pairing stops reconnecting

An older build wrote the sealed `<client_id>/.key` with `nonce`/`ct` under the
wrong JSON keys on CPUs with AES-NI, so the file can never be decrypted. The
symptom is a peer that still shows as paired but whose resume handshake fails
with "unknown peer: pair first" (and a `no readable link key … re-pairing is
required` warning in the log). Remove the pair on both sides and pair again
(`/link forget CELL`, or 断开 in the FlowLink page); the current build writes
readable keys on every CPU. New key files are always validated by
`--smoke-flowlink` ("real nonce and ciphertext").

## 6. What a peer can do

Both directions use the same RPC surface. Pairing only establishes trust; what a
paired peer may actually do is three separate grants on the owner's **权限**
page — all default **off**:

| grant | covers |
|---|---|
| `accept_workspace` | `ws.list`, `ws.sessions`, `ws.history`, `fs.*`, `agent.send`, `agent.stop` |
| `accept_workflow` | `tw.new`, `tw.run` |
| `accept_watch` | `ws.watch`, `ws.unwatch` |

A refused call answers with `<method>: this cell does not allow <grant>
(FlowLink → 权限)`; nothing about the machine leaks first (not even the
workspace names).

| method | params | returns |
|---|---|---|
| `mail.deliver` | `{id?,from,from_name,subject,note,kind,payload}` | `{ok,id}` |
| `ws.list` | — | `{ok,workspaces:[{ws,cwd,session,busy,active,open}]}` |
| `ws.sessions` | `{cwd}` | `{ok,cwd,sessions:[{id,title,mtime,msgs,active,busy}]}` — newest first |
| `ws.history` | `{cwd,id}` | `{ok,id,total,entries,archives}` — same entry shape as `session.history` |
| `fs.ls` | `{path}` | `{path,items:[{name,dir,size}]}` |
| `fs.read` | `{path}` | `{path,size,text}` (≤ 512 KiB, text only) |
| `fs.stat` | `{path}` | `{path,dir,size}` |
| `agent.send` | `{cwd,text,rid,session?}` | `{ok,ws,session}` — queues a turn (optionally in a named session) |
| `agent.stop` | `{rid}` | `{ok}` |
| `ws.watch` | `{cwd}` | `{ok,ws,session,busy,entries}` — subscribes to that workspace's `agent.event` stream |
| `ws.unwatch` | `{cwd}` | `{ok}` |
| `tw.new` | `{config}` | `{ok,id,text}` — creates a job, does not run it |
| `tw.run` | `{id}` or `{config}` | `{ok,id,text}` — runs it, returns the report |

`fs.*` is read-only and confined to the shared workspace: the canonical path
must stay inside it, so `../` and symlinks cannot escape. `tw.*` runs on the
peer with **its own** providers and keys; only the report travels back. A
watched stream is one-way: `agent.event` frames arrive with `watch:true`, and
there is no method a watcher can use to send anything (that needs
`accept_workspace`, which is a different switch).

## 7. Commands

### CLI — `/link`

```
/link                     status: id, ports, pairing window, peers, inbox
/link on | off            mount / unmount the service (persisted in links/links.json)
/link peers               paired + discovered cells
/link pair [TTL]          open a pairing window, print YOUR code
/link join CODE [IP[:PORT]]  type the other cell's code (also opens your window)
/link approve CODE [CELL] approve a waiting request with the requester's code
/link cancel              close the pairing window and drop pending requests
/link share CELL [SID]    send a session's conversation to a paired cell
/link send CELL TEXT...   send a short message
/link inbox               list the mailbox
/link read ID             read one message
/link forget CELL         drop the pairing (deletes the link key)
/link probe               broadcast a discovery probe
```

### Desktop — command bus

The same operations, JSON-shaped:

* **Service** — `flowlink.status` (includes the peer list, so there is no
  separate `flowlink.peers`), `flowlink.settings` (alias `flowlink.prefs`),
  `flowlink.enable`, `flowlink.disable`, `flowlink.scan`, `flowlink.probe`.
* **Pairing** — `flowlink.pair.begin` (show a code), `flowlink.pair.join`
  (type theirs; answers `pending` until they approve), `flowlink.pair.approve`
  (type the requester's code), `flowlink.pair.cancel`, `flowlink.forget`,
  `flowlink.disconnect`.
* **Transfers** — `flowlink.transfers`, `flowlink.transfer.read`,
  `flowlink.transfer.drop`, `flowlink.transfer.mark`. These are what
  `/link inbox` and `/link read` drive; the older `flowlink.inbox` /
  `flowlink.mail.*` names never existed on the bus.
* **Messaging and remote work** — `flowlink.share`, `flowlink.send`,
  `flowlink.remote.ls`, `flowlink.remote.read`.
* **Workspaces** — `flowlink.ws.remote`, `flowlink.ws.add`,
  `flowlink.ws.remove`, `flowlink.ws.open`, `flowlink.ws.send`,
  `flowlink.ws.stop`, `flowlink.ws.sessions`, `flowlink.ws.history`.
* **Monitor** — `flowlink.ws.watch`, `flowlink.ws.unwatch` (read-only stream).
* **Escape hatch** — `flowlink.exec {line}` runs any `/link …` line and returns
  its text.

### Agent tools

* `fl` — `cells`, `inbox`, `read`, `share`, `send`, `ls`, `read_file`,
  `status`, `pair`. Outgoing operations ask the user first.
* `tw` — `operation=cells` lists the remote cells; `cell=<client_id>` on
  `new`/`run`/`workflow` ships the job to that cell and returns its report.

## 8. Settings (`.cell/links/links.json`)

FlowLink settings are **not** in the agent's `config.json` — they live in the
top-level fields of `.cell/links/links.json`, alongside the `links` array (paired
peers) and the `workspaces` array (pinned FlowLink workspaces). The agent core
reads/writes them through `flowlink::store::settings()` / `patch_settings()`, and
the desktop page through the `flowlink.prefs` / `flowlink.settings` commands (the
latter also carries `extra_targets`).

| key | default | meaning |
|---|---|---|
| `enabled` | `false` | mount the service at startup |
| `name` | `""` | display name (empty = host name) |
| `port` | `47822` | preferred TCP transport port; `0` = random, and a busy port falls back to random automatically |
| `discovery` | `47821` | first of the rendezvous UDP slots (`47821`..`47824`); all busy = `probe-only` |
| `extra_targets` | `[]` | extra unicast discovery targets, one `ip[:port]` per entry (max 16; port defaults to `discovery`) |
| `announce` | `true` | open the discovery sockets and send beacons/probes (off = no discovery sockets, so not discoverable and cannot probe) |
| `accept_workspace` | `false` | paired peers may list workspaces and sessions, read files and run turns here |
| `accept_workflow` | `false` | paired peers may run `tw.*` jobs here |
| `accept_watch` | `false` | paired peers may watch one workspace's live output (read-only) |
| `access_workspace` | `false` | this cell may browse/use a peer's workspaces, sessions and remote turns |
| `access_workflow` | `false` | this cell may ship `tw.*` jobs to a peer |
| `workspace` | `""` | directory remote work lands in (empty = active workspace / cwd) |

`accept` was one switch for *everything a peer may do here*. It still reads as
the fallback for `accept_workspace` and `accept_workflow` until the file is
rewritten (the first settings write pins the split), but the page and the CLI
only use the five keys above. Toggling any of them does **not** remount the
service — a grant change must not interrupt a remote turn.

The older `config.json` keys (`link_enabled`, `link_name`, `link_port`,
`link_discovery`, `link_announce`, `link_accept`, `link_workspace`) are migrated
away automatically: at boot, `cell::link::migrate_legacy_settings()` moves any of
them still present in `config.json` into `links.json` exactly once — and only if a
`links.json` does not already exist (the new file always wins). After that, edit
`links/links.json` directly; `config.json` no longer has a say in FlowLink.

## 9. Threat model

Covered:

* **Passive listener on the LAN** — everything after HELLO is AEAD-sealed; the
  beacons carry no payload.
* **Wrong pairing code / impostor** — the handshake MAC and the CONFIRM frames
  fail without the code; no data frame is ever accepted.
* **Knowing only one code** — phase 1 completes (the peer sees a request), but
  the link key is sealed with a key that needs both codes, so the offer never
  opens and no link is stored on either side.
* **A watcher overreaching** — monitor mode is a one-way subscription: the
  watcher only receives `agent.event` frames, and every sending method sits
  behind `accept_workspace`, which is a different grant.
* **Replay** — every frame carries a fresh 192-bit nonce; a replayed frame does
  not decrypt under a different session key, and each session has new keys.
* **Stolen key file on a backup** — the link key is sealed with Argon2id over
  the machine's master secret; the file alone is not usable.
* **Path traversal** — `fs.*` is confined to the shared workspace by canonical
  path comparison.
* **Port hijacking (Windows)** — the TCP listener does not set
  `SO_REUSEADDR` there, so another process cannot bind the same port.
* **Malformed packets** — every field is read through non-throwing accessors;
  a bad frame closes the connection, it never throws out of an io handler.

Not covered (by design):

* **A hostile peer you paired with** — pairing is a trust decision. A paired
  peer may read the shared workspace and start jobs if `accept` is on.
* **Traffic analysis** — sizes and timing are visible to the network.
* **Discovery privacy** — an enabled, announcing cell is visible on the LAN by
  name and `client_id`; the random receive port does not hide its identity. Turn
  `announce` off to stay silent (this also disables probing).
* **NAT / routed networks** — the protocol is LAN-scoped (broadcast/multicast
  discovery, direct TCP). Peers behind NAT need a manual address and a port
  forward.

## 10. Cross-platform notes

* libsodium + Boost.Asio headers only — no extra shared library.
* Windows: Asio needs `ws2_32`, `mswsock`, `ole32`; the TCP listener avoids
  `SO_REUSEADDR` (see above).
* POSIX: key files are `chmod 0600`; the listener sets `SO_REUSEADDR` only to
  survive `TIME_WAIT` after a restart.
* Discovery sends to each interface's own unicast address, its real directed
  broadcast (`addr | ~mask`, never a `/24` guess), its default gateway,
  `255.255.255.255`, the multicast group (joined on every interface), discovered
  peers' random receive ports and the user's `extra_targets` — a host with several
  NICs, a docker bridge or a `/18` `/20` mask still reaches its peers (see §3).
  The receive socket uses a random port, so two stacks or two instances on one
  machine do not fight over 47821 (WSL2 mirrored networking shares UDP *and* TCP
  port space).
* `--smoke-flowlink` (run by CI on Windows, Linux and macOS) starts two cells in
  one process and checks discovery, a wrong code, pairing, the sealed key file,
  mail in both directions, RPC, a reconnect from the stored key, and the
  refusal of an unpaired peer.
