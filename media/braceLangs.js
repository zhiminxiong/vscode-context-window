//@ts-check

// 以花括号为主结构的语言白名单：统一用 braceFoldingProvider 驱动 sticky scroll
// （foldingProviderModel）。花括号配对 + 声明行上提是语言无关的，能统一处理
// Allman/K&R/多行签名，且对每对 { } 都出区间，因此 if/for/while/switch/try 等
// 控制流块也会进sticky。解析不出区间时 provider 返回 null，自动回退到缩进模型。
//
// 不在此表中的语言（Python/Ruby/Lua/YAML 等）继续走 outlineModel：纯缩进语言
// 无花括号会回退缩进；end/缩进型语言若含零星花括号，避免被误当主结构而退化。
//
// 两处使用（main.js 注册 folding provider、editorContent.js 选sticky 模型）
// 共享此表，避免两份清单不同步。
export const BRACE_LANGS = [
    'typescript', 'javascript', 'cpp', 'c', 'csharp',
    'java', 'go', 'rust', 'php', 'swift', 'kotlin',
];
