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

test("reads an existing v1 envelope with a mixed-case hexadecimal deployment key", async () => {
  const deploymentKey = "aF0c".repeat(16);
  const envelope =
    "v1.000102030405060708090a0b." +
    "1e03c60311232dc926fcfda4cb743a0ddfb8967976586642fcf501bbb325a9ecfa8d18f585cad14785";
  assert.equal(await openOpenAiKey(deploymentKey, envelope), "legacy-fixture-credential");
  await assert.rejects(openOpenAiKey(deploymentKey, envelope + "f"), SettingsCryptoError);
});
