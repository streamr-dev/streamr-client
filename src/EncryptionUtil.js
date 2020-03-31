import crypto from 'crypto'
import util from 'util'

import WebCrypto from 'node-webcrypto-shim' // this allows us to run tests in node against browser API
import { ethers } from 'ethers'
import { MessageLayer } from 'streamr-client-protocol'

import UnableToDecryptError from './errors/UnableToDecryptError'
import InvalidGroupKeyError from './errors/InvalidGroupKeyError'

const { StreamMessage } = MessageLayer

function ab2str(buf) {
    return String.fromCharCode.apply(null, new Uint8Array(buf))
}

async function exportCryptoKey(key, { isPrivate = false } = {}) {
    const keyType = isPrivate ? 'pkcs8' : 'spki'
    const exported = await WebCrypto.subtle.exportKey(keyType, key)
    const exportedAsString = ab2str(exported)
    const exportedAsBase64 = global.btoa(exportedAsString)
    const TYPE = isPrivate ? 'PRIVATE' : 'PUBLIC'
    return `-----BEGIN ${TYPE} KEY-----\n${exportedAsBase64}\n-----END ${TYPE} KEY-----\n`
}

export default class EncryptionUtil {
    constructor(options = {}) {
        if (options.privateKey && options.publicKey) {
            EncryptionUtil.validatePrivateKey(options.privateKey)
            EncryptionUtil.validatePublicKey(options.publicKey)
            this.privateKey = options.privateKey
            this.publicKey = options.publicKey
        } else {
            this._generateKeyPair()
        }
    }

    async onReady() {
        if (this.isReady()) { return undefined }
        return this._generateKeyPair()
    }

    isReady() {
        return !!this.privateKey
    }

    // Returns a Buffer
    decryptWithPrivateKey(ciphertext, isHexString = false) {
        if (!this.isReady()) { throw new Error('EncryptionUtil not ready.') }
        let ciphertextBuffer = ciphertext
        if (isHexString) {
            ciphertextBuffer = ethers.utils.arrayify(`0x${ciphertext}`)
        }
        return crypto.privateDecrypt(this.privateKey, ciphertextBuffer)
    }

    // Returns a String (base64 encoding)
    getPublicKey() {
        if (!this.isReady()) { throw new Error('EncryptionUtil not ready.') }
        return this.publicKey
    }

    // Returns a Buffer or a hex String
    static encryptWithPublicKey(plaintextBuffer, publicKey, hexlify = false) {
        EncryptionUtil.validatePublicKey(publicKey)
        const ciphertextBuffer = crypto.publicEncrypt(publicKey, plaintextBuffer)
        if (hexlify) {
            return ethers.utils.hexlify(ciphertextBuffer).slice(2)
        }
        return ciphertextBuffer
    }

    /*
    Both 'data' and 'groupKey' must be Buffers. Returns a hex string without the '0x' prefix.
     */
    static encrypt(data, groupKey) {
        const iv = crypto.randomBytes(16) // always need a fresh IV when using CTR mode
        const cipher = crypto.createCipheriv('aes-256-ctr', groupKey, iv)
        return ethers.utils.hexlify(iv).slice(2) + cipher.update(data, null, 'hex') + cipher.final('hex')
    }

    /*
    'ciphertext' must be a hex string (without '0x' prefix), 'groupKey' must be a Buffer. Returns a Buffer.
     */
    static decrypt(ciphertext, groupKey) {
        const iv = ethers.utils.arrayify(`0x${ciphertext.slice(0, 32)}`)
        const decipher = crypto.createDecipheriv('aes-256-ctr', groupKey, iv)
        return Buffer.concat([decipher.update(ciphertext.slice(32), 'hex', null), decipher.final(null)])
    }

    /*
    Sets the content of 'streamMessage' with the encryption result of the old content with 'groupKey'.
     */
    static encryptStreamMessage(streamMessage, groupKey) {
        /* eslint-disable no-param-reassign */
        streamMessage.encryptionType = StreamMessage.ENCRYPTION_TYPES.AES
        streamMessage.serializedContent = this.encrypt(Buffer.from(streamMessage.getSerializedContent(), 'utf8'), groupKey)
        streamMessage.parsedContent = undefined
        /* eslint-enable no-param-reassign */
    }

    /*
    Sets the content of 'streamMessage' with the encryption result of a plaintext with 'groupKey'. The
    plaintext is the concatenation of 'newGroupKey' and the old serialized content of 'streamMessage'.
     */
    static encryptStreamMessageAndNewKey(newGroupKey, streamMessage, groupKey) {
        /* eslint-disable no-param-reassign */
        streamMessage.encryptionType = StreamMessage.ENCRYPTION_TYPES.NEW_KEY_AND_AES
        const plaintext = Buffer.concat([newGroupKey, Buffer.from(streamMessage.getSerializedContent(), 'utf8')])
        streamMessage.serializedContent = EncryptionUtil.encrypt(plaintext, groupKey)
        streamMessage.parsedContent = undefined
        /* eslint-enable no-param-reassign */
    }

