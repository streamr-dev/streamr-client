import assert from 'assert'
import crypto from 'crypto'

import { ethers } from 'ethers'
import { MessageLayer } from 'streamr-client-protocol'

import EncryptionUtil from '../../src/EncryptionUtil'

const { StreamMessage } = MessageLayer

describe('EncryptionUtil', () => {
    it('rsa decryption after encryption equals the initial plaintext', () => {
        const encryptionUtil = new EncryptionUtil()
        const plaintext = 'some random text'
        const ciphertext = EncryptionUtil.encryptWithPublicKey(Buffer.from(plaintext, 'utf8'), encryptionUtil.getPublicKey())
        assert.deepStrictEqual(encryptionUtil.decryptWithPrivateKey(ciphertext).toString('utf8'), plaintext)
    })
    it('rsa decryption after encryption equals the initial plaintext (hex strings)', () => {
        const encryptionUtil = new EncryptionUtil()
        const plaintext = 'some random text'
        const ciphertext = EncryptionUtil.encryptWithPublicKey(Buffer.from(plaintext, 'utf8'), encryptionUtil.getPublicKey(), true)
        assert.deepStrictEqual(encryptionUtil.decryptWithPrivateKey(ciphertext, true).toString('utf8'), plaintext)
    })
    it('aes decryption after encryption equals the initial plaintext', () => {
        const key = crypto.randomBytes(32)
        const plaintext = 'some random text'
        const ciphertext = EncryptionUtil.encrypt(Buffer.from(plaintext, 'utf8'), key)
        assert.deepStrictEqual(EncryptionUtil.decrypt(ciphertext, key).toString('utf8'), plaintext)
    })
    it('aes encryption preserves size (plus iv)', () => {
        const key = crypto.randomBytes(32)
        const plaintext = 'some random text'
        const plaintextBuffer = Buffer.from(plaintext, 'utf8')
        const ciphertext = EncryptionUtil.encrypt(plaintextBuffer, key)
        const ciphertextBuffer = ethers.utils.arrayify(`0x${ciphertext}`)
        assert.deepStrictEqual(ciphertextBuffer.length, plaintextBuffer.length + 16)
    })
    it('multiple same encrypt() calls use different ivs and produce different ciphertexts', () => {
        const key = crypto.randomBytes(32)
        const plaintext = 'some random text'
        const ciphertext1 = EncryptionUtil.encrypt(Buffer.from(plaintext, 'utf8'), key)
        const ciphertext2 = EncryptionUtil.encrypt(Buffer.from(plaintext, 'utf8'), key)
        assert.notDeepStrictEqual(ciphertext1.slice(0, 32), ciphertext2.slice(0, 32))
        assert.notDeepStrictEqual(ciphertext1.slice(32), ciphertext2.slice(32))
    })
    it('StreamMessage gets encrypted', () => {
        const key = crypto.randomBytes(32)
        const streamMessage = StreamMessage.create(
            ['streamId', 0, 1, 0, 'publisherId', 'msgChainId'], null,
            StreamMessage.CONTENT_TYPES.MESSAGE, StreamMessage.ENCRYPTION_TYPES.NONE, {
                foo: 'bar'
            }, StreamMessage.SIGNATURE_TYPES.NONE, null,
        )
        EncryptionUtil.encryptStreamMessage(streamMessage, key)
        assert.notDeepStrictEqual(streamMessage.getSerializedContent(), '{"foo":"bar"}')
        assert.deepStrictEqual(streamMessage.encryptionType, StreamMessage.ENCRYPTION_TYPES.AES)
    })
    it('StreamMessage decryption after encryption equals the initial StreamMessage', () => {
        const key = crypto.randomBytes(32)
        const streamMessage = StreamMessage.create(
            ['streamId', 0, 1, 0, 'publisherId', 'msgChainId'], null,
            StreamMessage.CONTENT_TYPES.MESSAGE, StreamMessage.ENCRYPTION_TYPES.NONE, {
                foo: 'bar'
            }, StreamMessage.SIGNATURE_TYPES.NONE, null,
        )
        EncryptionUtil.encryptStreamMessage(streamMessage, key)
        const newKey = EncryptionUtil.decryptStreamMessage(streamMessage, key)
        assert.deepStrictEqual(newKey, null)
        assert.deepStrictEqual(streamMessage.getSerializedContent(), '{"foo":"bar"}')
        assert.deepStrictEqual(streamMessage.encryptionType, StreamMessage.ENCRYPTION_TYPES.NONE)
    })
    it('StreamMessage gets encrypted with new key', () => {
        const key = crypto.randomBytes(32)
        const newKey = crypto.randomBytes(32)
        const streamMessage = StreamMessage.create(
            ['streamId', 0, 1, 0, 'publisherId', 'msgChainId'], null,
            StreamMessage.CONTENT_TYPES.MESSAGE, StreamMessage.ENCRYPTION_TYPES.NONE, {
                foo: 'bar'
            }, StreamMessage.SIGNATURE_TYPES.NONE, null,
        )
        EncryptionUtil.encryptStreamMessageAndNewKey(newKey, streamMessage, key)
        assert.notDeepStrictEqual(streamMessage.getSerializedContent(), '{"foo":"bar"}')
        assert.deepStrictEqual(streamMessage.encryptionType, StreamMessage.ENCRYPTION_TYPES.NEW_KEY_AND_AES)
    })
    it('StreamMessage decryption after encryption equals the initial StreamMessage (with new key)', () => {
        const key = crypto.randomBytes(32)
        const newKey = crypto.randomBytes(32)
        const streamMessage = StreamMessage.create(
            ['streamId', 0, 1, 0, 'publisherId', 'msgChainId'], null,
            StreamMessage.CONTENT_TYPES.MESSAGE, StreamMessage.ENCRYPTION_TYPES.NONE, {
                foo: 'bar'
            }, StreamMessage.SIGNATURE_TYPES.NONE, null,
        )
        EncryptionUtil.encryptStreamMessageAndNewKey(newKey, streamMessage, key)
        const newKeyReceived = EncryptionUtil.decryptStreamMessage(streamMessage, key)
        assert.deepStrictEqual(newKeyReceived, newKey)
        assert.deepStrictEqual(streamMessage.getSerializedContent(), '{"foo":"bar"}')
        assert.deepStrictEqual(streamMessage.encryptionType, StreamMessage.ENCRYPTION_TYPES.NONE)
    })
    it('throws if invalid public key passed in the constructor', () => {
        const keys = crypto.generateKeyPairSync('rsa', {
            modulusLength: 4096,
            publicKeyEncoding: {
                type: 'pkcs1',
                format: 'pem',
            },
            privateKeyEncoding: {
                type: 'pkcs1',
                format: 'pem',
            },
        })
        assert.throws(() => {
            // eslint-disable-next-line no-new
            new EncryptionUtil({
                privateKey: keys.privateKey,
                publicKey: 'wrong public key',
            })
        }, /Error/)
    })
    it('throws if invalid private key passed in the constructor', () => {
        const keys = crypto.generateKeyPairSync('rsa', {
            modulusLength: 4096,
            publicKeyEncoding: {
                type: 'pkcs1',
                format: 'pem',
            },
            privateKeyEncoding: {
                type: 'pkcs1',
                format: 'pem',
            },
        })
        assert.throws(() => {
            // eslint-disable-next-line no-new
            new EncryptionUtil({
                privateKey: 'wrong private key',
                publicKey: keys.publicKey,
            })
        }, /Error/)
    })
    it('does not throw if valid key pair passed in the constructor', () => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
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
        // eslint-disable-next-line no-new
        new EncryptionUtil({
            privateKey,
            publicKey,
        })
    })
    it('validateGroupKey() throws if key is the wrong size', () => {
        assert.throws(() => {
            EncryptionUtil.validateGroupKey(crypto.randomBytes(16))
        }, /Error/)
    })
    it('validateGroupKey() throws if key is not a buffer', () => {
        assert.throws(() => {
            EncryptionUtil.validateGroupKey(ethers.utils.hexlify(crypto.randomBytes(32)))
        }, /Error/)
    })
    it('validateGroupKey() does not throw', () => {
        EncryptionUtil.validateGroupKey(crypto.randomBytes(32))
    })
})
