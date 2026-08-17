import { bytesToHex, hexToBytes } from '../util/hex'

const SECRET_HEX = /^[0-9a-f]{64}$/i
const EVENT_HEX = /^[0-9a-f]{64}$/i
const AAD_PREFIX = 'form-zero:owned-post-secret:v1:'

export interface SecretEnvelopeV1 {
  v: 1
  algorithm: 'AES-GCM'
  iv: Uint8Array<ArrayBuffer>
  ciphertext: ArrayBuffer
}

function additionalData(eventId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(AAD_PREFIX + eventId.toLowerCase()) as Uint8Array<ArrayBuffer>
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export function isSecretEnvelope(value: unknown): value is SecretEnvelopeV1 {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<SecretEnvelopeV1>
  return v.v === 1 && v.algorithm === 'AES-GCM'
    && v.iv instanceof Uint8Array && v.iv.byteLength === 12
    && v.ciphertext instanceof ArrayBuffer && v.ciphertext.byteLength >= 48
}

export function isOwnedSecretHex(value: unknown): value is string {
  return typeof value === 'string' && SECRET_HEX.test(value)
}

/** Bind every ciphertext to its event id so envelopes cannot be swapped. */
export async function encryptOwnedSecret(secretHex: string, eventId: string, key: CryptoKey): Promise<SecretEnvelopeV1> {
  if (!isOwnedSecretHex(secretHex) || !EVENT_HEX.test(eventId)) throw new Error('Invalid owned-post secret')
  const iv = crypto.getRandomValues(new Uint8Array(12)) as Uint8Array<ArrayBuffer>
  const plaintext = hexToBytes(secretHex)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(eventId), tagLength: 128 },
    key,
    arrayBuffer(plaintext),
  )
  // Keep no mutable plaintext buffer alive after SubtleCrypto has copied it.
  plaintext.fill(0)
  return { v: 1, algorithm: 'AES-GCM', iv, ciphertext }
}

export async function decryptOwnedSecret(envelope: SecretEnvelopeV1, eventId: string, key: CryptoKey): Promise<string> {
  if (!isSecretEnvelope(envelope) || !EVENT_HEX.test(eventId)) throw new Error('Invalid owned-post envelope')
  const plaintext = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: envelope.iv, additionalData: additionalData(eventId), tagLength: 128 },
    key,
    envelope.ciphertext,
  ))
  if (plaintext.byteLength !== 32) {
    plaintext.fill(0)
    throw new Error('Invalid owned-post plaintext')
  }
  const secret = bytesToHex(plaintext)
  plaintext.fill(0)
  return secret
}
