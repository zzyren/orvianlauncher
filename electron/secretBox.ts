/** Subset of Electron's safeStorage, injectable so storage code can be tested without Electron. */
export interface SecretBox {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}
