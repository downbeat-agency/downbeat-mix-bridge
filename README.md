# Downbeat mix bridge

Runs on the rig Mac Mini next to Mixing Station desktop. Musicians' phones (Downbeat app) talk to this bridge; the bridge is the only thing that talks to Mixing Station, and Mixing Station is the only thing that talks to the dLive.

```
20 phones (Downbeat app) ──Wi-Fi──▶ mix bridge ──localhost──▶ Mixing Station desktop ──▶ dLive MixRack
```

Plan and decisions: Notion "Mix: iOS personal mix build plan (dLive + Wing)", section "Architecture update: Mac Mini gateway". Phone protocol: [PROTOCOL.md](PROTOCOL.md).

Requirements: Node 22+. No npm packages; nothing to install beyond Node.

## Try it without a console

```bash
cd mix-bridge
npm test                 # unit + integration tests (fake dLive, fake Mixing Station)
npm run load             # 20 simulated musicians for 15 s against a fake dLive
npm run start:fake       # bridge on :8790 with a fake dLive, for building the iOS screens
```

## Mixing Station setup (confirmed on the Green rig Mac Mini, 2026-11-07)

Checked against Mixing Station 3.2.2 with the dLive model in offline mode:

- **API port 8091**, not the default 8080: UniFi Network Server already uses 8080 on the rig Mac Minis. Global settings → API: REST / Websocket → Enable On, Port 8091.
- **Write access needs a Mixing Station login.** Global settings → Permissions → Users → Manage. The built-in `admin` user has "API: Write". Set a password there and put it in `config.json` → `mixingStation.auth`. Without a login, every write comes back "Access Denied" and the bridge refuses fader moves.
- The driver reads the mix list from the console (`/console/mixTargets`), so mix numbering follows each show file. Only monitor mixes (Mix / St Mix) are offered to phones.
- Per-send pan exists only on stereo mixes (range -37..37 on dLive). Mono mixes hide pan.
- Meters work for every input and every mix master.
- Channel colors use dLive's 8 options; Black means "no color" in the app.
- **FX returns** come after the inputs (phone `ch` 128 on, numbered FX 1…), so Setlists Mix Groups can hold a Verbs group. The driver finds them by channel type name and logs every Mixing Station channel type when it connects (`driver: channel types: …`). **Not seen on a rig yet:** at rig prep, check that line names the dLive FX returns and that moving an FX return send on a phone moves it on the desk. If the name match misses, set `mixingStation.fxReturns.type` to the right type number; `fxReturns.enabled: false` hides them.

### Live show read (Green rig, 2026-11-07, read-only, about 2 minutes)

Mixing Station was connected to the running dLive at 10.0.30.2 only to read; it had no login, so it could not change anything.

- Real layout: 128 inputs; 4 mono mixes (BandSUB, MON 1-3), then 19 stereo mixes: MC, VOX 2, VOX 3, VOX 4, GUITAR, SAX, TRUMPET, TROMBONE, DRUMS, BASS, KEYS, PERC, and unnamed spares Mix 13-19. Phones get every mix by default: the sub, the wedges, the 12 named IEMs and the spares (23 on the Green rig). A rig can narrow that with `busFilter` in its config (`stereoOnly`, `hideUnnamed`, `includeNames`, `excludeNames`).
- Channel names and colors are set by the A1 and grouped by color (drums blue, band green/red, horns yellow, vocals cyan), matching the locked Edit group design.
- Connecting and syncing took about 4 s. A full subscription delivers ~17,900 values (2.4 MB) over ~5.4 s, so the driver waits for the stream to go quiet before phones get a snapshot.
- Live traffic: ~15 updates/s while someone drags a send (a musician on Mixing Station was mixing during the read). Meters for 128 inputs + 23 mixes at 100 ms are ~19 KB/s into the bridge.
- Meter values run from about -110 (silence) to +5 on this scale (console dbfsOffset 18).
- The Mac Mini reaches the dLive on 10.0.30.10 (vlan0). Mixing Station's own search looked on the wrong interface; connecting by IP worked.

### Live write test (Green rig, 2026-11-07, spare Mix 19 only)

Mix 19 was checked first (named "Mix 19", master at -90 dB), only its input sends were changed, and every value was put back and read back afterwards. Mix 19's master never moved.

- 60 send moves at 25/s (a fast thumb drag): all 60 reached the dLive and came back; final value correct.
- Mute and pan writes on Mix 19 landed and came back.
- A successful write gets no reply from Mixing Station, only the value update; a refused one replies with an error. The driver now treats writes that way (it used to wait for a reply and would have reported every fader move as failed).
- Write access used Mixing Station's built-in `admin` user (no password set yet), signed in by Diego on the Mac Mini.

Still to check: 20 phones through the bridge on a real console (rehearsal).

## Running it for shows (every rig: dLive or Wing)

One bundle for all rigs. Each rig Mac Mini runs Mixing Station desktop (API on port 8091) next to the bridge.

