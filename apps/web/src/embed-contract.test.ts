/**
 * The embed contract test.
 *
 * `embed.js` is the one file whose contract is *documentation* rather than imports: a merchant
 * copies an HTML snippet from the README or the Plugin tab, and nothing type-checks that snippet
 * against the script. That is exactly how it drifted once already — the docs and the plugin page
 * both advertised `data-satsloom-api` while the script only read `data-satsloom-pay-origin`, so the
 * documented attribute was silently ignored.
 *
 * This asserts the two stay in sync, in either direction: every attribute the docs tell a merchant
 * to write must be read by the script, and every attribute the script reads must be documented.
 */
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const repoRoot = resolve(webRoot, "..", "..");

const embedSource = readFileSync(resolve(webRoot, "public/embed.js"), "utf8");
const pluginPage = readFileSync(resolve(webRoot, "src/pages.tsx"), "utf8");
const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");

/** Attributes of the form `data-satsloom-*`. */
function attributesIn(text: string): Set<string> {
  return new Set([...text.matchAll(/data-satsloom-[a-z-]+/g)].map((match) => match[0]));
}

/** What the script actually reads, ignoring its own docblock (comments cannot be the contract). */
function attributesReadByEmbed(): Set<string> {
  const body = embedSource.slice(embedSource.indexOf("(function ()"));
  return attributesIn(body);
}

describe("embed.js documentation contract", () => {
  it("reads every attribute the docs tell a merchant to write", () => {
    const documented = new Set([...attributesIn(readme), ...attributesIn(pluginPage)]);
    const read = attributesReadByEmbed();
    const unread = [...documented].filter((attribute) => !read.has(attribute));
    expect(unread).toEqual([]);
  });

  it("documents every attribute the script reads", () => {
    const documented = new Set([...attributesIn(readme), ...attributesIn(pluginPage)]);
    const read = attributesReadByEmbed();
    const undocumented = [...read].filter((attribute) => !documented.has(attribute));
    // `data-satsloom-mounted` is an internal marker the script sets on itself, not an input.
    expect(undocumented.filter((a) => a !== "data-satsloom-mounted")).toEqual([]);
  });

  it("requires an invoice id and fails loudly without one", () => {
    expect(embedSource).toMatch(/data-satsloom-invoice is required/);
    expect(embedSource).toContain('console.error("[satsloom]');
  });

  it("falls back to a plain link instead of trapping the customer in JavaScript", () => {
    // A pay button that only works with our script loaded is a button that loses sales.
    expect(embedSource).toMatch(/window\.open|window\.location/);
    expect(embedSource).toMatch(/<a |createElement\("a"\)|target/);
  });

  it("never touches a mnemonic, a key or the daemon directly", () => {
    for (const forbidden of ["mnemonic", "privateKey", "secretKey", "X-Api-Key", "x-api-key"]) {
      expect(embedSource.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("renders inside a shadow root so the merchant's CSS cannot break it", () => {
    expect(embedSource).toContain("attachShadow");
  });
});
