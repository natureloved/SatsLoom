import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import serverModule from "./server.js";

process.env.SATSLOOM_RAIL = "fixture";

const handler = serverModule as (request: IncomingMessage, response: ServerResponse) => Promise<void>;

// Drive real requests through the default export over a loopback server, so Fastify writes to a
// genuine socket and terminates the response itself. This is the closest stand-in for Vercel, which
// invokes the default export with a Node req/res and never calls listen().
function call(path: string): Promise<{ status: number; body: string; type: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      handler(request, response).catch((error) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
    server.listen(0, "127.0.0.1", async () => {
      const { port } = server.address() as { port: number };
      try {
        const response = await fetch(`http://127.0.0.1:${port}${path}`);
        const body = await response.text();
        server.close();
        resolve({ status: response.status, body, type: response.headers.get("content-type") ?? "" });
      } catch (error) {
        server.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

describe("serverless entrypoint", () => {
  it("default-exports a req/res handler", () => {
    expect(typeof handler).toBe("function");
  });

  it("answers JSON routes with 200 and a JSON body", async () => {
    for (const path of ["/api/health", "/api/tachi/telemetry", "/api/overview"]) {
      const response = await call(path);
      expect(response.status, path).toBe(200);
      expect(response.type, path).toContain("application/json");
      expect(() => JSON.parse(response.body), path).not.toThrow();
    }
  }, 30000);

  it("reports the rail identity and the serverless persistence mode in health", async () => {
    const body = JSON.parse((await call("/api/health")).body) as {
      data: { rail: { mode: string; rail: string; live: boolean }; persistence: string; ok: boolean };
    };
    expect(body.data.ok, "ok").toBe(true);
    // The fixture rail is pinned for tests, and serverless persistence must be declared rather than
    // assumed: Vercel's filesystem is not a durable store.
    expect(body.data.rail.mode, "rail mode").toBe("fixture");
    expect(body.data.rail.rail, "rail").toBe("lightning-signet");
    expect(body.data.rail.live, "rail is not live").toBe(false);
    expect(body.data.persistence, "persistence").toBe("ephemeral-process-memory");
  });
});
