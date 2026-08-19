import { TachiSdkAdapter } from "@satsloom/tachi-adapter";

async function main() {
  const adapter = new TachiSdkAdapter();
  const status = await adapter.getStatus();
  const validators = await adapter.getValidators();
  let vaultCreation = false;
  let vaultVerification = false;
  try {
    const vault = await adapter.createVault({ mnemonic: process.env.TACHI_TEST_MNEMONIC ?? "test-only" });
    vaultCreation = vault.id !== "unavailable";
    vaultVerification = (await adapter.verifyVault(vault)).valid;
  } catch {
    // The result remains machine-readable when the daemon or SDK is unavailable.
  }
  console.log(JSON.stringify({
    daemonReachable: status.reachable,
    validatorsAvailable: validators.length > 0,
    vaultCreation,
    vaultVerification,
    deposit: false,
    vtxoRegistration: false,
    vtxoQuery: false,
    userPsbtSigning: false,
    kdhtCooperativeSigning: "unavailable",
    vtxoTransfer: "unavailable",
    unilateralExit: "unavailable",
    overallMode: "degraded"
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
