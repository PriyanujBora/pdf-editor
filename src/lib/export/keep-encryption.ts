/**
 * "Keep the password protection": re-encrypt the output with the source's own /Encrypt dictionary,
 * file ID and file key, so the user password, the owner password and the permissions stay exactly
 * as they were. pdf-lib can only create *new* encryption (new key, new ID, new owner entry), so this
 * uses two internals (pinned by the version in package.json, covered by npm run test:fidelity):
 *  - CipherTransformFactory (pdf-lib's decryption) to derive the file key from the password;
 *  - a PDFSecurity instance whose key/version are replaced, as the writer's per-object encrypt hook.
 * The writer only encrypts stream data; strings in objects it keeps outside object streams (catalog,
 * page dicts, stream dicts, …) are encrypted here.
 */
import {
  PDFArray,
  PDFCatalog,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObjectCopier,
  PDFPageLeaf,
  PDFPageTree,
  PDFRef,
  PDFSecurity,
  PDFStream,
  PDFString,
  type PDFObject,
} from '@cantoo/pdf-lib'
import { CipherTransformFactory } from '@cantoo/pdf-lib/crypto'

const N = (n: string) => PDFName.of(n)

export interface SourceEncryption {
  probe: PDFDocument
  dict: PDFDict
  ids: PDFArray
  key: Uint8Array
  version: number
  keyBits: number
  encryptMetadata: boolean
  /** Standard handler with one crypt filter for strings and streams: can be kept as is. */
  supported: boolean
}

export async function readEncryption(bytes: Uint8Array, password: string): Promise<SourceEncryption | null> {
  const probe = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
  const ref = probe.context.trailerInfo.Encrypt
  if (!ref) return null
  const dict = probe.context.lookup(ref, PDFDict)
  const ids = probe.context.lookup(probe.context.trailerInfo.ID, PDFArray)
  const id0 = ids.get(0) as PDFHexString | PDFString
  const version = dict.lookupMaybe(N('V'), PDFNumber)?.asNumber() ?? 0
  const keyBits = dict.lookupMaybe(N('Length'), PDFNumber)?.asNumber() ?? 40
  const filter = dict.get(N('Filter'))
  const stmF = dict.get(N('StmF'))
  const strF = dict.get(N('StrF'))
  const sameFilter = version < 4 || ((!stmF || stmF === N('StdCF')) && (!strF || strF === N('StdCF')))
  const factory = new CipherTransformFactory(dict, id0.asBytes(), password)
  const em = dict.get(N('EncryptMetadata'))
  return {
    probe,
    dict,
    ids,
    key: factory.encryptionKey,
    version,
    keyBits,
    encryptMetadata: !(em && em.toString() === 'false'),
    supported: filter === N('Standard') && [1, 2, 4, 5].includes(version) && sameFilter,
  }
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** Encrypts direct strings inside `o` (not following references) with `fn`. */
function encryptStrings(o: PDFObject, fn: (b: Uint8Array) => Uint8Array, skipContents: boolean) {
  if (o instanceof PDFDict) {
    for (const [k, v] of o.entries()) {
      if (skipContents && k === N('Contents')) continue
      if (v instanceof PDFString || v instanceof PDFHexString) o.set(k, PDFHexString.of(hex(fn(v.asBytes()))))
      else if (v instanceof PDFDict || v instanceof PDFArray) encryptStrings(v, fn, false)
    }
  } else if (o instanceof PDFArray) {
    for (let i = 0; i < o.size(); i++) {
      const v = o.get(i)
      if (v instanceof PDFString || v instanceof PDFHexString) o.set(i, PDFHexString.of(hex(fn(v.asBytes()))))
      else if (v instanceof PDFDict || v instanceof PDFArray) encryptStrings(v, fn, false)
    }
  }
}

/** Call after garbage collection, right before save. */
export function applySourceEncryption(doc: PDFDocument, enc: SourceEncryption) {
  const ctx = doc.context
  const copier = PDFObjectCopier.for(enc.probe.context, ctx)
  const encDict = copier.copy(enc.dict)
  const encRef = ctx.register(encDict)
  ctx.trailerInfo.Encrypt = encRef
  ctx.trailerInfo.ID = copier.copy(enc.ids)

  const sec = PDFSecurity.create(ctx, { userPassword: 'placeholder' }) as unknown as {
    encryptionKey: Uint8Array
    keyBits: number
    encryption: { V: number }
    getEncryptFn: (obj: number, gen: number) => (b: Uint8Array) => Uint8Array
  }
  sec.encryptionKey = enc.key
  sec.keyBits = enc.keyBits
  sec.encryption = { V: enc.version }
  const base = sec.getEncryptFn.bind(sec)
  // /EncryptMetadata false: the XMP stream stays readable.
  const meta = enc.encryptMetadata ? undefined : (doc.catalog.get(N('Metadata')) as PDFRef | undefined)
  sec.getEncryptFn = (obj, gen) => (meta && meta.objectNumber === obj && meta.generationNumber === gen ? (b) => b : base(obj, gen))
  ctx.security = sec as unknown as PDFSecurity

  // Objects the writer keeps outside (encrypted) object streams carry plaintext strings otherwise.
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (ref === encRef) continue
    const sig = obj instanceof PDFDict && obj.lookup(N('Type')) === N('Sig')
    const outside =
      obj instanceof PDFStream || obj instanceof PDFCatalog || obj instanceof PDFPageTree || obj instanceof PDFPageLeaf || ref.generationNumber !== 0 || sig
    if (!outside) continue
    const fn = sec.getEncryptFn(ref.objectNumber, ref.generationNumber)
    encryptStrings(obj instanceof PDFStream ? obj.dict : obj, fn, sig)
  }
}
