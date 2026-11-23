import { defineConfig } from "vitest/config";

// Root suite: engine, crypto, watchtower. The Solidity contracts have their own Hardhat
// suite in evm/ (run with `npm test` there), so keep vitest out of evm/ and zk/.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
