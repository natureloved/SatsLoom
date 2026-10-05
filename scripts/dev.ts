import { spawn, type ChildProcess } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const children: ChildProcess[] = [];

function start(label: string, workspace: string, env: NodeJS.ProcessEnv = process.env) {
  const child = spawn(npm, ["run", "dev", "--workspace", workspace], {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: process.platform === "win32",
    env,
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (signal || code === 0) return;
    console.error(`${label} stopped with exit code ${code}`);
    shutdown(code ?? 1);
  });
}

let stopping = false;
function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exitCode = exitCode;
}

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

async function isHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

const defaultApiPort = Number(process.env.API_PORT ?? 3001);
let apiPort = defaultApiPort;
const apiHealthy = await isHealthy(`http://127.0.0.1:${apiPort}/api/health`);
const apiCurrent = await isHealthy(`http://127.0.0.1:${apiPort}/api/refunds`);
if (apiHealthy && !apiCurrent) apiPort = defaultApiPort + 1;
if (apiPort !== defaultApiPort && await isHealthy(`http://127.0.0.1:${apiPort}/api/health`)) {
  throw new Error(`Ports ${defaultApiPort} and ${apiPort} are already occupied. Set API_PORT to an available port and rerun.`);
}
if (apiCurrent) {
  console.log(`Current API already healthy on http://127.0.0.1:${apiPort}; reusing it.`);
} else {
  start("API", "@satsloom/api", { ...process.env, PORT: String(apiPort) });
}
start("Web", "@satsloom/web", { ...process.env, VITE_API_PORT: String(apiPort) });

console.log(`SatsLoom starting: API http://127.0.0.1:${apiPort}, Web http://127.0.0.1:5174`);
