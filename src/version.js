export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`invalid version: ${version}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export function satisfies(version, range) {
  const match = /^(>=|>|<=|<|=)\s*(\d+\.\d+\.\d+)$/.exec(range.trim());
  if (!match) {
    throw new Error(`unsupported range: ${range}`);
  }
  const cmp = compareVersions(version, match[2]);
  switch (match[1]) {
    case '>=': return cmp >= 0;
    case '>': return cmp > 0;
    case '<=': return cmp <= 0;
    case '<': return cmp < 0;
    case '=': return cmp === 0;
    default: return false;
  }
}
