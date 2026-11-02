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
  │  UDP 47821: "I am here" (broadcast/multicast)  │
  │◄──────────────────────────────────────────────►│   discovery
  │                                                │
  │  TCP 47822: HELLO / HELLO_ACK / CONFIRM        │   pairing (once)
  │◄──────────────────────────────────────────────►│   → link key
  │                                                │
  │  TCP 47822: AEAD frames (mail, fs.*, tw.*)     │   sessions
  │◄──────────────────────────────────────────────►│
```

* **Identity** — `client_id`, 16 random bytes from libsodium, 32 lowercase hex
  characters. It names the peer directory `.cell/links/<client_id>/` and is the
  value the `cell` field of the `tw` tool carries. It is generated once and
  kept in `.cell/links/identity.json`.
* **Discovery** — a beacon reveals only `client_id`, display name, transport
  port and whether a pairing window is open. No payload, no key material.
* **Pairing** — a 512-bit code, typed once by one side, is the only credential.
  There is no PKI and no signature: whoever can prove knowledge of the code is
  the peer (TLS-like handshake, but the PSK *is* the trust anchor).
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
    ├── links.json                service settings + every paired link + workspace list
    ├── transmission.json         index of every transfer/mail received
    └── <client_id>/
        ├── .key                  the link key, sealed with Argon2id + AES-256-GCM
        └── <id>.jsonl            one stored conversation / transfer per received item
```

`.key` uses the same scheme as an API key in the vault: Argon2id over the master
secret with a per-file salt, then AES-256-GCM (XChaCha20-Poly1305 where AES-GCM
is unavailable). The file is owner-only (0600 on POSIX, read-only attribute on
Windows).

`links.json` is the single source of truth for FlowLink settings **and** the
paired-device list: each peer's metadata (name, last address/port, `paired_at`,
direction, OS/timezone/lang) is a record inside the `links` array — there is no
separate `meta.json`. Received mail/transfers are stored as `<id>.jsonl` files
under the peer dir and catalogued by `transmission.json` (the `/link inbox` /
`flowlink.transfers` listings read that index).

Deleting `links/<client_id>/` — or `/link forget <cell>` — revokes the pairing
on this side; the received `.jsonl` files remain.

## 3. Discovery protocol (UDP)

One JSON object per datagram, ≤ 1 KiB, on port **47821**:

```json
{"m":"CELLFLNK","v":1,"t":"announce","id":"<client_id>","name":"laptop",
 "port":47822,"pair":false,"ts":1730563200}
```

| `t` | meaning |
|---|---|
| `announce` | "I exist" — sent every 5 s (±1.2 s jitter) to every target in the table below |
| `probe` | "who is there?" — receivers answer with a unicast `announce` |

Where a beacon goes, rebuilt before **every** announce (adapters appear and
vanish while the process runs — WSL starts after the app, a VPN connects, a dock
is plugged in):

| target | why |
|---|---|
| `255.255.255.255` | the subnet-independent limited broadcast |
| `239.255.42.71` | multicast, joined on **every** interface; survives APs that filter broadcast between clients |
| `<subnet broadcast>` of each IPv4 interface | the real directed broadcast, computed as `addr \| ~mask` from the interface's own prefix — never a `/24` guess |
| the interface's default gateway | a unicast to a real host on the same segment; for WSL2 the gateway *is* the Windows host, the only path across its NAT |

The mask matters. A host on `100.2.22.110/18` has broadcast `100.2.63.255`;
guessing `/24` produces `100.2.22.255`, which is an ordinary host address, so the
datagram is a unicast to nobody and discovery silently finds nothing. WSL2 hands
its vEthernet a `/20`, which is the case this project hit first.

A receiver that sees a **new** peer — or one whose address changed — answers with
a unicast `announce` to the datagram's source address, at most once per 10 s per
peer. That makes discovery work when only one direction can carry broadcast (NAT,
client isolation, a firewall that allows replies but not inbound broadcast).
Beacons carry a `ts`, so the copies that arrive once per interface are applied
(and counted) only once.

Receivers ignore their own `client_id`, validate every field, and keep a peer
table entry for 30 s (`kPeerTtlSeconds`). Discovery is best effort: a peer that
cannot be seen can still be reached by typing its address —
`flowlink.probe {addr}` unicasts a probe to one `ip[:port]` (the FlowLink page's
*按地址探测*), and `/link join CODE IP` pairs with it directly.

### When nothing is discovered

`flowlink.status` carries the diagnostics: `interfaces` (every IPv4 interface
with its prefix, computed broadcast and gateway), `targets` (the exact endpoints
a beacon goes to) and `rx` (`announce`/`probe` counters plus the last source).
The FlowLink page shows the local addresses under **本机** and prints the target
list whenever the device list is empty.

