/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check

'use strict';

const path = require('path');

/**@type {import('webpack').Configuration}*/
const extensionConfig = {
    target: 'node',

    entry: './src/extension.ts',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'extension.js',
        libraryTarget: "commonjs2",
        devtoolModuleFilenameTemplate: "../[resource-path]",
    },
    devtool: 'source-map',
    externals: {
        vscode: "commonjs vscode"
    },
    resolve: {
        extensions: ['.ts', '.js']
    },
    module: {
        rules: [{
            test: /\.ts$/,
            exclude: /node_modules/,
            use: [{
                loader: 'ts-loader',
                options: {
                    compilerOptions: {
                        "module": "es6" // override `tsconfig.json` so that TypeScript emits native JavaScript modules.
                    }
                }
            }]
        }]
    },
};

// Webview 端 TextMate 运行时打包。
// 背景：media/*.js 是浏览器原生 ESM、不经任何打包直接被 webview 加载；而 vscode-textmate /
// vscode-oniguruma 是 CommonJS 模块，无法被浏览器 ESM 直接 import。因此这里单独用 webpack 把它们
// 连同我们的封装（src/webview/textmateRuntime.ts）打成一份「ESM 库」输出到 media/textmate.bundle.js，
// 供 media/textmateClient.js 通过动态 import() 加载（同源、受 CSP script-src 的 cspSource 放行）。
/**@type {import('webpack').Configuration}*/
const webviewTextmateConfig = {
    target: 'web',
    entry: './src/webview/textmateRuntime.ts',
    experiments: {
        outputModule: true,
    },
    output: {
        path: path.resolve(__dirname, 'media'),
        filename: 'textmate.bundle.js',
        library: { type: 'module' },
        // 单文件输出：避免运行期再去拉子 chunk（webview 下相对路径解析复杂）
        chunkFormat: 'module',
    },
    optimization: {
        splitChunks: false,
        // oniguruma 的 WASM 由我们手动 fetch 后 loadWASM，bundle 内无需 wasm 资源
        minimize: false,
    },
    devtool: 'source-map',
    resolve: {
        extensions: ['.ts', '.js']
    },
    module: {
        rules: [{
            test: /\.ts$/,
            exclude: /node_modules/,
            use: [{
                loader: 'ts-loader',
                options: {
                    compilerOptions: {
                        // ESM 输出：允许 import()/顶层 await，沿用 Node 解析以引入 node_modules 里的 CJS 依赖
                        "module": "esnext",
                        "target": "es2020",
                        "moduleResolution": "node",
                        "lib": ["ES2020", "DOM"],
                        "rootDir": "src",
                        "sourceMap": true
                    }
                }
            }]
        }]
    },
};

module.exports = [extensionConfig, webviewTextmateConfig];
