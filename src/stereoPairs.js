// Linked stereo inputs (Keys L / Keys R): phones show each pair as one strip and move
// both sends together. Pairs are always two neighbouring inputs.
//
// Sources, in order:
//   1. config `pairs`  - input numbers the rig says are linked, e.g. [[17, 18]]
//   2. config `unpair` - neighbours that must never be linked, e.g. [[13, 14]]
//   3. auto: names that end in L and R with the same start ("Keys L"/"Keys R", "GtrL"/"GtrR")
//   4. sameName (on by default): neighbours with exactly the same name ("KeysTOP" on 17 and
//      18). Downbeat show files name both halves of a stereo input the same. A rig with two
//      players on the same name lists them in `unpair`.
//   5. blankPartner (on by default): an odd input with a name followed by an even input with
//      no name at all ("BGM" on 37, "" on 38). On the Green dLive that blank right half is how
//      a stereo input shows up in Mixing Station; unused channels carry their number ("85").

export const DEFAULT_STEREO_PAIRS = { auto: true, sameName: true, blankPartner: true, pairs: [], unpair: [] };

/** { base, side: 'L' | 'R' } when a name ends in a left/right marker, else null. */
export function sideOf(name) {
  const text = String(name ?? '').trim();
  const side = (s) => (/^(l|left|lt)$/i.test(s) ? 'L' : 'R');
  // "Keys L", "Keys-R", "Keys (L)", "Keys Left"
  let m = text.match(/^(.*\S)[\s\-_.]+[([]?(l|r|left|right|lt|rt)[)\]]?$/i);
  if (m) return { base: m[1].trim(), side: side(m[2]) };
  // "Keys(L)"
  m = text.match(/^(.*\S)[([](l|r|left|right)[)\]]$/i);
  if (m) return { base: m[1].trim(), side: side(m[2]) };
  // "KeysL": capital L/R straight after a lower-case letter or digit
  m = text.match(/^(.*[a-z0-9])(L|R)$/);
  if (m) return { base: m[1].trim(), side: m[2] };
  return null;
}

const key = (a, b) => `${Math.min(a, b)}:${Math.max(a, b)}`;

/**
 * Map of phone channel index -> partner index for linked input pairs.
 * `channels`: phone channels ({ ch, kind, number, name }).
 */
export function findPairs(channels, config = DEFAULT_STEREO_PAIRS) {
  const cfg = { ...DEFAULT_STEREO_PAIRS, ...(config ?? {}) };
  const inputs = channels.filter((c) => c.kind === 'input').sort((a, b) => a.number - b.number);
  const byNumber = new Map(inputs.map((c) => [c.number, c]));
  const blocked = new Set((cfg.unpair ?? []).filter((p) => Array.isArray(p) && p.length === 2).map(([a, b]) => key(a, b)));
  const links = new Map();
  const taken = new Set();
  const link = (a, b) => {
    links.set(a.ch, b.ch);
    links.set(b.ch, a.ch);
    taken.add(a.number);
    taken.add(b.number);
  };

  for (const pair of cfg.pairs ?? []) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [lo, hi] = [Math.min(...pair), Math.max(...pair)];
    const a = byNumber.get(lo);
    const b = byNumber.get(hi);
    if (hi !== lo + 1 || !a || !b || taken.has(lo) || taken.has(hi)) continue;
    link(a, b);
  }

  const defaultName = (c) => !String(c.name ?? '').trim() || /^ch\s*\d+$/i.test(String(c.name).trim());
  // The console sent an empty name (the bridge shows it as "Ch 38").
  const blank = (c) => c.blankName === true;
  for (const a of inputs) {
    const b = byNumber.get(a.number + 1);
    if (!b || taken.has(a.number) || taken.has(b.number) || blocked.has(key(a.number, b.number))) continue;
    if (cfg.auto) {
      const l = sideOf(a.name);
      const r = sideOf(b.name);
      if (l && r && l.side === 'L' && r.side === 'R' && l.base.toLowerCase() === r.base.toLowerCase()) {
        link(a, b);
        continue;
      }
    }
    if (cfg.sameName && !defaultName(a) && String(a.name).trim().toLowerCase() === String(b.name).trim().toLowerCase()) {
      link(a, b);
      continue;
    }
    if (cfg.blankPartner && a.number % 2 === 1 && !blank(a) && !defaultName(a) && blank(b)) {
      link(a, b);
    }
  }
  return links;
}
