/** Prints the cold-storage address from COLD_MNEMONIC — used by runbooks and the demo script. */
import { TachiAdapter } from "@satsloom/tachi-adapter";

const adapter = new TachiAdapter({ provider: process.env.TACHI_PROVIDER === "fixture" ? "fixture" : "live" });
const target = await adapter.targetFor("cold");
console.log(target.address);
