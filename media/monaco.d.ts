//为 media/ 下的 webview 脚本提供 monaco 全局类型。
//
// 背景：media/*.js 是浏览器原生 ESM，monaco 在运行时通过 AMD loader.js +
// require(['vs/editor/editor.main']) 挂到全局 window.monaco，而非各文件 import。
// 因此这里把全局 `monaco` 声明为 monaco-editor 的命名空间类型，让所有 media 脚本
// 里裸用的 monaco.xxx（monaco.editor.*、monaco.Range、monaco.languages.* 等）
// 都能获得类型提示与「转到定义」。
//
// 注意：这是纯类型声明（编译期/编辑期），不影响运行时加载方式。

import * as monacoNs from 'monaco-editor';

declare global {
    // 全局 monaco（AMD 加载后挂在 window 上）
    const monaco: typeof monacoNs;

    interface Window {
        monaco: typeof monacoNs;
    }
}

export {};
