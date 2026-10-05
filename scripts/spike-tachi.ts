import "dotenv/config";
import { TachiSdkAdapter } from "@satsloom/tachi-adapter";

function describeError(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      const code = "code" in current && typeof current.code === "string" ? ` [${current.code}]` : "";
      parts.push(`${current.message}${code}`);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" <- ");
}

async function main() {
  const adapter = new TachiSdkAdapter();
  const status = await adapter.getStatus();
  const validators = await adapter.getValidators();
  let vaultCreation = false;
  let vaultVerification = false;
  let deposit = false;
  let depositTxid: string | undefined;
  let vtxoRegistration = false;
  let vtxoQuery = false;
  let vtxoId: string | undefined;
  let vtxoFeeSats: bigint | undefined;
  let userPsbtSigning = false;
  let unilateralExit = false;
  let unilateralExitCsvBlocks: number | undefined;
  let spikeStage = "vault";
  let vaultError: string | undefined;
  try {
    const vault = await adapter.createVault({
      mnemonic: process.env.TACHI_TEST_MNEMONIC ?? "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    });
    vaultCreation = vault.id !== "unavailable";
    vaultVerification = (await adapter.verifyVault(vault)).valid;
    console.error(JSON.stringify({
      vaultAddress: vault.address,
      cooperativeLeaf: vault.cooperativeLeaf,
      exitLeaf: vault.exitLeaf,
      csvDelay: vault.csvDelay,
    }, null, 2));
    if (process.env.TACHI_SPIKE_ENABLE_DEPOSIT === "true") {
      const amountSats = BigInt(process.env.TACHI_SPIKE_DEPOSIT_SATS ?? "100000");
      spikeStage = "deposit-discovery";
      const existing = await adapter.findConfirmedVaultDeposit(vault.id, amountSats);
      let result: { txid: string; amountSats: bigint };
      if (existing) {
        result = existing;
      } else {
        spikeStage = "funding-wallet";
        await adapter.prepareRegtestFunding(vault.id, amountSats + 25_000n);
        spikeStage = "deposit-to-vault";
        result = await adapter.depositToVault(vault.id, amountSats);
        spikeStage = "deposit-confirmation";
        await adapter.mineRegtestBlocks(1);
      }
      deposit = true;
      depositTxid = result.txid;
      spikeStage = "vtxo-registration";
      try {
        const registered = await adapter.registerDeposit(vault.id, amountSats);
        vtxoRegistration = true;
        vtxoQuery = (registered.vtxo as { id?: string })?.id === registered.vtxoId;
        vtxoId = registered.vtxoId;
        vtxoFeeSats = registered.feeSats;
        spikeStage = "user-transfer-signing";
        const transfer = await adapter.buildAndSignUserTransfer(vault.id, registered.vtxoId, result.txid);
        userPsbtSigning = transfer.signed;
        spikeStage = "unilateral-exit-signing";
        const exit = await adapter.buildAndSignUnilateralExit(vault.id, result.txid);
        unilateralExit = exit.signed && exit.finalized;
        unilateralExitCsvBlocks = exit.csvBlocks;
      } catch (error) {
        const message = describeError(error);
        if (!/not available|unsupported|unavailable/i.test(message)) {
          vaultError = `${spikeStage}: ${message}`;
        }
      }
    }
  } catch (error) {
    vaultError = `${spikeStage}: ${describeError(error)}`;
    // The result remains machine-readable when a live SDK operation fails.
  }
  console.log(JSON.stringify({
    daemonReachable: status.reachable,
    validatorsAvailable: validators.length > 0,
    vaultCreation,
    vaultVerification,
    deposit,
    vtxoRegistration,
    vtxoQuery,
    userPsbtSigning,
    kdhtCooperativeSigning: "unavailable",
    vtxoTransfer: "unavailable",
    unilateralExit,
    overallMode: "degraded",
    ...(depositTxid ? { depositTxid } : {}),
    ...(vtxoId ? { vtxoId } : {}),
    ...(vtxoFeeSats !== undefined ? { vtxoFeeSats: vtxoFeeSats.toString() } : {}),
    ...(unilateralExitCsvBlocks !== undefined ? { unilateralExitCsvBlocks } : {}),
    ...(vaultError ? { vaultError } : {})
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
