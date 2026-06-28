// Webview 端 TextMate 运行时（经 webpack 打包为 media/textmate.bundle.js，以 ESM 库形式输出）。
//
// 它只做一件事：把 CommonJS 的 vscode-textmate / vscode-oniguruma 封装成浏览器可用的几个薄入口，
// 真正的编排（拉取语法、挑选 scope、注册到 Monaco）放在不需要打包的 media/textmateClient.js 里。
//
// 之所以要单独打包：media/*.js 是浏览器原生 ESM、不经构建直接被 webview 加载，无法 import CommonJS 包；
// 这里用 webpack（target: web, outputModule）把依赖打成单文件 ESM，供 textmateClient.js 动态 import()。

import { Registry, parseRawGrammar, INITIAL } from 'vscode-textmate';
import type { IOnigLib, RegistryOptions } from 'vscode-textmate';
import { loadWASM, OnigScanner, OnigString } from 'vscode-oniguruma';

let _wasmLoaded = false;

// 加载 oniguruma 正则引擎的 WASM（只需一次），返回 vscode-textmate 所需的 onigLib。
// wasmData 由 webview 端 fetch(onig.wasm) 得到的 ArrayBuffer 传入。
export async function loadOnig(wasmData: ArrayBuffer): Promise<IOnigLib> {
    if (!_wasmLoaded) {
        await loadWASM(wasmData);
        _wasmLoaded = true;
    }
    return {
        createOnigScanner: (patterns: string[]) => new OnigScanner(patterns),
        createOnigString: (s: string) => new OnigString(s),
    };
}

// 创建 TextMate Registry（grammar 仓库）。options 由 textmateClient.js 提供：
//   onigLib：上面的 loadOnig 结果；loadGrammar：按 scope 异步拉取语法源并 parseRawGrammar；
//   getInjections：返回某 scope 的注入语法列表。
export function createRegistry(options: RegistryOptions): Registry {
    return new Registry(options);
}

export { parseRawGrammar, INITIAL };
