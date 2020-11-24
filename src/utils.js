import { v4 as uuidv4 } from 'uuid'
import uniqueId from 'lodash.uniqueid'
import LRU from 'quick-lru'
import pMemoize from 'p-memoize'
import pLimit from 'p-limit'
import mem from 'mem'

import pkg from '../package.json'

const UUID = uuidv4()

export function uuid(label = '') {
    return uniqueId(`${UUID}${label ? `.${label}` : ''}`) // incrementing + human readable uuid
}

export function getVersionString() {
    const isProduction = process.env.NODE_ENV === 'production'
    return `${pkg.version}${!isProduction ? 'dev' : ''}`
}

/**
 * Converts a .once event listener into a promise.
 * Rejects if an 'error' event is received before resolving.
 */

export function waitFor(emitter, event) {
    return new Promise((resolve, reject) => {
        let onError
        const onEvent = (value) => {
            emitter.off('error', onError)
            resolve(value)
        }
        onError = (error) => {
            emitter.off(event, onEvent)
            reject(error)
        }

        emitter.once(event, onEvent)
        emitter.once('error', onError)
    })
}

/* eslint-disable object-curly-newline */

/**
 * Returns a cached async fn, cached keyed on first argument passed. See documentation for mem/p-memoize.
 * Caches into a LRU cache capped at options.maxSize
 * Won't call asyncFn again until options.maxAge or options.maxSize exceeded, or cachedAsyncFn.clear() is called.
 * Won't cache rejections by default. Override with options.cachePromiseRejection = true.
 *
 * ```js
 * const cachedAsyncFn = CacheAsyncFn(asyncFn, options)
 * await cachedAsyncFn(key)
 * await cachedAsyncFn(key)
 * cachedAsyncFn.clear()
 * ```
 */

export function CacheAsyncFn(asyncFn, {
    maxSize = 10000,
    maxAge = 30 * 60 * 1000, // 30 minutes
    cachePromiseRejection = false,
} = {}) {
    const cachedFn = pMemoize(asyncFn, {
        maxAge,
        cachePromiseRejection,
        cache: new LRU({
            maxSize,
        })
    })
    cachedFn.clear = () => pMemoize.clear(cachedFn)
    return cachedFn
}

/**
 * Returns a cached fn, cached keyed on first argument passed. See documentation for mem.
 * Caches into a LRU cache capped at options.maxSize
 * Won't call fn again until options.maxAge or options.maxSize exceeded, or cachedFn.clear() is called.
 *
 * ```js
 * const cachedFn = CacheFn(fn, options)
 * cachedFn(key)
 * cachedFn(key)
 * cachedFn(...args)
 * cachedFn.clear()
 * ```
 */

export function CacheFn(fn, {
    maxSize = 10000,
    maxAge = 30 * 60 * 1000, // 30 minutes
} = {}) {
    const cachedFn = mem(fn, {
        maxAge,
        cache: new LRU({
            maxSize,
        })
    })
    cachedFn.clear = () => mem.clear(cachedFn)
    return cachedFn
}

/* eslint-enable object-curly-newline */

/**
 * Returns a limit function that limits concurrency per-key.
 *
 * ```js
 * const limit = LimitAsyncFnByKey(1)
 * limit('channel1', fn)
 * limit('channel2', fn)
 * limit('channel2', fn)
 * ```
 */

export function LimitAsyncFnByKey(limit) {
    const pending = new Map()
    const f = async (id, fn) => {
        const limitFn = pending.get(id) || pending.set(id, pLimit(limit)).get(id)
        try {
            return await limitFn(fn)
        } finally {
            if (!limitFn.activeCount && !limitFn.pendingCount && pending.get(id) === limitFn) {
                // clean up if no more active entries (if not cleared)
                pending.delete(id)
            }
        }
    }
    f.clear = () => {
        // note: does not cancel promises
        pending.forEach((p) => p.clearQueue())
        pending.clear()
    }
    return f
}

