const baseUrl = (process.argv[2] ?? process.env.SATSLOOM_API_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");

try {
  const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(10_000) });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok || !contentType.includes("application/json") || body?.data?.ok !== true || body?.data?.service !== "satsloom-api") {
    console.error(`API smoke test failed: GET ${baseUrl}/api/health returned HTTP ${response.status}`);
    console.error(typeof body === "string" ? body : JSON.stringify(body, null, 2));
    process.exitCode = 1;
  } else {
    console.log(`API smoke test passed: ${baseUrl}/api/health`);
    console.log(`Payment execution: ${body.data.paymentExecution}; persistence: ${body.data.persistence}`);
  }
} catch (error) {
  console.error(`API smoke test could not reach ${baseUrl}/api/health`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
