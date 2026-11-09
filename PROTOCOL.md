# Mix bridge protocol (v1)

How the Downbeat iOS app talks to the rig bridge. One WebSocket per phone, JSON text messages.

- Endpoint: `ws://<mac-mini>:8790/v1/mix`
- Discovery on macOS rigs: Bonjour service `_downbeatmix._tcp` (TXT `rig=<name>`)
- Health: `GET http://<mac-mini>:8790/health`

Indices are zero-based: `ch: 0` is channel 1, `bus: 0` is Stereo Mix 1. Levels are dB; `null` means off (-inf); max +10. Pan is -1 (L) to 1 (R). `ch: null` means the bus master.

## Phone → bridge

| type | fields | notes |
| --- | --- | --- |
| `hello` | `personId` (required), `name`, `token`, `bus`, `meters` | Must be first. `token` is the rig token if the rig sets one. Passing `bus` selects it right away. |
| `select` | `bus` | Switch mix. Any allowed bus; taking over someone else's mix is allowed. |
| `set` | `bus`, `ch` (int or null), `field` (`level`/`mute`/`pan`), `value`, `seq` | Only after a `snapshot` for that bus. `seq` is echoed on errors. |
| `meters` | `on` | Turn meter frames on while the Mix screen is visible, off when it isn't. |

## Bridge → phone

| type | fields | notes |
| --- | --- | --- |
| `welcome` | `protocol`, `session`, `rig`, `console`, `buses` | `session` is this phone's id; use it to recognise your own moves in `changed.origin`. `buses` lists the mixes this phone may use (empty while the console is offline), so the app can open on the person's own mix by name. |
| `snapshot` | `bus`, `console`, `capabilities`, `buses`, `channels`, `master`, `sends` | Full state of one mix. Sent on select and again after every console reconnect. Replace local state with it. |
| `changed` | `bus`, `ch`, `field`, `value`, `origin` | `origin` is a session id (another phone) or `console` (desk/A1). Ignore your own session's echo while a finger is on that fader. |
| `layout` | `channels`, `buses` | Names/colors changed on the desk. Merge by `ch` / `bus`. |
| `meters` | `ch` (dB per channel, rounded, null = no signal), `master` | About 10 per second, only if requested. Frames are skipped for phones on slow Wi-Fi. On dLive the scale tops out around +18 (0 dBFS); draw meters from about -60 to +18. |
| `presence` | `bus`, `people` (`[{ session, personId, name }]`) | Everyone currently on this mix, you included. Sent whenever someone joins, switches away or disconnects. Drives "Diego is also on this mix". |
| `console` | `connected`, `name`, `model`, `buses` | Console link up or down. While down, show reconnecting and block faders; a fresh `snapshot` follows reconnect. |
| `error` | `code`, `message`, `seq` | Codes below. |

`capabilities` tells the app what to show: `sendLevel`, `sendMute`, `sendPan`, `busMaster`, `meters`, `names`, `colors`. Hide anything that is `false` (for example pan or meters if the console path doesn't support them).

`console.model` (in `welcome`, `snapshot` and `console`) is the console model, `dlive` or `wing`, or `null`. The app uses it to pick the standard Mix groups from Setlists.

`channels[i]` is `{ ch, kind, number, name, color, link }`. `ch` is the bridge index used in every other message (inputs first, then FX returns). `kind` is `input`, `fx_return` or `ufx_return` (dLive UFX returns, where most show reverbs come back; later `aux` on a Wing); `number` is the one-based number people see on the console for that kind, so input 5 and FX return 5 are different channels. Groups are saved by `kind` and `number`, never by `ch`. Older bridges send no `kind`/`number`: treat that as `input` and `ch + 1`. `link` is the `ch` of the other half of a linked stereo input pair ("Keys L"/"Keys R"), else `null`; both halves point at each other, and phones show the pair as one strip that moves both sends together. Older bridges send no `link`. A `layout` message carries `link` for every channel whose pairing changed (a rename can make or break a pair). `meters.ch` follows the same `ch` order.

`channels[i].color` is one of `red, green, yellow, blue, purple, lightblue, white, orange, pink` or `null` (no color assigned yet: show neutral rows, never invent a color).

## Error codes

`not_signed_in`, `unauthorized`, `bad_json`, `bad_message`, `bus_not_allowed`, `not_ready` (no snapshot yet for that bus), `console_offline`, `bad_field`, `bad_channel`, `bad_value`, `unsupported`, `write_failed`.

## Guarantees

- Only monitor-mix parameters exist in this protocol: per-input sends (level, mute, pan) and the bus master. No gain, EQ, dynamics, FX, routing, scenes or main LR.
- Writes are refused until the phone has a snapshot taken while the console was connected (read before write).
- Rapid fader moves are merged per parameter (latest value wins, at most ~25 updates/s per fader) and the console never receives more than `maxWritesPerSecond`.
- If the console drops, queued writes are thrown away, never replayed after reconnect.
- Every write that reaches the console is logged to `logs/mix-changes.jsonl` with who made it.
