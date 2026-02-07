export function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const args = {};
  /** @type {string[]} */
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      rest.push(token);
      continue;
    }

    const eq = token.indexOf('=');
    if (eq !== -1) {
      const key = token.slice(2, eq);
      const value = token.slice(eq + 1);
      args[key] = value;
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i++;
  }

  return { args, rest };
}