    /*
    Decrypts the serialized content of 'streamMessage' with 'groupKey'. If the resulting plaintext is the concatenation
    of a new group key and a message content, sets the content of 'streamMessage' with that message content and returns
    the key. If the resulting plaintext is only a message content, sets the content of 'streamMessage' with that
    message content and returns null.
     */
    static decryptStreamMessage(streamMessage, groupKey) {
        if ((streamMessage.encryptionType === StreamMessage.ENCRYPTION_TYPES.AES
            || streamMessage.encryptionType === StreamMessage.ENCRYPTION_TYPES.NEW_KEY_AND_AES) && !groupKey) {
            throw new UnableToDecryptError(streamMessage)
        }
        /* eslint-disable no-param-reassign */

        if (streamMessage.encryptionType === StreamMessage.ENCRYPTION_TYPES.AES) {
            streamMessage.encryptionType = StreamMessage.ENCRYPTION_TYPES.NONE
            const serializedContent = this.decrypt(streamMessage.getSerializedContent(), groupKey).toString()
            try {
                streamMessage.parsedContent = JSON.parse(serializedContent)
                streamMessage.serializedContent = serializedContent
            } catch (err) {
                streamMessage.encryptionType = StreamMessage.ENCRYPTION_TYPES.AES
                throw new UnableToDecryptError(streamMessage)
            }
        } else if (streamMessage.encryptionType === StreamMessage.ENCRYPTION_TYPES.NEW_KEY_AND_AES) {
            streamMessage.encryptionType = StreamMessage.ENCRYPTION_TYPES.NONE
            const plaintext = this.decrypt(streamMessage.getSerializedContent(), groupKey)
            const serializedContent = plaintext.slice(32).toString()
            try {
                streamMessage.parsedContent = JSON.parse(serializedContent)
                streamMessage.serializedContent = serializedContent
            } catch (err) {
                streamMessage.encryptionType = StreamMessage.ENCRYPTION_TYPES.NEW_KEY_AND_AES
                throw new UnableToDecryptError(streamMessage)
            }
            return plaintext.slice(0, 32)
        }
        return null
        /* eslint-enable no-param-reassign */
    }

    async _generateKeyPair() {
        if (!this._generateKeyPairPromise) {
            this._generateKeyPairPromise = this.__generateKeyPair()
        }
        return this._generateKeyPairPromise
    }

    async __generateKeyPair() {
        if (process.browser) { return this._keyPairBrowser() }
        return this._keyPairServer()
    }

    async _keyPairServer() {
        const generateKeyPair = util.promisify(crypto.generateKeyPair)
        const { publicKey, privateKey } = await generateKeyPair('rsa', {
            modulusLength: 4096,
            publicKeyEncoding: {
                type: 'spki',
                format: 'pem',
            },
            privateKeyEncoding: {
                type: 'pkcs8',
                format: 'pem',
            },
        })

        this.privateKey = privateKey
        this.publicKey = publicKey
    }

    async _keyPairBrowser() {
        const { publicKey, privateKey } = await WebCrypto.subtle.generateKey({
            name: 'RSA-OAEP',
            modulusLength: 4096,
            publicExponent: new Uint8Array([1, 0, 1]), // 65537
            hash: 'SHA-256'
        }, true, ['encrypt', 'decrypt'])

        this.privateKey = await exportCryptoKey(privateKey, {
            isPrivate: true,
        })
        this.publicKey = await exportCryptoKey(publicKey, {
            isPrivate: false,
        })
    }

    static validatePublicKey(publicKey) {
        if (typeof publicKey !== 'string' || !publicKey.startsWith('-----BEGIN PUBLIC KEY-----')
            || !publicKey.endsWith('-----END PUBLIC KEY-----\n')) {
            throw new Error('"publicKey" must be a PKCS#8 RSA public key as a string in the PEM format')
        }
    }

    static validatePrivateKey(privateKey) {
        if (typeof privateKey !== 'string' || !privateKey.startsWith('-----BEGIN PRIVATE KEY-----')
            || !privateKey.endsWith('-----END PRIVATE KEY-----\n')) {
            throw new Error('"privateKey" must be a PKCS#8 RSA public key as a string in the PEM format')
        }
    }

    static validateGroupKey(groupKey) {
        if (!(groupKey instanceof Buffer)) {
            throw new InvalidGroupKeyError(`Group key must be a Buffer: ${groupKey}`)
        }

        if (groupKey.length !== 32) {
            throw new InvalidGroupKeyError(`Group key must have a size of 256 bits, not ${groupKey.length * 8}`)
        }
    }
}