1. Build the bundle: `deploy/make-rig-bundle.sh` → `DownbeatMixBridge.tar.gz`.
2. Copy it to the rig Mac Mini (AirDrop, USB, or Claude), open it in Finder, double-click `install.command`.
3. The installer puts Node 22 in `~/DownbeatMix/node` (no admin password; checksum verified), the bridge in `~/DownbeatMix/mix-bridge`, and a login item (`~/Library/LaunchAgents/com.downbeat.mixbridge.plist`) that starts the bridge and restarts it if it stops. It prints `/health` and the log at the end (also saved to `~/Documents/DownbeatMix-install.log`).
4. First install only: it writes `~/DownbeatMix/config.json` with the Mac's computer name as the rig name and `consoleModel: "auto"` (the bridge reads dLive or Wing from Mixing Station). Edit it for `allowedBuses`, a `sharedToken` (rig code) or the Mixing Station password. Re-running the installer updates the bridge and keeps the config.

Also on each rig:
- Mixing Station must start at login and connect to the console by itself, with the API on 8091 (8080 clashes with UniFi).
- Energy settings → never sleep; turn off automatic macOS updates.
- Phones reach the bridge at `ws://<mac>:8790/v1/mix` (the app defaults to 10.0.30.10). The bridge also advertises `_downbeatmix._tcp` over Bonjour.
- Health: `curl http://localhost:8790/health` shows rig, console model, connected phones and write counters.

**Updates (no one touches the Mac Minis):** the bridge checks this repo's latest GitHub release every 12 hours (first check 2 minutes after start). If it is newer, and no phone has been connected for 10 minutes, it downloads `DownbeatMixBridge.tar.gz`, checks it against `SHA256SUMS`, swaps it in (the old version stays as `mix-bridge.previous`) and restarts. At gigs there is no internet, so the check just fails quietly; rigs update during the week at the warehouse. `deploy/launcher.js` (what the LaunchAgent runs) restarts the bridge after an update and, if the new version crashes three times within a minute of starting, puts the previous one back; that release is then skipped until a newer one comes out. Turn it off per rig with `"update": { "enabled": false }` in `config.json`.

**Rig status (which rigs run the newest bridge, from anywhere):** after every update check the bridge writes `rigs/<rig>.json` to the private repo [downbeat-agency/downbeat-rig-status](https://github.com/downbeat-agency/downbeat-rig-status): its version, the latest release it saw, the result (up to date, updated, waiting for phones, failed, rolled back, check failed), the console and how many phones were on. A GitHub Action there turns the files into a table on the repo's front page and flags rigs that are behind or haven't checked in for a day. It needs a GitHub token that can only write that repo (fine-grained, Contents: read and write), set once per rig as `"status": { "token": "…" }` in `config.json`; the installer asks for it. With no token the rig doesn't report; nothing else changes. The token is never written to the status files.

To publish: bump `version` in `package.json` and merge to main; `.github/workflows/release.yml` runs the tests, builds the bundle and creates release `vX.Y.Z` (skipped if that version is already released). `/health` and the phone's welcome message report the running version.

**Wing:** the Mixing Station API is the same across consoles, but the Wing channel and send layout has not been tested yet. Before a Wing show, check the bridge log's `console:` and `channel types:` lines and move a spare mix from a phone.

Green rig Mac Mini, 2026-11-08: installed, updated itself 0.2.0 → 0.2.1 → 0.2.2 from GitHub, connected to the dLive through Mixing Station. Read check from the Mac: 12 named stereo mixes (MC … PERC), 128 inputs (113 named) and 16 FX returns (FX 1 "W Vx Vrb", FX 2 "WVx Vrb2"); Mixing Station reports FX returns as channel type 3 "FX Return" at index 128. Mixing Station 3.2 sends no console model text, so the model comes from the channel layout.

## Layout

| Path | What |
| --- | --- |
| `src/bridge.js` | Sessions, bus scope, read-before-write, write merging and pacing, meters fan-out |
| `src/wsServer.js` | Zero-dependency WebSocket server |
| `src/drivers/mixingStation.js` | Talks to Mixing Station's local API (paths confirmed on the Green rig) |
| `src/drivers/fakeDlive.js` | Pretend dLive for development, tests and load tests |
| `scripts/ms-probe.js` | Dumps Mixing Station API state (`--port 8091`) |
| `scripts/load-test.js` | 20-phone load test |
| `scripts/mix-logger.js` | Read-only show logger: records every IEM send change and flags drops to -inf, mutes, and scene-recall-like bursts |
| `deploy/` | macOS LaunchAgent |

## Not done yet

- Downbeat sign-in check (today: per-rig shared token; next: verify the Downbeat login token).
- Assigning each musician's bus from Event Hub (today: the phone sends the bus).
- Load test against the real console (Mixing Station paths are confirmed; see above).
- iOS Mix screens: built (downbeat-official PR #701). Standard groups come from Setlists → Mix Groups per console model (`mixingStation.consoleModel`, default `dlive`).
