// What the bridge puts in its Bonjour announcement (dns-sd -R TXT records).

/** IPv4 addresses phones could reach, from os.networkInterfaces(): no loopback or link-local. */
export function localIPv4(interfaces) {
  const out = [];
  for (const list of Object.values(interfaces ?? {})) {
    for (const a of list ?? []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal || a.address.startsWith('169.254.')) continue;
      if (!out.includes(a.address)) out.push(a.address);
    }
  }
  return out;
}

/** TXT entries: the rig name and, when known, its addresses ("10.0.30.212,192.168.20.86"). */
export function advertTxt(rigName, addrs) {
  return addrs ? [`rig=${rigName}`, `addrs=${addrs}`] : [`rig=${rigName}`];
}