* `rx.announce == 0` — nothing reaches us at all. Broadcast is not crossing
  (different subnet, WSL2 NAT, a firewall) — probe the peer's address directly.
* Two hosts on the same subnet that still cannot see each other are usually
  separated by a `/24` assumption somewhere else, a Wi-Fi AP with client
  isolation, or a host firewall dropping inbound UDP 47821 / TCP 47822.
* WSL2: the Windows side announces into `vEthernet (WSL)`'s subnet and WSL
  unicasts to its gateway (the Windows host), so both directions work without
  mirrored networking. Ports that must be reachable: UDP 47821, TCP 47822.

## 4. Transport and framing (TCP)

Port **47822**. Each frame is a 4-byte big-endian length followed by a JSON
body (≤ 16 MiB).

Before the handshake:

| frame | contents |
|---|---|
| `hello` | `{m,v,id,name,eph,port,mode,ts}` — `eph` = ephemeral X25519 public key, `mode` = `pair` \| `resume` |
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

## 6. What a peer can do

Both directions use the same RPC surface; the responder answers only if its
owner enabled *accept remote work*.

| method | params | returns |
|---|---|---|
| `mail.deliver` | `{id?,from,from_name,subject,note,kind,payload}` | `{ok,id}` |
| `fs.ls` | `{path}` | `{path,items:[{name,dir,size}]}` |
| `fs.read` | `{path}` | `{path,size,text}` (≤ 512 KiB, text only) |
| `fs.stat` | `{path}` | `{path,dir,size}` |
| `tw.new` | `{config}` | `{ok,id,text}` — creates a job, does not run it |
| `tw.run` | `{id}` or `{config}` | `{ok,id,text}` — runs it, returns the report |

`fs.*` is read-only and confined to the shared workspace: the canonical path
must stay inside it, so `../` and symlinks cannot escape. `tw.*` runs on the
peer with **its own** providers and keys; only the report travels back.

## 7. Commands

### CLI — `/link`

```
/link                     status: id, ports, pairing window, peers, inbox
/link on | off            mount / unmount the service (persisted in links/links.json)
/link peers               paired + discovered cells
/link pair [TTL]          open a pairing window, print the code
/link join CODE [IP[:PORT]]  pair with the cell that shows CODE
/link cancel              close the pairing window
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
* **Pairing** — `flowlink.pair.begin`, `flowlink.pair.join`,
  `flowlink.pair.cancel`, `flowlink.forget`, `flowlink.disconnect`.
* **Transfers** — `flowlink.transfers`, `flowlink.transfer.read`,
  `flowlink.transfer.drop`, `flowlink.transfer.mark`. These are what
  `/link inbox` and `/link read` drive; the older `flowlink.inbox` /
  `flowlink.mail.*` names never existed on the bus.
* **Messaging and remote work** — `flowlink.share`, `flowlink.send`,
  `flowlink.remote.ls`, `flowlink.remote.read`.
* **Workspaces** — `flowlink.ws.remote`, `flowlink.ws.add`,
  `flowlink.ws.remove`, `flowlink.ws.open`, `flowlink.ws.send`,
  `flowlink.ws.stop`.
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
the desktop page through the `flowlink.prefs` command.

| key | default | meaning |
|---|---|---|
| `enabled` | `false` | mount the service at startup |
| `name` | `""` | display name (empty = host name) |
| `port` | `47822` | TCP transport |
| `discovery` | `47821` | UDP discovery |
| `announce` | `true` | broadcast the beacon (off = reachable only by address) |
| `accept` | `false` | accept `fs.*` / `tw.*` from paired peers |
| `workspace` | `""` | directory remote work lands in (empty = active workspace / cwd) |

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
  name and `client_id`; turn `announce` off to stay silent.
* **NAT / routed networks** — the protocol is LAN-scoped (broadcast/multicast
  discovery, direct TCP). Peers behind NAT need a manual address and a port
  forward.

## 10. Cross-platform notes

* libsodium + Boost.Asio headers only — no extra shared library.
* Windows: Asio needs `ws2_32`, `mswsock`, `ole32`; the TCP listener avoids
  `SO_REUSEADDR` (see above).
* POSIX: key files are `chmod 0600`; the listener sets `SO_REUSEADDR` only to
  survive `TIME_WAIT` after a restart.
* Discovery sends to `255.255.255.255`, the multicast group (joined on every
  interface), each interface's real directed broadcast (`addr | ~mask`, never a
  `/24` guess) and its default gateway — a host with several NICs, a docker
  bridge or a `/18` `/20` mask still reaches its peers (see §3).
* `--smoke-flowlink` (run by CI on Windows, Linux and macOS) starts two cells in
  one process and checks discovery, a wrong code, pairing, the sealed key file,
  mail in both directions, RPC, a reconnect from the stored key, and the
  refusal of an unpaired peer.
