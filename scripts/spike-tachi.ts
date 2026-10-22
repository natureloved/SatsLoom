import "dotenv/config";
import { generateMnemonic } from "@tachibtc/taurus-wallet-aggregator";
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

/**
 * Tachi integration spike.
 *
 * Network is selected with TACHI_NETWORK (default: signet). The two chains are
 * funded differently, and the difference is the whole point of running this on
 * signet at all:
 *
 *   signet  - the wallet is funded from the public Bitcoin signet faucet, then
 *             the deposit waits for a real ~10-minute block. Nothing is mined
 *             locally, because nothing can be.
 *   regtest - the wallet is funded from a local bitcoind and the deposit is
 *             confirmed by mining a block, which takes a millisecond.
 *
 * A disposable mnemonic is generated unless TACHI_TEST_MNEMONIC is supplied, so
 * a signet run does not require any pre-existing credentials. Vaults are
 * one-deposit-only, so a fresh seed is what keeps runs from colliding.
 */
async function main() {
  const adapter = new TachiSdkAdapter();
  const network = adapter.network;
  const status = await adapter.getStatus();
  const validators = await adapter.getValidators();
  let vaultCreation = false;
  let vaultVerification = false;
  let deposit = false;
  let depositTxid: string | undefined;
  let faucetTxid: string | undefined;
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
    const mnemonic = process.env.TACHI_TEST_MNEMONIC?.trim() || generateMnemonic();
    const vault = await adapter.createVault({ mnemonic });
    vaultCreation = vault.id !== "unavailable";
    vaultVerification = (await adapter.verifyVault(vault)).valid;
    console.error(JSON.stringify({
      network,
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
      } else if (adapter.faucetAvailable) {
        // Signet: claim into the P2WPKH wallet, wait for a real block, then deposit.
        // The wait is not optional. The public daemon's `scantxoutset` cannot see
        // the mempool, so a faucet UTXO is invisible to the wallet until a block
        // confirms it, and `depositToVault` correctly refuses to spend what the
        // wallet cannot see.
        spikeStage = "faucet-claim";
        const claim = await adapter.claimFaucetFunds(vault.id, Number(amountSats + 25_000n) / 100_000_000);
        if (claim) faucetTxid = claim.txid;
        spikeStage = "faucet-confirmation";
        await adapter.waitForSignetDepositConfirmation(claim?.txid ?? "", 1).catch((error: unknown) => {
          // No claim and no existing deposit means there is nothing to wait for;
          // anything else is a real failure the caller should see.
          if (claim) throw error;
        });
        spikeStage = "deposit-to-vault";
        result = await adapter.depositToVault(vault.id, amountSats);
      } else {
        spikeStage = "funding-wallet";
        await adapter.prepareLocalFunding(vault.id, amountSats + 25_000n);
        spikeStage = "deposit-to-vault";
        result = await adapter.depositToVault(vault.id, amountSats);
        spikeStage = "deposit-confirmation";
        await adapter.mineLocalBlocks(1);
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
    network,
    daemonReachable: status.reachable,
    daemonNetwork: status.network,
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
    ...(faucetTxid ? { faucetTxid } : {}),
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
