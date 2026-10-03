/**
 * API entry point. Binds 0.0.0.0 so the container/preview host can reach it, and reports the
 * daemon mode it started with — a deployment that boots in `degraded` should say so in its logs.
 */
import { buildApp } from "./server.js";

const port = Number(process.env.PORT ?? 3001);
const { app, adapter } = buildApp();

try {
  await app.listen({ port, host: process.env.HOST ?? "0.0.0.0" });
  const status = await adapter.getStatus();
  app.log.info(
    { mode: status.mode, daemon: adapter.daemonBaseUrl, provider: adapter.providerKind, network: status.network },
    status.mode === "live" ? "SatsLoom API up — daemon reachable" : `SatsLoom API up in ${status.mode} mode`,
  );
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
