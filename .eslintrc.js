module.exports = {
    extends: [
        'streamr-nodejs'
    ],
    rules: {
        'max-len': ['warn', {
            code: 150
        }],
        'no-plusplus': ['error', {
            allowForLoopAfterthoughts: true
        }],
        'no-underscore-dangle': ['error', {
            allowAfterThis: true
        }],
        'padding-line-between-statements': [
            'error',
            {
                blankLine: 'always', prev: 'if', next: 'if'
            }
        ],
        'prefer-destructuring': 'warn',
        'max-classes-per-file': 'off', // javascript is not java
        // TODO check all errors/warnings and create separate PR
        'promise/always-return': 'warn',
        'promise/catch-or-return': 'warn',
        'require-atomic-updates': 'warn',
        'promise/param-names': 'warn'
    }
}
