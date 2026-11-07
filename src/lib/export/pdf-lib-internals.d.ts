/** pdf-lib's own decryption key derivation (not exported; aliased in vite.config.ts). */
declare module '@cantoo/pdf-lib/crypto' {
  import type { PDFDict } from '@cantoo/pdf-lib'
  export class CipherTransformFactory {
    constructor(dict: PDFDict, fileIdBytes: Uint8Array, password?: string)
    encryptionKey: Uint8Array
  }
}
