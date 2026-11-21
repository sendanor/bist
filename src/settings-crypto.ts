import { isString } from "./guards.ts";

const encoding = new TextEncoder();
const associatedData = encoding.encode("bist:settings:v1:openai.api_key");

/** A missing deployment key or a secret that could not be authenticated. */
export class SettingsCryptoError extends Error {
  /** Use a fixed error message that never contains settings or ciphertext. */
  constructor() {
    super(
      "The OpenAI credential could not be accessed. Check the deployment encryption key or replace the credential in Settings.",
    );
  }
}

/**
 * Check the format of a 256-bit deployment key without exposing it.
 * @param value Server-held deployment value in hexadecimal.
 */
export function isSettingsKey(value: unknown): value is string {
  return isString(value) && /^[a-fA-F0-9]{64}$/u.test(value);
}

/**
 * Decode validated hexadecimal data for Web Crypto.
 * @param value An even-length hexadecimal string.
 */
function bytes(value: string) {
  return Uint8Array.from(value.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

/**
 * Encode bytes for the versioned database envelope.
 * @param value The nonce or encrypted payload.
 */
function hex(value: Uint8Array) {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Import a nonextractable AES-GCM key from deployment configuration.
 * @param value Server-held key, separate from database storage.
 * @throws {SettingsCryptoError} When the deployment key is missing or malformed.
 */
async function importKey(value: unknown) {
  if (!isSettingsKey(value)) {
    throw new SettingsCryptoError();
  }
  return crypto.subtle.importKey("raw", bytes(value), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * Seal the OpenAI setting with a fresh nonce and bind it to its stable name.
 * @param deploymentKey Server-held key used only for settings encryption.
 * @param plaintext New OpenAI credential from an authorized maintainer.
 * @throws {SettingsCryptoError} When encryption cannot complete.
 */
export async function sealOpenAiKey(deploymentKey: unknown, plaintext: string) {
  try {
    const key = await importKey(deploymentKey);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: associatedData },
      key,
      encoding.encode(plaintext),
    );
    return `v1.${hex(iv)}.${hex(new Uint8Array(ciphertext))}`;
  } catch {
    throw new SettingsCryptoError();
  }
}

/**
 * Authenticate and decrypt only for a trusted server-side OpenAI request.
 * @param deploymentKey Server-held key used only for settings encryption.
 * @param envelope Stored value including its format version and nonce.
 * @throws {SettingsCryptoError} When decryption or authentication fails.
 */
export async function openOpenAiKey(deploymentKey: unknown, envelope: string) {
  try {
    const match = /^v1\.([0-9a-f]{24})\.((?:[0-9a-f]{2}){17,528})$/u.exec(envelope);
    if (!match) {
      throw new SettingsCryptoError();
    }
    const key = await importKey(deploymentKey);
    const value = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes(match[1]), additionalData: associatedData },
      key,
      bytes(match[2]),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new SettingsCryptoError();
  }
}
