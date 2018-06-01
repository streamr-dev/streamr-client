/* eslint-disable prefer-template */
/* eslint-disable prefer-destructuring */

const path = require('path')
const UglifyJsPlugin = require('uglifyjs-webpack-plugin')
const merge = require('lodash').merge
const pkg = require('./package.json')

const libraryName = pkg.name

const commonConfig = {
    entry: path.join(__dirname, 'src', 'index.js'),
    devtool: 'source-map',
    output: {
        path: path.join(__dirname, 'dist'),
        library: {
            root: 'StreamrClient',
            amd: libraryName,
        },
        libraryTarget: 'umd',
        umdNamedDefine: true,
    },
    module: {
        rules: [
            {
                test: /(\.jsx|\.js)$/,
                loader: 'babel-loader',
                exclude: /(node_modules|bower_components)/,
                query: {
                    plugins: ['transform-runtime'],
                },
            },
            {
                test: /(\.jsx|\.js)$/,
                loader: 'eslint-loader',
                exclude: /node_modules/,
            },
        ],
    },
    resolve: {
        modules: [path.resolve('./node_modules'), path.resolve('./src')],
        extensions: ['.json', '.js'],
    },
    plugins: [],
}

const serverConfig = merge({}, commonConfig, {
    target: 'node',
    output: {
        filename: libraryName + '.js',
    },
})

const clientConfig = merge({}, commonConfig, {
    target: 'web',
    output: {
        filename: libraryName + '.web.js',
    },
})

const clientMinifiedConfig = merge({}, clientConfig, {
    plugins: [new UglifyJsPlugin()],
    output: {
        filename: libraryName + '.web.min.js',
    },
})

module.exports = [serverConfig, clientConfig, clientMinifiedConfig]
