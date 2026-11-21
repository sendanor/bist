import assert from "node:assert/strict";
import { test } from "node:test";
import { openOpenAiKey, sealOpenAiKey, SettingsCryptoError } from "../src/settings-crypto.ts";

test("OpenAI settings use randomized authenticated ciphertext", async () => {
  const deploymentKey = "11".repeat(32);
  const otherKey = "22".repeat(32);
  const value = "synthetic-provider-credential";
  const first = await sealOpenAiKey(deploymentKey, value);
  const second = await sealOpenAiKey(deploymentKey, value);
  assert.notEqual(first, second);
  assert.ok(!first.includes(value));
  assert.equal(await openOpenAiKey(deploymentKey, first), value);
  await assert.rejects(openOpenAiKey(otherKey, first), SettingsCryptoError);
  await assert.rejects(openOpenAiKey(undefined, first), SettingsCryptoError);
  await assert.rejects(
    openOpenAiKey(deploymentKey, first.replace(/^v1/u, "v2")),
    SettingsCryptoError,
  );
  const [version, nonce, ciphertext] = first.split(".");
  const tampered = ciphertext.slice(0, -2) + (ciphertext.endsWith("ff") ? "00" : "ff");
  await assert.rejects(
    openOpenAiKey(deploymentKey, [version, nonce, tampered].join(".")),
    SettingsCryptoError,
  );
});
