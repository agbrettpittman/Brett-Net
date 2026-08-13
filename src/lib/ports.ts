/** Matches `probe::MAX_PORTS`. */
export const MAX_PORTS = 128;

export interface ParsedPorts {
  ports: number[];
  /** Set when the input could not be used as written. */
  error: string | null;
}

/**
 * Parses a port list like `80, 443, 8000-8010`.
 *
 * Ranges are the reason this exists rather than a `split(',')`: typing out even
 * a modest range by hand is the friction that stops people using the tool.
 *
 * Lives here rather than in Rust because it validates a text box, and the field
 * needs to tell you what is wrong as you type — the same reason `parseHosts`
 * is on this side.
 */
export function parsePorts(input: string): ParsedPorts {
  const ports: number[] = [];

  for (const token of input.split(/[\s,]+/)) {
    if (token === '') continue;

    const range = token.split('-');
    if (range.length > 2) {
      return { ports: [], error: `"${token}" is not a port or range` };
    }

    const bounds = range.map(parseOne);
    if (bounds.some((p) => p === null)) {
      return { ports: [], error: `"${token}" is not a port number` };
    }

    const [lo, hi] = bounds.length === 2 ? bounds : [bounds[0], bounds[0]];
    if (lo! > hi!) {
      return { ports: [], error: `"${token}" is backwards` };
    }

    for (let p = lo!; p <= hi!; p++) {
      if (!ports.includes(p)) ports.push(p);
      if (ports.length > MAX_PORTS) {
        return { ports: [], error: `Too many ports — ${MAX_PORTS} at a time.` };
      }
    }
  }

  if (ports.length === 0) {
    return { ports: [], error: 'Enter at least one port.' };
  }
  return { ports, error: null };
}

/** A single port, or null if the token is not one. */
function parseOne(token: string): number | null {
  // Reject anything that is not purely digits, so "8o" and "-1" do not slip
  // through Number()'s leniency.
  if (!/^\d+$/.test(token)) return null;
  const n = Number(token);
  // Port 0 parses fine but means "any", which cannot be connected to.
  return n >= 1 && n <= 65535 ? n : null;
}
