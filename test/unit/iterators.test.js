import { wait } from 'streamr-test-utils'

import { iteratorFinally, CancelableGenerator, pipeline } from '../../src/utils/iterators'
import { Defer } from '../../src/utils'
import PushQueue from '../../src/utils/PushQueue'

import IteratorTest, { expected, MAX_ITEMS } from './IteratorTest'

const WAIT = 20

async function* generate(items = expected, waitTime = WAIT) {
    await wait(waitTime * 0.1)
    for await (const item of items) {
        await wait(waitTime * 0.1)
        yield item
        await wait(waitTime * 0.1)
    }
    await wait(waitTime * 0.1)
}

async function* generateThrow(items = expected, { max = MAX_ITEMS, err = new Error('expected') }) {
    let index = 0
    await wait(WAIT * 0.1)
    for await (const item of items) {
        index += 1
        await wait(WAIT * 0.1)
        if (index > max) {
            throw err
        }
        yield item
        await wait(WAIT * 0.1)
    }
    await wait(WAIT * 0.1)
}

describe('Iterator Utils', () => {
    describe('compare native generators', () => {
        IteratorTest('baseline', () => generate())
    })

    describe('iteratorFinally', () => {
        let onFinally
        let onFinallyAfter

        beforeEach(() => {
            onFinallyAfter = jest.fn()
            onFinally = jest.fn(async () => {
                await wait(WAIT)
                onFinallyAfter()
            })
        })

        afterEach(() => {
            expect(onFinally).toHaveBeenCalledTimes(1)
            expect(onFinallyAfter).toHaveBeenCalledTimes(1)
        })

        describe('iteratorFinally iteratorTests', () => {
            IteratorTest('iteratorFinally', () => iteratorFinally(generate(), onFinally))
        })

        it('runs fn when iterator.return() is called asynchronously', async () => {
            const done = Defer()
            try {
                const received = []
                const itr = iteratorFinally(generate(), onFinally)
                const onTimeoutReached = jest.fn()
                let receievedAtCallTime
                for await (const msg of itr) {
                    received.push(msg)
                    if (received.length === MAX_ITEMS) {
                        // eslint-disable-next-line no-loop-func
                        setTimeout(done.wrap(() => {
                            onTimeoutReached()
                            receievedAtCallTime = received
                            itr.return()
                        }))
                    }
                }

                expect(onTimeoutReached).toHaveBeenCalledTimes(1)
                expect(received).toEqual(receievedAtCallTime)
            } finally {
                await done
            }
        })

        it('runs fn when iterator returns + breaks during iteration', async () => {
            const received = []
            const itr = iteratorFinally(generate(), onFinally)
            for await (const msg of itr) {
                received.push(msg)
                if (received.length === MAX_ITEMS) {
                    itr.return() // no await
                    break
                }
            }
            expect(received).toEqual(expected.slice(0, MAX_ITEMS))
        })

        it('does not call inner iterators onFinally with error if outer errors', async () => {
            // maybe not desirable, but captures existing behaviour.
            // this matches native generator/iterator behaviour, at most outermost iteration errors
            const received = []
            const err = new Error('expected err')
            const itr = iteratorFinally(generate(), onFinally)
            await expect(async () => {
                for await (const msg of itr) {
                    received.push(msg)
                    if (received.length === MAX_ITEMS) {
                        throw err
                    }
                }
            }).rejects.toThrow(err)
            expect(received).toEqual(expected.slice(0, MAX_ITEMS))
            expect(onFinally).not.toHaveBeenCalledWith(err)
        })

        it('runs fn when iterator returns + throws during iteration', async () => {
            const received = []
            const err = new Error('expected err')
            const itr = iteratorFinally(generate(), onFinally)
            await expect(async () => {
                for await (const msg of itr) {
                    received.push(msg)
                    if (received.length === MAX_ITEMS) {
                        itr.return() // no await
                        throw err
                    }
                }
            }).rejects.toThrow(err)
            expect(received).toEqual(expected.slice(0, MAX_ITEMS))
            expect(onFinally).not.toHaveBeenCalledWith(err) // just outer onFinally will have err
        })

        it('runs fn when iterator returns before iteration', async () => {
            const received = []
            const itr = iteratorFinally(generate(), onFinally)
            await itr.return()
            expect(onFinally).toHaveBeenCalledTimes(1)
            expect(onFinallyAfter).toHaveBeenCalledTimes(1)
            for await (const msg of itr) {
                received.push(msg)
            }
            expect(received).toEqual([])
        })

        it('runs fn when iterator returns before iteration', async () => {
            const received = []
            const onStarted = jest.fn()
            const itr = iteratorFinally((async function* Test() {
                onStarted()
                yield* generate()
            }()), async () => {
                await wait(WAIT * 5)
                await onFinally()
            })
            itr.return() // no await
            for await (const msg of itr) {
                received.push(msg)
            }
            expect(onStarted).toHaveBeenCalledTimes(0)
            expect(received).toEqual([])
        })

        it('runs finally once, waits for outstanding if returns before iteration', async () => {
            const received = []
            const itr = iteratorFinally(generate(), onFinally)

            const t1 = itr.return()
            const t2 = itr.return()
            await Promise.race([t1, t2])
            expect(onFinally).toHaveBeenCalledTimes(1)
            expect(onFinallyAfter).toHaveBeenCalledTimes(1)
            await Promise.all([t1, t2])
            expect(onFinally).toHaveBeenCalledTimes(1)
            expect(onFinallyAfter).toHaveBeenCalledTimes(1)
            for await (const msg of itr) {
                received.push(msg)
            }

            expect(received).toEqual([])
        })

        it('runs fn when iterator throws before iteration', async () => {
            const received = []
            const err = new Error('expected err')
            const itr = iteratorFinally(generate(), onFinally)
            await expect(async () => itr.throw(err)).rejects.toThrow(err)
            expect(onFinally).toHaveBeenCalledTimes(1)
            expect(onFinallyAfter).toHaveBeenCalledTimes(1)
            // NOTE: doesn't throw, matches native iterators
            for await (const msg of itr) {
                received.push(msg)
            }
            expect(received).toEqual([])
        })

        it('runs fn when inner iterator throws during iteration', async () => {
            const received = []
            const err = new Error('expected err')
            const itr = iteratorFinally(generateThrow(expected, {
                err,
            }), onFinally)
            await expect(async () => {
                for await (const msg of itr) {
                    received.push(msg)
                }
            }).rejects.toThrow(err)
            expect(onFinally).toHaveBeenCalledTimes(1)
            expect(onFinallyAfter).toHaveBeenCalledTimes(1)
            expect(received).toEqual(expected.slice(0, MAX_ITEMS))
        })

        it('errored before start iterator works if onFinally is async', async () => {
            const received = []
            const errs = []
            const onFinallyDelayed = jest.fn(async (err) => {
                errs.push(err)
                await wait(100)
                return onFinally(err)
            })
            const itr = iteratorFinally(generate(), onFinallyDelayed)
            const err = new Error('expected err 1')
            await expect(async () => {
                await itr.throw(err)
            }).rejects.toThrow(err)
            for await (const msg of itr) {
                received.push(msg)
            }
            expect(received).toEqual([])
            expect(onFinallyDelayed).toHaveBeenCalledTimes(1)
            expect(errs).toEqual([err])
        })

        it('errored iterator works if onFinally is async', async () => {
            const received = []
            const errs = []
            const onFinallyDelayed = jest.fn(async (err) => {
                errs.push(err)
                await wait(100)
                return onFinally(err)
            })
            const itr = iteratorFinally(generate(), onFinallyDelayed)
            const err = new Error('expected err 2')
            await expect(async () => {
                for await (const msg of itr) {
                    received.push(msg)
                    if (received.length === MAX_ITEMS) {
                        await itr.throw(err)
                    }
                }
            }).rejects.toThrow(err)

            expect(received).toEqual(expected.slice(0, MAX_ITEMS))
            expect(onFinallyDelayed).toHaveBeenCalledTimes(1)
            expect(errs).toEqual([err])
        })

        describe('nesting', () => {
            let onFinallyInnerAfter
            let onFinallyInner

            beforeEach(() => {
                onFinallyInnerAfter = jest.fn()
                const afterInner = onFinallyInnerAfter // capture so won't run afterInner of another test
                onFinallyInner = jest.fn(async () => {
                    await wait(WAIT)
                    afterInner()
                })
            })

            afterEach(() => {
                expect(onFinallyInner).toHaveBeenCalledTimes(1)
                expect(onFinallyInnerAfter).toHaveBeenCalledTimes(1)
            })

            IteratorTest('iteratorFinally nested', () => {
                const itrInner = iteratorFinally(generate(), onFinallyInner)
                return iteratorFinally(itrInner, onFinally)
            })

            it('works nested', async () => {
                const itrInner = iteratorFinally(generate(), onFinallyInner)
                const itr = iteratorFinally(itrInner, onFinally)

                const received = []
                for await (const msg of itr) {
                    received.push(msg)
                    if (received.length === MAX_ITEMS) {
                        break
                    }
                }

                expect(received).toEqual(expected.slice(0, MAX_ITEMS))
            })

            it('calls iterator onFinally with error if outer errors', async () => {
                const received = []
                const err = new Error('expected err')
                const innerItr = iteratorFinally(generate(), onFinallyInner)
                const itr = iteratorFinally((async function* Outer() {
                    for await (const msg of innerItr) {
                        yield msg
                        if (received.length === MAX_ITEMS) {
                            throw err
                        }
                    }
                }()), onFinally)

                await expect(async () => {
                    for await (const msg of itr) {
                        received.push(msg)
                    }
                }).rejects.toThrow(err)

                expect(received).toEqual(expected.slice(0, MAX_ITEMS))
                expect(onFinally).toHaveBeenCalledWith(err)
                expect(onFinallyInner).not.toHaveBeenCalledWith(err)
            })

            it('calls iterator onFinally with error if inner errors', async () => {
                const received = []
                const err = new Error('expected err')
                const itrInner = iteratorFinally((async function* Outer() {
                    for await (const msg of generate()) {
                        yield msg
                        if (received.length === MAX_ITEMS) {
                            throw err
                        }
                    }
                }()), onFinallyInner)
                const itr = iteratorFinally(itrInner, onFinally)

                await expect(async () => {
                    for await (const msg of itr) {
                        received.push(msg)
                    }
                }).rejects.toThrow(err)

                expect(received).toEqual(expected.slice(0, MAX_ITEMS))
                // both should see error
                expect(onFinally).toHaveBeenCalledWith(err)
                expect(onFinallyInner).toHaveBeenCalledWith(err)
            })
        })

        it('runs finally once, waits for outstanding', async () => {
            const received = []
            const itr = iteratorFinally(generate(), onFinally)

            for await (const msg of itr) {
                received.push(msg)
                if (received.length === MAX_ITEMS) {
                    const t1 = itr.return()
                    const t2 = itr.return()
                    await Promise.race([t1, t2])
                    expect(onFinally).toHaveBeenCalledTimes(1)
                    expect(onFinallyAfter).toHaveBeenCalledTimes(1)
                    await Promise.all([t1, t2])
                    expect(onFinally).toHaveBeenCalledTimes(1)
                    expect(onFinallyAfter).toHaveBeenCalledTimes(1)
                    break
                }
            }

            expect(received).toEqual(expected.slice(0, MAX_ITEMS))
        })
    })

    describe('CancelableGenerator', () => {
        let onFinally
        let onFinallyAfter

        beforeEach(() => {
            onFinallyAfter = jest.fn()
            onFinally = jest.fn(async () => {
                await wait(WAIT)
                onFinallyAfter()
            })
        })

        afterEach(() => {
            expect(onFinally).toHaveBeenCalledTimes(1)
            expect(onFinallyAfter).toHaveBeenCalledTimes(1)
        })

        IteratorTest('CancelableGenerator', () => {
            return CancelableGenerator(generate(), onFinally)
        })

        it('can cancel during iteration', async () => {
            const itr = CancelableGenerator(generate(), onFinally)
            const received = []
            for await (const msg of itr) {
                received.push(msg)
                if (received.length === MAX_ITEMS) {
                    itr.cancel()
                }
            }

            expect(received).toEqual(expected.slice(0, MAX_ITEMS))
            expect(itr.isCancelled()).toEqual(true)
        })

        it('can cancel before iteration', async () => {
            const itr = CancelableGenerator(generate(), onFinally)
            const received = []
            itr.cancel()
            expect(itr.isCancelled()).toEqual(true)
            for await (const msg of itr) {
                received.push(msg)
            }

            expect(received).toEqual([])
            expect(itr.isCancelled()).toEqual(true)
        })

        it('can cancel with error before iteration', async () => {
            const itr = CancelableGenerator(generate(), () => {
                return onFinally()
            })
            const received = []
            const err = new Error('expected')
            itr.cancel(err)
            await expect(async () => {
                for await (const msg of itr) {
                    received.push(msg)
                }
            }).rejects.toThrow(err)

            expect(received).toEqual([])
        })

        it('cancels with error when iterator.cancel(err) is called asynchronously with error', async () => {
            const done = Defer()
            try {
                const err = new Error('expected')
                const received = []
                const itr = CancelableGenerator(generate(), onFinally, {
                    timeout: WAIT,
                })
                let receievedAtCallTime
                await expect(async () => {
                    for await (const msg of itr) {
                        received.push(msg)
                        if (received.length === MAX_ITEMS) {
                            // eslint-disable-next-line no-loop-func
                            setTimeout(done.wrap(async () => {
                                receievedAtCallTime = received
                                await itr.cancel(err)
                                expect(onFinally).toHaveBeenCalledTimes(1)
                                expect(onFinallyAfter).toHaveBeenCalledTimes(1)
                            }))
                        }
                    }
                }).rejects.toThrow(err)

                expect(received).toEqual(receievedAtCallTime)
                expect(itr.isCancelled()).toEqual(true)
            } catch (err) {
                done.reject(err)
            } finally {
                await done
            }
        })

        it('cancels when iterator.cancel() is called asynchronously', async () => {
            const done = Defer()
            try {
                const received = []
                const itr = CancelableGenerator(generate(), onFinally, {
                    timeout: WAIT,
                })
                let receievedAtCallTime
                for await (const msg of itr) {
                    received.push(msg)
                    if (received.length === MAX_ITEMS) {
                        // eslint-disable-next-line no-loop-func
                        setTimeout(done.wrap(async () => {
                            receievedAtCallTime = received
                            await itr.cancel()
                            expect(onFinally).toHaveBeenCalledTimes(1)
                            expect(onFinallyAfter).toHaveBeenCalledTimes(1)
                        }))
                    }
                }

                expect(received).toEqual(receievedAtCallTime)
                expect(itr.isCancelled()).toEqual(true)
            } finally {
                await done
            }
        })

        it('prevents subsequent .next call', async () => {
            const received = []
            const triggeredForever = jest.fn()
            const itr = CancelableGenerator((async function* Gen() {
                yield* expected
                yield await new Promise(() => {
                    triggeredForever() // should not get here
                })
            }()), onFinally)

            for await (const msg of itr) {
                received.push(msg)
                if (received.length === expected.length) {
                    await itr.cancel()
                    expect(onFinally).toHaveBeenCalledTimes(1)
                    expect(onFinallyAfter).toHaveBeenCalledTimes(1)
                }
            }

            expect(triggeredForever).toHaveBeenCalledTimes(0)
            expect(received).toEqual(expected)
            expect(itr.isCancelled()).toEqual(true)
        })

        it('interrupts outstanding .next call', async () => {
            const received = []
            const triggeredForever = jest.fn()
            const itr = CancelableGenerator((async function* Gen() {
                yield* expected
                yield await new Promise(() => {
                    triggeredForever()
                    itr.cancel()
                }) // would wait forever
            }()), onFinally)

            for await (const msg of itr) {
                received.push(msg)
            }

            expect(triggeredForever).toHaveBeenCalledTimes(1)
            expect(received).toEqual(expected)
            expect(itr.isCancelled()).toEqual(true)
        })

        it('interrupts outstanding .next call when called asynchronously', async () => {
            const done = Defer()
            try {
                const received = []
                const triggeredForever = jest.fn()
                const itr = CancelableGenerator((async function* Gen() {
                    yield* expected
                    yield await new Promise(() => {
                        triggeredForever()
                    }) // would wait forever
                }()), onFinally, {
                    timeout: WAIT,
                })

                for await (const msg of itr) {
                    received.push(msg)
                    if (received.length === expected.length) {
                        // eslint-disable-next-line no-loop-func
                        setTimeout(done.wrap(async () => {
                            await itr.cancel()
                            expect(onFinally).toHaveBeenCalledTimes(1)
                            expect(onFinallyAfter).toHaveBeenCalledTimes(1)
                        }))
                    }
                }

                expect(received).toEqual(expected)
                expect(itr.isCancelled()).toEqual(true)
            } finally {
                await done
            }
        })

        it('stops iterator', async () => {
            const shouldRunFinally = jest.fn()
            const itr = CancelableGenerator((async function* Gen() {
                try {
                    yield 1
                    await wait(WAIT)
                    yield 2
                    await wait(WAIT)
                    yield 3
                } finally {
                    shouldRunFinally()
                }
            }()), onFinally, {
                timeout: WAIT * 2
            })

            const received = []
            for await (const msg of itr) {
                received.push(msg)
                if (received.length === 2) {
                    itr.cancel()
                    expect(itr.isCancelled()).toEqual(true)
                }
            }

            expect(received).toEqual([1, 2])
            await wait(WAIT)
            expect(onFinally).toHaveBeenCalledTimes(1)
            expect(shouldRunFinally).toHaveBeenCalledTimes(1)
            expect(itr.isCancelled()).toEqual(true)
        })

        it('interrupts outstanding .next call with error', async () => {
            const done = Defer()
            try {
                const received = []
                const itr = CancelableGenerator((async function* Gen() {
                    yield* expected
                    yield await new Promise(() => {}) // would wait forever
                }()), onFinally, {
                    timeout: WAIT,
                })

                const err = new Error('expected')

                let receievedAtCallTime
                await expect(async () => {
                    for await (const msg of itr) {
                        received.push(msg)
                        if (received.length === MAX_ITEMS) {
                            // eslint-disable-next-line no-loop-func
                            setTimeout(done.wrap(async () => {
                                receievedAtCallTime = received
                                await itr.cancel(err)

                                expect(onFinally).toHaveBeenCalledTimes(1)
                                expect(onFinallyAfter).toHaveBeenCalledTimes(1)
                            }))
                        }
                    }
                }).rejects.toThrow(err)

                expect(received).toEqual(receievedAtCallTime)
                expect(itr.isCancelled()).toEqual(true)
            } finally {
                await done
            }
        })

        it('can handle queued next calls', async () => {
            const done = Defer()
            try {
                const triggeredForever = jest.fn()
                const itr = CancelableGenerator((async function* Gen() {
                    yield* expected
                    setTimeout(done.wrap(async () => {
                        await itr.cancel()

                        expect(onFinally).toHaveBeenCalledTimes(1)
                        expect(onFinallyAfter).toHaveBeenCalledTimes(1)
                    }), WAIT * 2)
                    yield await new Promise(() => {
                        triggeredForever()
                    }) // would wait forever
                }()), onFinally, {
                    timeout: WAIT,
                })

                const tasks = expected.map(async () => itr.next())
                tasks.push(itr.next()) // one more over the edge (should trigger forever promise)
                const received = await Promise.all(tasks)
                expect(received.map(({ value }) => value)).toEqual([...expected, undefined])
                expect(triggeredForever).toHaveBeenCalledTimes(1)
                expect(itr.isCancelled()).toEqual(true)
            } finally {
                await done
            }
        })

        it('can handle errs when queued next calls', async () => {
            const expectedError = new Error('expected')
            const itr = CancelableGenerator((async function* Gen() {
                yield* generate(expected, 1000)
            }()), onFinally, {
                timeout: WAIT,
            })

            const tasks = expected.map(async () => itr.next())
            await wait(100)
            await itr.cancel(expectedError)
            const result = await Promise.allSettled(tasks)
            // first is error
            expect(result[0]).toEqual({ status: 'rejected', reason: expectedError })
            // rest is undefined result
            // not sure what good behaviour should be in this case
            expect(result.slice(1)).toEqual(result.slice(1).map(() => ({
                status: 'fulfilled',
                value: {
                    value: undefined,
                    done: true
                }
            })))
            expect(itr.isCancelled()).toEqual(true)
        }, 10000)

        it('can handle queued next calls resolving out of order', async () => {
            const done = Defer()
            try {
                const triggeredForever = jest.fn()
                const itr = CancelableGenerator((async function* Gen() {
                    let i = 0
                    for await (const v of expected) {
                        i += 1
                        await wait((expected.length - i - 1) * 2 * WAIT)
                        yield v
                    }

                    setTimeout(done.wrap(async () => {
                        await itr.cancel()

                        expect(onFinally).toHaveBeenCalledTimes(1)
                        expect(onFinallyAfter).toHaveBeenCalledTimes(1)
                    }), WAIT * 2)

                    yield await new Promise(() => {
                        triggeredForever()
                    }) // would wait forever
                }()), onFinally, {
                    timeout: WAIT,
                })

                const tasks = expected.map(async () => itr.next())
                tasks.push(itr.next()) // one more over the edge (should trigger forever promise)
                const received = await Promise.all(tasks)
                expect(received.map(({ value }) => value)).toEqual([...expected, undefined])
                expect(triggeredForever).toHaveBeenCalledTimes(1)
            } finally {
                await done
            }
        })

        it('ignores err if cancelled', async () => {
            const done = Defer()
            try {
                const received = []
                const err = new Error('expected')
                const d = Defer()
                const itr = CancelableGenerator((async function* Gen() {
                    yield* expected
                    await wait(WAIT * 2)
                    d.resolve()
                    throw new Error('should not see this')
                }()), onFinally)

                let receievedAtCallTime
                await expect(async () => {
                    for await (const msg of itr) {
                        received.push(msg)
                        if (received.length === MAX_ITEMS) {
                            // eslint-disable-next-line no-loop-func
                            setTimeout(done.wrap(async () => {
                                receievedAtCallTime = received
                                await itr.cancel(err)

                                expect(onFinally).toHaveBeenCalledTimes(1)
                                expect(onFinallyAfter).toHaveBeenCalledTimes(1)
                            }))
                        }
                    }
                }).rejects.toThrow(err)

                await d
                await wait(WAIT * 2)

                expect(received).toEqual(receievedAtCallTime)
            } finally {
                await done
            }
        })

        describe('nesting', () => {
            let onFinallyInnerAfter
            let onFinallyInner

            beforeEach(() => {
                onFinallyInnerAfter = jest.fn()
                const afterInner = onFinallyInnerAfter // capture so won't run afterInner of another test
                onFinallyInner = jest.fn(async () => {
                    await wait(WAIT)
                    afterInner()
                })
            })

            afterEach(() => {
                expect(onFinallyInner).toHaveBeenCalledTimes(1)
                expect(onFinallyInnerAfter).toHaveBeenCalledTimes(1)
            })

            IteratorTest('CancelableGenerator nested', () => {
                const itrInner = CancelableGenerator(generate(), onFinallyInner)
                const itrOuter = CancelableGenerator(itrInner, onFinally)
                return itrOuter
            })

            it('can cancel nested cancellable iterator in finally', async () => {
                const waitInner = jest.fn()
                const itrInner = CancelableGenerator((async function* Gen() {
                    yield* generate()
                    yield await new Promise(() => {
                        // should not get here
                        waitInner()
                    }) // would wait forever
                }()), onFinallyInner, {
                    timeout: WAIT,
                })

                const waitOuter = jest.fn()
                const itrOuter = CancelableGenerator((async function* Gen() {
                    yield* itrInner
                    yield await new Promise(() => {
                        // should not get here
                        waitOuter()
                    }) // would wait forever
                }()), async () => {
                    await itrInner.cancel()
                    expect(onFinallyInner).toHaveBeenCalledTimes(1)
                    expect(onFinallyInnerAfter).toHaveBeenCalledTimes(1)
                    await onFinally()
                }, {
                    timeout: WAIT,
                })

                const received = []
                for await (const msg of itrOuter) {
                    received.push(msg)
                    if (received.length === expected.length) {
                        await itrOuter.cancel()
                    }
                }

                expect(received).toEqual(expected)
                expect(waitOuter).toHaveBeenCalledTimes(0)
                expect(waitInner).toHaveBeenCalledTimes(0)
            })

            it('can cancel nested cancellable iterator in finally, asynchronously', async () => {
                const done = Defer()
                try {
                    const waitInner = jest.fn()
                    const itrInner = CancelableGenerator((async function* Gen() {
                        yield* generate()
                        yield await new Promise(() => {
                            // should not get here
                            waitInner()
                        }) // would wait forever
                    }()), onFinallyInner, {
                        timeout: WAIT,
                    })

                    const waitOuter = jest.fn()
                    const itrOuter = CancelableGenerator((async function* Gen() {
                        yield* itrInner
                        yield await new Promise(() => {
                            // should not get here
                            waitOuter()
                        }) // would wait forever
                    }()), async () => {
                        await itrInner.cancel()
                        await onFinally()
                    }, {
                        timeout: WAIT,
                    })

                    const received = []
                    for await (const msg of itrOuter) {
                        received.push(msg)
                        if (received.length === expected.length) {
                            setTimeout(done.wrap(() => {
                                itrOuter.cancel()
                            }))
                        }
                    }

                    expect(waitOuter).toHaveBeenCalledTimes(1)
                    expect(waitInner).toHaveBeenCalledTimes(1)
                    expect(received).toEqual(expected)
                } finally {
                    await done
                }
            })
        })

        it('can cancel in parallel and wait correctly for both', async () => {
            const itr = CancelableGenerator(generate(), onFinally)
            const ranTests = jest.fn()

            const received = []
            for await (const msg of itr) {
                received.push(msg)
                if (received.length === MAX_ITEMS) {
                    const t1 = itr.cancel()
                    const t2 = itr.cancel()
                    await Promise.race([t1, t2])
                    expect(onFinally).toHaveBeenCalledTimes(1)
                    expect(onFinallyAfter).toHaveBeenCalledTimes(1)
                    await Promise.all([t1, t2])
                    expect(onFinally).toHaveBeenCalledTimes(1)
                    expect(onFinallyAfter).toHaveBeenCalledTimes(1)
                    ranTests()
                }
            }

            expect(ranTests).toHaveBeenCalledTimes(1)
            expect(received).toEqual(expected.slice(0, MAX_ITEMS))
        })
    })

    describe('pipeline', () => {
        let onFinally
        let onFinallyAfter
        let errors = []

        beforeEach(() => {
            errors = []
            const errorsLocal = errors
            onFinallyAfter = jest.fn((err) => {
                if (errorsLocal !== errors) { return } // cross-contaminated test

                if (err) {
                    errors.push(err)
                }
            })

            onFinally = jest.fn(async (err) => {
                await wait(WAIT)
                onFinallyAfter(err)
            })
        })

        afterEach(() => {
            expect(onFinally).toHaveBeenCalledTimes(1)
            expect(onFinallyAfter).toHaveBeenCalledTimes(1)
        })

        describe('baseline', () => {
            IteratorTest('pipeline', () => {
                return pipeline([
                    generate(),
                    async function* Step1(s) {
                        for await (const msg of s) {
                            yield msg * 2
                        }
                    },
                    async function* Step2(s) {
                        for await (const msg of s) {
                            yield msg / 2
                        }
                    }
                ], onFinally)
            })
        })

        it('feeds items from one to next', async () => {
            const receivedStep1 = []
            const receivedStep2 = []
            const afterStep1 = jest.fn()
            const afterStep2 = jest.fn()

            const p = pipeline([
                generate(),
                async function* Step1(s) {
                    try {
                        for await (const msg of s) {
                            receivedStep1.push(msg)
                            yield msg * 2
                        }
                    } finally {
                        afterStep1()
                    }
                },
                async function* Step2(s) {
                    try {
                        for await (const msg of s) {
                            receivedStep2.push(msg)
                            yield msg * 10
                        }
                    } finally {
                        // ensure async finally works
                        await wait(WAIT)
                        afterStep2()
                    }
                }
            ], onFinally)

            const received = []
            for await (const msg of p) {
                received.push(msg)
            }

            expect(received).toEqual(expected.map((v) => v * 20))
            expect(receivedStep2).toEqual(expected.map((v) => v * 2))
            expect(receivedStep1).toEqual(expected)
            expect(afterStep1).toHaveBeenCalledTimes(1)
            expect(afterStep2).toHaveBeenCalledTimes(1)
        })

        it('feeds items from one to next, stops all when start ends', async () => {
            const receivedStep1 = []
            const receivedStep2 = []
            const afterStep1 = jest.fn()
            const afterStep2 = jest.fn()
            const p = pipeline([
                expected,
                async function* Step1(s) {
                    try {
                        for await (const msg of s) {
                            receivedStep1.push(msg)
                            yield msg * 2
                        }
                    } finally {
                        afterStep1()
                    }
                },
                async function* Step2(s) {
                    try {
                        for await (const msg of s) {
                            receivedStep2.push(msg)
                            yield msg * 10
                        }
                    } finally {
                        afterStep2()
                    }
                }
            ], onFinally)

            const received = []
            for await (const msg of p) {
                received.push(msg)
            }

            expect(received).toEqual(expected.map((v) => v * 20))
            expect(receivedStep2).toEqual(expected.map((v) => v * 2))
            expect(receivedStep1).toEqual(expected)
            expect(afterStep1).toHaveBeenCalledTimes(1)
            expect(afterStep2).toHaveBeenCalledTimes(1)
        })

        it('feeds items from one to next, stops all when middle ends', async () => {
            const receivedStep1 = []
            const receivedStep2 = []
            const afterStep1 = jest.fn()
            const afterStep2 = jest.fn()

            const p = pipeline([
                generate(),
                async function* Step1(s) {
                    try {
                        for await (const msg of s) {
                            receivedStep1.push(msg)
                            yield msg * 2
                            if (receivedStep1.length === MAX_ITEMS) {
                                break
                            }
                        }
                    } finally {
                        afterStep1()
                    }
                },
                async function* Step2(s) {
                    try {
                        for await (const msg of s) {
                            receivedStep2.push(msg)
                            yield msg * 10
                        }
                    } finally {
                        afterStep2()
                    }
                }
            ], onFinally)

            const received = []
            for await (const msg of p) {
                received.push(msg)
            }

            expect(received).toEqual(expected.slice(0, MAX_ITEMS).map((v) => v * 20))
            expect(receivedStep2).toEqual(expected.slice(0, MAX_ITEMS).map((v) => v * 2))
            expect(receivedStep1).toEqual(expected.slice(0, MAX_ITEMS))
            expect(afterStep1).toHaveBeenCalledTimes(1)
            expect(afterStep2).toHaveBeenCalledTimes(1)
        })

        it('feeds items from one to next, stops all when middle throws', async () => {
            const receivedStep1 = []
            const receivedStep2 = []
            const afterStep1 = jest.fn()
            const afterStep2 = jest.fn()
            const err = new Error('expected')

            const p = pipeline([
                generate(),
                async function* Step1(s) {
                    try {
                        for await (const msg of s) {
                            receivedStep1.push(msg)
                            yield msg * 2
                            if (receivedStep1.length === MAX_ITEMS) {
                                throw err
                            }
                        }
                    } finally {
                        afterStep1()
                    }
                },
                async function* Step2(s) {
                    try {
                        for await (const msg of s) {
                            receivedStep2.push(msg)
                            yield msg * 10
                        }
                    } finally {
                        afterStep2()
                    }
                }
            ], onFinally)

            const received = []
            await expect(async () => {
                for await (const msg of p) {
                    received.push(msg)
                }
            }).rejects.toThrow(err)

            expect(received).toEqual(expected.slice(0, MAX_ITEMS).map((v) => v * 20))
            expect(receivedStep2).toEqual(expected.slice(0, MAX_ITEMS).map((v) => v * 2))
            expect(receivedStep1).toEqual(expected.slice(0, MAX_ITEMS))
            expect(afterStep1).toHaveBeenCalledTimes(1)
            expect(afterStep2).toHaveBeenCalledTimes(1)
        })

        it('feeds items from one to next, stops & errors all when middle .throws()', async () => {
            const receivedStep1 = []
            const receivedStep2 = []
            const afterStep1 = jest.fn()
            const afterStep2 = jest.fn()
            const catchStep1 = jest.fn()
            const catchStep2 = jest.fn()
            const err = new Error('expected')

            const p = pipeline([
                generate(),
                async function* Step1(s) {
                    try {
                        for await (const msg of s) {
                            receivedStep1.push(msg)
                            yield msg * 2
                            if (receivedStep1.length === MAX_ITEMS) {
                                await s.throw(err)
                            }
                        }
                    } catch (error) {
                        catchStep1(error)
                        throw error
                    } finally {
                        afterStep1()
                    }
                },
                async function* Step2(s) {
                    try {
                        for await (const msg of s) {
                            receivedStep2.push(msg)
                            yield msg * 10
                        }
                    } catch (error) {
                        catchStep2(error)
                        throw error
                    } finally {
                        afterStep2()
                    }
                }
            ], onFinally)

            const received = []
            await expect(async () => {
                for await (const msg of p) {
                    received.push(msg)
                }
            }).rejects.toThrow(err)

            expect(received).toEqual(expected.slice(0, MAX_ITEMS).map((v) => v * 20))
            expect(receivedStep2).toEqual(expected.slice(0, MAX_ITEMS).map((v) => v * 2))
            expect(receivedStep1).toEqual(expected.slice(0, MAX_ITEMS))
            expect(afterStep1).toHaveBeenCalledTimes(1)
            expect(afterStep2).toHaveBeenCalledTimes(1)
            expect(catchStep1).toHaveBeenCalledTimes(1)
            expect(catchStep2).toHaveBeenCalledTimes(1)
        })

        it('feeds items from one to next, stops all when end .throws()', async () => {
            const receivedStep1 = []
            const receivedStep2 = []
            const afterStep1 = jest.fn()
            const afterStep2 = jest.fn(async () => {
                throw new Error('oops')
            })
            const catchStep1 = jest.fn()
            const catchStep2 = jest.fn()
            const err = new Error('expected')

            const p = pipeline([
                generate(),
                async function* Step1(s) {
                    try {
                        for await (const msg of s) {
                            receivedStep1.push(msg)
                            yield msg * 2
                        }
                    } catch (error) {
                        catchStep1(error)
                        throw error
                    } finally {
                        afterStep1()
                    }
                },
                async function* Step2(s) {
                    try {
                        for await (const msg of s) {
                            receivedStep2.push(msg)
                            yield msg * 10
                            if (receivedStep2.length === MAX_ITEMS) {
                                await s.throw(err)
                            }
                        }
                    } catch (error) {
                        catchStep2(error)
                        throw error
                    } finally {
                        await afterStep2()
                    }
                }
            ], onFinally)

            const received = []
            await expect(async () => {
                for await (const msg of p) {
                    received.push(msg)
                }
            }).rejects.toThrow(err)

            expect(received).toEqual(expected.slice(0, MAX_ITEMS).map((v) => v * 20))
            expect(receivedStep2).toEqual(expected.slice(0, MAX_ITEMS).map((v) => v * 2))
            expect(receivedStep1).toEqual(expected.slice(0, MAX_ITEMS))
            expect(afterStep1).toHaveBeenCalledTimes(1)
            expect(afterStep2).toHaveBeenCalledTimes(1)
            expect(catchStep1).toHaveBeenCalledTimes(1)
            expect(catchStep2).toHaveBeenCalledTimes(1)
        })
        it('handles errors before', async () => {
            const err = new Error('expected')

            const p = pipeline([
                generate(),
                async function* Step1(s) {
                    yield* s
                    throw err
                },
                async function* Step2(s) {
                    yield* s
                    yield await new Promise(() => {}) // would wait forever
                }
            ], onFinally)

            const received = []
            await expect(async () => {
                for await (const msg of p) {
                    received.push(msg)
                }
            }).rejects.toThrow(err)

            expect(received).toEqual(expected)
        })

        it('handles errors after', async () => {
            const err = new Error('expected')

            const p = pipeline([
                generate(),
                async function* Step1(s) {
                    yield* s
                },
                async function* Step2(s) {
                    yield* s
                    throw err
                }
            ], onFinally)

            const received = []
            await expect(async () => {
                for await (const msg of p) {
                    received.push(msg)
                }
            }).rejects.toThrow(err)

            expect(received).toEqual(expected)
        })

        it('handles cancel with error after', async () => {
            const err = new Error('expected')
            const receivedStep2 = []
            const shouldNotGetHere = jest.fn()

            const p = pipeline([
                generate(),
                async function* Step1(s) {
                    yield* s
                },
                async function* Step2(s) {
                    for await (const msg of s) {
                        receivedStep2.push(msg)
                        yield msg
                        if (receivedStep2.length === MAX_ITEMS) {
                            await p.cancel(err)
                        }
                    }
                }
            ], onFinally)

            const received = []
            await expect(async () => {
                for await (const msg of p) {
                    received.push(msg)
                }
            }).rejects.toThrow(err)

            expect(shouldNotGetHere).toHaveBeenCalledTimes(0)
            expect(received).toEqual(expected.slice(0, MAX_ITEMS))
        })

        it('runs onFinally', async () => {
            const onFinallyInnerAfter = jest.fn()
            const onFinallyInner = jest.fn(async () => {
                await wait(WAIT)
                onFinallyInnerAfter()
            })
            const p = pipeline([
                generate(),
                async function* Step1(s) {
                    yield* s
                },
                async function* finallyFn(s) {
                    yield* iteratorFinally(s, onFinallyInner)
                }
            ], onFinally)
            const received = []
            for await (const msg of p) {
                received.push(msg)
            }

            expect(onFinallyInner).toHaveBeenCalledTimes(1)
            expect(onFinallyInnerAfter).toHaveBeenCalledTimes(1)
            expect(received).toEqual(expected)
        })

        it('runs onFinally even if not started', async () => {
            const onFinallyInnerAfter = jest.fn()
            const onFinallyInner = jest.fn(async () => {
                await wait(WAIT)
                onFinallyInnerAfter()
            })
            const p = pipeline([
                generate(),
                async function* Step1(s) {
                    yield* s
                },
                async function* finallyFn(s) {
                    yield* iteratorFinally(s, onFinallyInner)
                }
            ], onFinally)
            await p.return()
            const received = []
            for await (const msg of p) {
                received.push(msg)
            }

            expect(onFinallyInner).toHaveBeenCalledTimes(0)
            expect(onFinallyInnerAfter).toHaveBeenCalledTimes(0)
            expect(received).toEqual([])
        })

        it('runs onFinally even if not started when cancelled', async () => {
            const onFinallyInnerAfter = jest.fn()
            const onFinallyInner = jest.fn(async () => {
                await wait(WAIT)
                onFinallyInnerAfter()
            })
            const p = pipeline([
                generate(),
                async function* Step1(s) {
                    yield* s
                },
                async function* finallyFn(s) {
                    yield* iteratorFinally(s, onFinallyInner)
                }
            ], onFinally)
            await p.cancel()
            const received = []
            for await (const msg of p) {
                received.push(msg)
            }

            expect(onFinallyInner).toHaveBeenCalledTimes(0)
            expect(onFinallyInnerAfter).toHaveBeenCalledTimes(0)
            expect(received).toEqual([])
        })

        it('works with streams', async () => {
            const onFinallyInnerAfter = jest.fn()
            const onFinallyInner = jest.fn(async () => {
                await wait(WAIT)
                onFinallyInnerAfter()
            })
            const onInputStreamClose = jest.fn()
            const inputStream = PushQueue.from(generate(), {
                onEnd: onInputStreamClose,
            })
            const p = pipeline([
                inputStream,
                async function* Step1(s) {
                    yield* s
                },
                async function* finallyFn(s) {
                    yield* iteratorFinally(s, onFinallyInner)
                }
            ], onFinally)
            const received = []
            for await (const msg of p) {
                received.push(msg)
            }

            expect(onFinallyInner).toHaveBeenCalledTimes(1)
            expect(onFinallyInnerAfter).toHaveBeenCalledTimes(1)
            expect(received).toEqual(expected)
            expect(inputStream.isReadable()).toBe(false)
            expect(onInputStreamClose).toHaveBeenCalledTimes(1)
        })

        it('can have delayed yields', async () => {
            const receivedStep1 = []
            const receivedStep2 = []
            const onThroughStreamClose = jest.fn()
            const throughStream = PushQueue.from(generate(), {
                onEnd: onThroughStreamClose,
            })

            const p = pipeline([
                throughStream,
                async function* Step1(s) {
                    for await (const msg of s) {
                        receivedStep1.push(msg)
                        yield msg
                    }
                    await wait(10)
                    for (const msg of receivedStep1) {
                        yield msg * 2
                    }
                },
                async function* Step2(s) {
                    for await (const msg of s) {
                        receivedStep2.push(msg)
                        yield msg
                    }
                },
            ], onFinally, {
                timeout: WAIT,
            })

            const received = []
            for await (const msg of p) {
                received.push(msg)
                expect(onFinally).toHaveBeenCalledTimes(0)
            }

            expect(received).toEqual([...expected, ...expected.map((v) => v * 2)])
            expect(receivedStep1).toEqual(expected)

            // all streams were closed
            expect(onThroughStreamClose).toHaveBeenCalledTimes(1)
        })

        it('does not end internal non-autoEnd streams automatically', async () => {
            const receivedStep1 = []
            const receivedStep2 = []
            const receivedStep3 = []
            const onThroughStreamClose = jest.fn()
            const afterLoop1 = jest.fn()
            const throughStream = new PushQueue([], {
                autoEnd: false,
                onEnd: onThroughStreamClose,
            })

            const p = pipeline([
                generate(),
                // eslint-disable-next-line require-yield
                async function* Step1(s) {
                    for await (const msg of s) {
                        receivedStep1.push(msg)
                        setTimeout(() => {
                            throughStream.push(msg)
                        }, 100)
                    }
                    afterLoop1()
                },
                throughStream,
                async function* Step2(s) {
                    for await (const msg of s) {
                        expect(afterLoop1).toHaveBeenCalledTimes(1)
                        receivedStep2.push(msg)
                        yield msg
                        if (receivedStep2.length === expected.length) {
                            // this should end pipeline
                            break
                        }
                    }
                },
                async function* Step3(s) {
                    for await (const msg of s) {
                        receivedStep3.push(msg)
                        yield msg
                        // should close automatically
                    }
                },
            ], onFinally, {
                timeout: WAIT,
            })

            const received = []
            for await (const msg of p) {
                received.push(msg)
                expect(onFinally).toHaveBeenCalledTimes(0)
            }
            expect(received).toEqual(expected)
            expect(receivedStep1).toEqual(expected)
            expect(receivedStep2).toEqual(expected)
            expect(receivedStep3).toEqual(expected)

            // all streams were closed
            expect(onThroughStreamClose).toHaveBeenCalledTimes(1)
            expect(afterLoop1).toHaveBeenCalledTimes(1)
        })

        it('does not end internal streams automatically if going through non-autoEnd: false PushQueue', async () => {
            const receivedStep1 = []
            const receivedStep2 = []
            const receivedStep3 = []
            const onThroughStreamClose = jest.fn()
            const onThroughStream2Close = jest.fn()
            const afterLoop1 = jest.fn()
            const throughStream = new PushQueue([], {
                autoEnd: false,
                onEnd: onThroughStreamClose,
            })
            const throughStream2 = new PushQueue([], {
                autoEnd: true,
                onEnd: onThroughStream2Close,
            })

            const p = pipeline([
                generate(),
                // eslint-disable-next-line require-yield
                async function* Step1(s) {
                    for await (const msg of s) {
                        receivedStep1.push(msg)
                        setTimeout(() => {
                            throughStream.push(msg)
                        }, 100)
                    }
                    afterLoop1()
                },
                throughStream,
                async function* Step2(s) {
                    for await (const msg of s) {
                        expect(afterLoop1).toHaveBeenCalledTimes(1)
                        receivedStep2.push(msg)
                        yield msg
                        if (receivedStep2.length === expected.length) {
                            // end pipeline
                            break
                        }
                    }
                },
                throughStream2,
                async function* Step3(s) {
                    for await (const msg of s) {
                        receivedStep3.push(msg)
                        yield msg
                        // should close automatically
                    }
                },
            ], onFinally, {
                timeout: WAIT,
            })

            const received = []
            for await (const msg of p) {
                received.push(msg)
                expect(onFinally).toHaveBeenCalledTimes(0)
            }
            expect(received).toEqual(expected)
            expect(receivedStep1).toEqual(expected)
            expect(receivedStep2).toEqual(expected)
            expect(receivedStep3).toEqual(expected)

            // all streams were closed
            expect(onThroughStreamClose).toHaveBeenCalledTimes(1)
            expect(onThroughStream2Close).toHaveBeenCalledTimes(1)
        })

        it('works with nested pipelines', async () => {
            const onFinallyInnerAfter = jest.fn()
            const onFinallyInner = jest.fn(async () => {
                await wait(WAIT)
                onFinallyInnerAfter()
            })

            const receivedStep1 = []
            const receivedStep2 = []
            const onFirstStreamClose = jest.fn()
            const onInputStreamClose = jest.fn()

            const inputStream = new PushQueue([], {
                onEnd: onInputStreamClose,
            })
            inputStream.id = 'inputStream'
            const p1 = pipeline([
                inputStream,
                async function* Step1(s) {
                    for await (const msg of s) {
                        receivedStep1.push(msg)
                        yield msg
                    }
                },
            ], onFinallyInner)

            const firstStream = PushQueue.from(generate(), {
                onEnd: onFirstStreamClose,
            })
            firstStream.id = 'firststream'
            const p = pipeline([
                firstStream,
                p1,
                async function* Step2(s) {
                    for await (const msg of s) {
                        receivedStep2.push(msg)
                        yield msg
                    }
                },
            ], onFinally)

            const received = []
            for await (const msg of p) {
                received.push(msg)
            }

            expect(onFinallyInner).toHaveBeenCalledTimes(1)
            expect(onFinallyInnerAfter).toHaveBeenCalledTimes(1)

            expect(received).toEqual(expected)
            expect(receivedStep1).toEqual(expected)
            expect(receivedStep2).toEqual(expected)

            // all streams were closed
            expect(onFirstStreamClose).toHaveBeenCalledTimes(1)
            expect(onInputStreamClose).toHaveBeenCalledTimes(1)
        })

        it('works with nested pipeline in first position', async () => {
            const onFinallyInnerAfter = jest.fn()
            const onFinallyInner = jest.fn(async () => {
                await wait(WAIT)
                onFinallyInnerAfter()
            })

            const receivedStep1 = []
            const onFirstStreamClose = jest.fn()

            const firstStream = PushQueue.from(generate(), {
                onEnd: onFirstStreamClose,
            })
            firstStream.id = 'firststream'
            const p1 = pipeline([
                firstStream
            ], onFinallyInner)

            const p = pipeline([
                p1,
                async function* Step1(s) {
                    for await (const msg of s) {
                        receivedStep1.push(msg)
                        yield msg
                    }
                },
            ], onFinally)

            const received = []
            for await (const msg of p) {
                received.push(msg)
            }

            expect(onFinallyInner).toHaveBeenCalledTimes(1)
            expect(onFinallyInnerAfter).toHaveBeenCalledTimes(1)

            expect(received).toEqual(expected)
            expect(receivedStep1).toEqual(expected)

            // all streams were closed
            expect(onFirstStreamClose).toHaveBeenCalledTimes(1)
        })

        it('works with nested pipelines that throw', async () => {
            const onFinallyInnerAfter = jest.fn()
            const onFinallyInner = jest.fn(async () => {
                await wait(WAIT)
                onFinallyInnerAfter()
            })

            const receivedStep1 = []
            const receivedStep2 = []

            const err = new Error('expected err')
            const p1 = pipeline([
                async function* Step2(s) {
                    for await (const msg of s) {
                        receivedStep2.push(msg)
                        yield msg
                        if (receivedStep2.length === MAX_ITEMS) {
                            throw err
                        }
                    }
                },
            ], onFinallyInner)

            const p = pipeline([
                generate(),
                async function* Step1(s) {
                    for await (const msg of s) {
                        receivedStep1.push(msg)
                        yield msg
                    }
                },
                p1
            ], onFinally, {
                timeout: WAIT,
            })

            const received = []
            await expect(async () => {
                for await (const msg of p) {
                    received.push(msg)
                }
            }).rejects.toThrow(err)

            expect(onFinallyInner).toHaveBeenCalledTimes(1)
            expect(onFinallyInnerAfter).toHaveBeenCalledTimes(1)

            expect(received).toEqual(expected.slice(0, MAX_ITEMS))
            expect(receivedStep1).toEqual(received)
            expect(receivedStep2).toEqual(received)
        })

        it('works with streams as pipeline steps', async () => {
            const receivedStep1 = []
            const receivedStep2 = []
            const onThroughStreamClose = jest.fn()
            const onThroughStream2Close = jest.fn()

            const throughStream = new PushQueue([], {
                onEnd: onThroughStreamClose,
            })
            const throughStream2 = new PushQueue([], {
                onEnd: onThroughStream2Close,
            })
            const p = pipeline([
                generate(),
                async function* Step1(s) {
                    for await (const msg of s) {
                        receivedStep1.push(msg)
                        yield msg
                    }
                },
                throughStream,
                async function* Step2(s) {
                    for await (const msg of s) {
                        receivedStep2.push(msg)
                        yield msg
                    }
                },
                throughStream2,
            ], onFinally, {
                timeout: WAIT,
            })

            const received = []
            for await (const msg of p) {
                received.push(msg)
            }

            expect(received).toEqual(expected)
            expect(receivedStep1).toEqual(expected)
            expect(receivedStep2).toEqual(expected)
            // all streams were closed
            expect(onThroughStreamClose).toHaveBeenCalledTimes(1)
            expect(onThroughStream2Close).toHaveBeenCalledTimes(1)
        })

        it('works with streams as pipeline steps with early return', async () => {
            const receivedStep1 = []
            const onThroughStreamClose = jest.fn()
            const onThroughStream2Close = jest.fn()

            const throughStream = new PushQueue([], {
                onEnd: onThroughStreamClose,
            })
            const throughStream2 = new PushQueue([], {
                onEnd: onThroughStream2Close,
            })

            const p = pipeline([
                generate(),
                throughStream,
                async function* Step1(s) {
                    for await (const msg of s) {
                        receivedStep1.push(msg)
                        yield msg
                        if (receivedStep1.length === MAX_ITEMS) {
                            break
                        }
                    }
                },
                throughStream2,
            ], onFinally, {
                timeout: WAIT,
            })

            const received = []
            for await (const msg of p) {
                received.push(msg)
            }

            expect(received).toEqual(expected.slice(0, MAX_ITEMS))
            expect(receivedStep1).toEqual(expected.slice(0, MAX_ITEMS))

            // all streams were closed
            expect(onThroughStreamClose).toHaveBeenCalledTimes(1)
            expect(onThroughStream2Close).toHaveBeenCalledTimes(1)
        })

        it('works with streams as pipeline steps with throw', async () => {
            const receivedStep1 = []
            const onThroughStreamClose = jest.fn()
            const throughStream = new PushQueue([], {
                onEnd: onThroughStreamClose,
            })

            const err = new Error('expected err')
            const p = pipeline([
                generate(),
                throughStream,
                async function* Step1(s) {
                    for await (const msg of s) {
                        receivedStep1.push(msg)
                        yield msg
                        if (receivedStep1.length === MAX_ITEMS) {
                            throw err
                        }
                    }
                },
            ], onFinally, {
                timeout: WAIT,
            })

            const received = []
            await expect(async () => {
                for await (const msg of p) {
                    received.push(msg)
                }
            }).rejects.toThrow(err)

            expect(received).toEqual(expected.slice(0, MAX_ITEMS))
            expect(receivedStep1).toEqual(received)

            // all streams were closed
            expect(onThroughStreamClose).toHaveBeenCalledTimes(1)
        })

        it('works with streams as pipeline steps after generator function', async () => {
            const receivedStep1 = []
            const onThroughStreamClose = jest.fn()
            const throughStream = new PushQueue([], {
                onEnd: onThroughStreamClose,
            })

            const p = pipeline([
                async function* Step1() {
                    for await (const msg of generate()) {
                        receivedStep1.push(msg)
                        yield msg
                    }
                },
                throughStream,
            ], onFinally, {
                timeout: WAIT,
            })

            const received = []
            for await (const msg of p) {
                received.push(msg)
            }

            expect(received).toEqual(expected)
            expect(receivedStep1).toEqual(received)

            // all streams were closed
            expect(onThroughStreamClose).toHaveBeenCalledTimes(1)
        })

        it('works with streams as pipeline steps before generator function', async () => {
            const receivedStep1 = []
            const onThroughStreamClose = jest.fn()
            const throughStream = PushQueue.from(generate(), {
                onEnd: onThroughStreamClose,
            })

            const p = pipeline([
                throughStream,
                async function* Step1(s) {
                    for await (const msg of s) {
                        receivedStep1.push(msg)
                        yield msg
                    }
                },
            ], onFinally, {
                timeout: WAIT,
            })

            const received = []
            for await (const msg of p) {
                received.push(msg)
            }

            expect(received).toEqual(expected)
            expect(receivedStep1).toEqual(received)

            // all streams were closed
            expect(onThroughStreamClose).toHaveBeenCalledTimes(1)
        })

        it('works with multiple streams as pipeline steps with throw', async () => {
            const receivedStep1 = []
            const receivedStep2 = []
            const onThroughStreamClose = jest.fn()
            const onThroughStream2Close = jest.fn()

            const throughStream = new PushQueue([], {
                onEnd: onThroughStreamClose,
            })
            throughStream.id = 'throughStream'
            const throughStream2 = new PushQueue([], {
                onEnd: onThroughStream2Close,
            })
            throughStream2.id = 'throughStream2'

            const err = new Error('expected err')
            let expectedStep1
            const p = pipeline([
                generate(),
                throughStream,
                async function* Step1(s) {
                    for await (const msg of s) {
                        receivedStep1.push(msg)
                        yield msg
                    }
                },
                throughStream2,
                async function* Step2(s) {
                    for await (const msg of s) {
                        receivedStep2.push(msg)
                        yield msg
                        if (receivedStep2.length === MAX_ITEMS) {
                            expectedStep1 = receivedStep1.slice()
                            throw err
                        }
                    }
                },
            ], onFinally, {
                timeout: WAIT,
            })

            const received = []
            await expect(async () => {
                for await (const msg of p) {
                    received.push(msg)
                }
            }).rejects.toThrow(err)

            expect(received).toEqual(expected.slice(0, MAX_ITEMS))
            expect(receivedStep1).toEqual(expectedStep1)
            expect(receivedStep2).toEqual(received)

            // all streams were closed
            expect(onThroughStream2Close).toHaveBeenCalledTimes(1)
            expect(onThroughStreamClose).toHaveBeenCalledTimes(1)
        })

        it('passes outer pipeline to inner pipeline', async () => {
            const onFinallyInnerAfter = jest.fn()
            const onFinallyInner = jest.fn(async () => {
                await wait(WAIT)
                onFinallyInnerAfter()
            })
            const receivedStep1 = []
            const receivedStep2 = []

            const p1 = pipeline([
                async function* Step1(s) { // s should come from outer pipeline
                    for await (const msg of s) {
                        receivedStep1.push(msg)
                        yield msg
                    }
                },
            ], onFinallyInner, {
                timeout: WAIT,
            })

            const p = pipeline([
                generate(),
                p1,
                async function* Step2(s) {
                    for await (const msg of s) {
                        receivedStep2.push(msg)
                        yield msg
                    }
                },
            ], onFinally, {
                timeout: WAIT,
            })

            const received = []
            for await (const msg of p) {
                received.push(msg)
            }

            expect(onFinallyInner).toHaveBeenCalledTimes(1)
            expect(onFinallyInnerAfter).toHaveBeenCalledTimes(1)
            expect(received).toEqual(expected)
            expect(receivedStep1).toEqual(expected)
            expect(receivedStep2).toEqual(expected)
            // all streams were closed
        })

        it('works with nested pipelines & streams', async () => {
            const onFinallyInnerAfter = jest.fn()
            const onFinallyInner = jest.fn(async () => {
                await wait(WAIT)
                onFinallyInnerAfter()
            })
            const receivedStep1 = []
            const receivedStep2 = []
            const onFirstStreamClose = jest.fn()
            const onInputStreamClose = jest.fn()
            const inputStream = new PushQueue([], {
                onEnd: onInputStreamClose,
            })
            const p1 = pipeline([
                inputStream,
                async function* Step1(s) {
                    for await (const msg of s) {
                        receivedStep1.push(msg)
                        yield msg
                    }
                },
            ], onFinallyInner, {
                timeout: WAIT,
            })

            const firstStream = PushQueue.from(generate(), {
                onEnd: onFirstStreamClose,
            })
            const p = pipeline([
                firstStream,
                async function* Step2(s) {
                    for await (const msg of s) {
                        receivedStep2.push(msg)
                        yield msg
                    }
                },
                p1,
            ], onFinally, {
                timeout: WAIT,
            })

            const received = []
            for await (const msg of p) {
                received.push(msg)
            }

            expect(onFinallyInner).toHaveBeenCalledTimes(1)
            expect(onFinallyInnerAfter).toHaveBeenCalledTimes(1)
            expect(received).toEqual(expected)
            expect(receivedStep1).toEqual(expected)
            expect(receivedStep2).toEqual(expected)
            // all streams were closed
            expect(onFirstStreamClose).toHaveBeenCalledTimes(1)
            expect(onInputStreamClose).toHaveBeenCalledTimes(1)
        })

        it('works with nested pipelines & streams closing before done', async () => {
            const onFinallyInnerAfter = jest.fn()
            const onFinallyInner = jest.fn(async () => {
                await wait(WAIT)
                onFinallyInnerAfter()
            })
            const receivedStep1 = []
            const receivedStep2 = []
            const onFirstStreamClose = jest.fn()
            const onInputStreamClose = jest.fn()

            const inputStream = new PushQueue([], {
                onEnd: onInputStreamClose,
            })
            const p1 = pipeline([
                inputStream,
                async function* Step1(s) {
                    for await (const msg of s) {
                        receivedStep1.push(msg)
                        yield msg
                        if (receivedStep1.length === MAX_ITEMS) {
                            break
                        }
                    }
                },
            ], onFinallyInner, {
                timeout: WAIT,
            })

            const firstStream = PushQueue.from(generate(), {
                onEnd: onFirstStreamClose,
            })
            const p = pipeline([
                firstStream,
                p1,
                async function* Step2(s) {
                    for await (const msg of s) {
                        receivedStep2.push(msg)
                        yield msg
                    }
                },
            ], onFinally, {
                timeout: WAIT,
            })

            const received = []
            for await (const msg of p) {
                received.push(msg)
            }

            expect(received).toEqual(expected.slice(0, MAX_ITEMS))
            expect(receivedStep1).toEqual(expected.slice(0, MAX_ITEMS))
            expect(receivedStep2).toEqual(expected.slice(0, MAX_ITEMS))
            // all streams were closed
            expect(onFirstStreamClose).toHaveBeenCalledTimes(1)
            expect(onInputStreamClose).toHaveBeenCalledTimes(1)

            expect(onFinallyInner).toHaveBeenCalledTimes(1)
            expect(onFinallyInnerAfter).toHaveBeenCalledTimes(1)
        })

        it('works with nested pipelines & streams + cancel before done', async () => {
            const onFinallyInnerAfter = jest.fn()
            const onFinallyInner = jest.fn(async () => {
                await wait(WAIT)
                onFinallyInnerAfter()
            })
            const receivedStep1 = []
            const receivedStep2 = []
            const onFirstStreamClose = jest.fn()
            const onInputStreamClose = jest.fn()

            const inputStream = new PushQueue([], {
                onEnd: onInputStreamClose,
            })
            const p1 = pipeline([
                inputStream,
                async function* Step1(s) {
                    for await (const msg of s) {
                        receivedStep1.push(msg)
                        yield msg
                        if (receivedStep1.length === MAX_ITEMS) {
                            await p1.cancel()
                        }
                    }
                },
            ], onFinallyInner, {
                timeout: WAIT,
            })

            const firstStream = PushQueue.from(generate(), {
                onEnd: onFirstStreamClose,
            })
            const p = pipeline([
                firstStream,
                p1,
                async function* Step2(s) {
                    for await (const msg of s) {
                        receivedStep2.push(msg)
                        yield msg
                    }
                },
            ], onFinally, {
                timeout: WAIT,
            })

            const received = []
            for await (const msg of p) {
                received.push(msg)
            }

            expect(received).toEqual(expected.slice(0, MAX_ITEMS))
            expect(receivedStep1).toEqual(expected.slice(0, MAX_ITEMS))
            expect(receivedStep2).toEqual(expected.slice(0, MAX_ITEMS))
            // all streams were closed
            expect(onFirstStreamClose).toHaveBeenCalledTimes(1)
            expect(onInputStreamClose).toHaveBeenCalledTimes(1)

            expect(onFinallyInner).toHaveBeenCalledTimes(1)
            expect(onFinallyInnerAfter).toHaveBeenCalledTimes(1)
        })

        it('works with nested pipelines & streams + cancel before done in second pipeline', async () => {
            const onFinallyInnerAfter = jest.fn()
            const onFinallyInner = jest.fn(async () => {
                await wait()
                onFinallyInnerAfter()
            })
            const receivedStep1 = []
            const receivedStep2 = []
            const onFirstStreamClose = jest.fn()
            const onInputStreamClose = jest.fn()

            const inputStream = new PushQueue([], {
                onEnd: onInputStreamClose,
            })

            inputStream.id = 'inputStream'
            let p
            const p1 = pipeline([
                inputStream,
                async function* Step1(s) {
                    for await (const msg of s) {
                        receivedStep1.push(msg)
                        yield msg
                        if (receivedStep1.length === MAX_ITEMS) {
                            await p.cancel()
                            expect(onFinally).toHaveBeenCalledTimes(1)
                            expect(onFinallyAfter).toHaveBeenCalledTimes(1)
                            expect(onFinallyInner).toHaveBeenCalledTimes(1)
                            expect(onFinallyInnerAfter).toHaveBeenCalledTimes(1)
                        }
                    }
                },
            ], onFinallyInner, {
                timeout: WAIT,
            })

            const firstStream = PushQueue.from(generate(), {
                onEnd: onFirstStreamClose,
            })
            firstStream.id = 'firstStream'
            p = pipeline([
                firstStream,
                p1,
                async function* Step2(s) {
                    for await (const msg of s) {
                        receivedStep2.push(msg)
                        yield msg
                    }
                },
            ], onFinally, {
                timeout: WAIT,
            })

            const received = []
            for await (const msg of p) {
                received.push(msg)
            }

            expect(received).toEqual(expected.slice(0, MAX_ITEMS))
            expect(receivedStep1).toEqual(expected.slice(0, MAX_ITEMS))
            expect(receivedStep2).toEqual(expected.slice(0, MAX_ITEMS))
            // all streams were closed
            expect(onInputStreamClose).toHaveBeenCalledTimes(1)
            expect(onFirstStreamClose).toHaveBeenCalledTimes(1)

            expect(onFinallyInner).toHaveBeenCalledTimes(1)
            expect(onFinallyInnerAfter).toHaveBeenCalledTimes(1)
        })

        it('works with nested pipelines at top level', async () => {
            const onFinallyInnerAfter = jest.fn()
            const onFinallyInner = jest.fn(async () => {
                await wait(WAIT)
                onFinallyInnerAfter()
            })

            const receivedStep1 = []
            const receivedStep2 = []
            const onFirstStreamClose = jest.fn()
            const onInputStreamClose = jest.fn()

            const inputStream = new PushQueue([], {
                onEnd: onInputStreamClose,
            })
            const p1 = pipeline([
                inputStream,
                async function* Step1(s) {
                    for await (const msg of s) {
                        receivedStep1.push(msg)
                        yield msg
                    }
                },
            ], onFinallyInner, {
                timeout: WAIT,
            })

            const firstStream = PushQueue.from(generate(), {
                onEnd: onFirstStreamClose,
            })
            const p = pipeline([
                firstStream,
                async function* Step2(s) {
                    for await (const msg of s) {
                        receivedStep2.push(msg)
                        yield msg
                    }
                },
                p1,
            ], onFinally, {
                timeout: WAIT,
            })

            const received = []
            for await (const msg of p) {
                received.push(msg)
            }

            expect(onFinallyInner).toHaveBeenCalledTimes(1)
            expect(onFinallyInnerAfter).toHaveBeenCalledTimes(1)
            expect(received).toEqual(expected)
            expect(receivedStep1).toEqual(expected)
            expect(receivedStep2).toEqual(expected)
            // all streams were closed
            expect(onFirstStreamClose).toHaveBeenCalledTimes(1)
            expect(onInputStreamClose).toHaveBeenCalledTimes(1)
        })
    })
})
