/**
 * Test harness helpers: write a temp config dir with absolute connector paths.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const TEST_CONFIG = join(dirname(fileURLToPath(import.meta.url)), "config");
const MOCK_SERVER = join(dirname(TEST_CONFIG), "mock-server.mjs");
const TEST_ENV = join(TEST_CONFIG, "test.env");
const AGENTS_YAML = join(TEST_CONFIG, "agents.yaml");

/** @type {string|null} */
let tempDir = null;

/**
 * Create (once) a temp config directory with absolute paths for the mock connector.
 * @returns {string} SB_CONFIG_DIR path
 */
export function prepareTestConfigDir() {
  if (!tempDir) {
    tempDir = mkdtempSync(join(tmpdir(), "sb-test-config-"));
    writeFileSync(join(tempDir, "agents.yaml"), readFileSync(AGENTS_YAML));
  }
  writeFileSync(
    join(tempDir, "connections.yaml"),
    YAML.stringify({
      env_files: [TEST_ENV],
      connections: {
        mock: { command: "node", args: [MOCK_SERVER], env: { MOCK_SECRET: "${MOCK_FROM_FILE}" } },
        "mock-serial": { command: "node", args: [MOCK_SERVER], serialize: true },
      },
    })
  );
  return tempDir;
}

/**
 * Environment for spawning Switchboard in tests.
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
export function testServerEnv(extra = {}) {
  return { ...process.env, SB_CONFIG_DIR: prepareTestConfigDir(), ...extra };
}

/** Remove the temp config directory. */
export function cleanupTestConfigDir() {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
}
