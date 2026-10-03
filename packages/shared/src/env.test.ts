/**
 * `.env` parsing tests.
 *
 * The README tells operators to `cp .env.example .env`, so this is the code that decides whether
 * that instruction means anything. The interesting cases are all about not being surprising:
 * real environment wins, quotes are not part of the value, and a file that does not exist is not
 * an error.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotEnv, parseEnvFile, providerFromEnv } from "./env.js";

describe("parseEnvFile", () => {
  it("parses plain assignments", () => {
    expect(parseEnvFile("PORT=3001\nTACHI_PROVIDER=fixture\n")).toEqual({ PORT: "3001", TACHI_PROVIDER: "fixture" });
  });

  it("skips comments, blanks and malformed lines", () => {
    const parsed = parseEnvFile("# a comment\n\nNOT A LINE\n=novalue\nKEY=value\n");
    expect(parsed).toEqual({ KEY: "value" });
  });

  it("strips one layer of quotes and keeps inner spaces", () => {
    expect(parseEnvFile('MERCHANT_MNEMONIC="abandon abandon about"\n')).toEqual({ MERCHANT_MNEMONIC: "abandon abandon about" });
    expect(parseEnvFile("COLD_MNEMONIC='letter advice cage above'\n")).toEqual({ COLD_MNEMONIC: "letter advice cage above" });
  });

  it("keeps a quoted hash but drops an unquoted inline comment", () => {
    expect(parseEnvFile('PAYOUT_ADDRESS="bcrt1p#notacomment"\n')).toEqual({ PAYOUT_ADDRESS: "bcrt1p#notacomment" });
    expect(parseEnvFile("PORT=3001 # the api port\n")).toEqual({ PORT: "3001" });
  });

  it("tolerates `export` and CRLF line endings", () => {
    expect(parseEnvFile("export PORT=3001\r\nKEY=value\r\n")).toEqual({ PORT: "3001", KEY: "value" });
  });

  it("ignores keys that are not valid identifiers", () => {
    expect(parseEnvFile("2FA=enabled\nGOOD=yes\n")).toEqual({ GOOD: "yes" });
  });

  it("keeps empty values, which is how a route is switched off", () => {
    expect(parseEnvFile("PAYOUT_ADDRESS=\nVITE_API_URL=\n")).toEqual({ PAYOUT_ADDRESS: "", VITE_API_URL: "" });
  });
});

describe("loadDotEnv", () => {
  let dir: string;
  const touched = ["SATSLOOM_TEST_FROM_FILE", "SATSLOOM_TEST_PRECEDENCE"] as const;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "satsloom-env-"));
    for (const key of touched) delete process.env[key];
  });

  afterEach(() => {
    for (const key of touched) delete process.env[key];
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads values from the nearest .env", () => {
    writeFileSync(join(dir, ".env"), "SATSLOOM_TEST_FROM_FILE=from-file\n");
    const loaded = loadDotEnv({ startDir: dir, silent: true });
    expect(loaded).toBe(join(dir, ".env"));
    expect(process.env.SATSLOOM_TEST_FROM_FILE).toBe("from-file");
  });

  it("finds a .env in a parent directory, which is where the repo keeps it", () => {
    const nested = join(dir, "apps", "api");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(dir, ".env"), "SATSLOOM_TEST_FROM_FILE=from-parent\n");
    loadDotEnv({ startDir: nested, silent: true });
    expect(process.env.SATSLOOM_TEST_FROM_FILE).toBe("from-parent");
  });

  it("never overrides a variable that is already in the environment", () => {
    writeFileSync(join(dir, ".env"), "SATSLOOM_TEST_PRECEDENCE=from-file\n");
    process.env.SATSLOOM_TEST_PRECEDENCE = "from-environment";
    loadDotEnv({ startDir: dir, silent: true });
    // Fly secrets and Docker `-e` must outrank a stray file in a checkout.
    expect(process.env.SATSLOOM_TEST_PRECEDENCE).toBe("from-environment");
  });

  it("returns null instead of throwing when there is no .env anywhere", () => {
    const empty = join(dir, "deeper");
    mkdirSync(empty, { recursive: true });
    expect(loadDotEnv({ startDir: join(tmpdir(), "satsloom-definitely-absent"), silent: true })).toBeNull();
    expect(loadDotEnv({ startDir: empty, silent: true })).toBeNull();
  });
});

describe("providerFromEnv", () => {
  it("defaults to live and only treats the exact word 'fixture' as fixture", () => {
    // Anything else — a typo, a stray capital, an empty string — must land on the safe side, which
    // is `live` (where a missing mnemonic is a hard error rather than silent simulated money).
    expect(providerFromEnv({})).toBe("live");
    expect(providerFromEnv({ TACHI_PROVIDER: "FIXTURE" })).toBe("live");
    expect(providerFromEnv({ TACHI_PROVIDER: "" })).toBe("live");
    expect(providerFromEnv({ TACHI_PROVIDER: "fixture" })).toBe("fixture");
  });
});
