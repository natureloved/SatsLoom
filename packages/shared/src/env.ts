/**
 * `.env` loading.
 *
 * The README says `cp .env.example .env`, so something has to actually read it. Node has no
 * built-in dotenv-on-import, and a documented setup step that silently does nothing is how a live
 * run fails with "MERCHANT_MNEMONIC is not set" while the operator stares at a filled-in `.env`.
 *
 * Rules, in order of importance:
 *
 *  1. A variable already present in `process.env` always wins. Real environment (Fly secrets, Docker
 *     `-e`, a shell export) outranks a file on disk — otherwise a stray `.env` in a checkout would
 *     override production configuration.
 *  2. Missing files are not an error. `.env` is optional; fixture mode needs nothing.
 *  3. Values are parsed the way dotenv does it (quotes stripped, `export ` tolerated, `#` comments
 *     and blank lines skipped) so a file written for docker-compose behaves identically here.
 *  4. A malformed file warns rather than throwing: it must never be the reason a process dies.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Parses dotenv-style text. Exported for tests; `loadDotEnv` is the normal entry point. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equals = withoutExport.indexOf("=");
    if (equals <= 0) continue;
    const key = withoutExport.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(equals + 1).trim();
    // Inline comments only count when unquoted, or `KEY="a #b"` would lose half its value.
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Walks up from `startDir` looking for the nearest `.env`, and applies it. Returns the path it
 * loaded, or `null`. Call this once, as early as possible in an entry point.
 */
export function loadDotEnv(options: { startDir?: string; override?: boolean; silent?: boolean } = {}): string | null {
  const start = options.startDir ?? process.cwd();
  let dir = resolve(start);
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      try {
        const parsed = parseEnvFile(readFileSync(candidate, "utf8"));
        for (const [key, value] of Object.entries(parsed)) {
          if (!options.override && process.env[key] !== undefined) continue;
          process.env[key] = value;
        }
        if (!options.silent) console.log(`[satsloom] loaded ${candidate}`);
        return candidate;
      } catch (error) {
        console.warn(`[satsloom] could not read ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** True when the process has been told to run against the in-process ledger. */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): "live" | "fixture" {
  return env.TACHI_PROVIDER === "fixture" ? "fixture" : "live";
}
