//@ts-check

// 基于正则的 Document Symbol Provider（C/C++/C#），用于修复 sticky scroll 缺失符号树的问题。
// 纯正则实现，不依赖任何 Monarch 语法定义。

export function createDocumentSymbolProvider(monaco) {
    return {
        provideDocumentSymbols: (model) => {
            const symbols = [];
            const text = model.getValue();
            const lines = text.split('\n');
            const languageId = model.getLanguageId();
            
            // 控制流关键字集合（用于过滤）
            const controlFlowKeywords = new Set([
                'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
                'try', 'catch', 'finally', 'throw', 'return', 'break', 'continue',
                'goto', 'sizeof', 'typeof', 'delete', 'new'
            ]);
            
            // 定义不同语言的符号识别模式
            const patterns = {
                cpp: [
                    // 命名空间
                    { 
                        regex: /^\s*namespace\s+([\w:]+)\s*(?:\{|$)/, 
                        kind: monaco.languages.SymbolKind.Namespace,
                        nameGroup: 1
                    },
                    // 类/结构体/枚举
                    { 
                        regex: /^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct|union|interface|enum(?:\s+(?:class|struct))?)\s+([\w:]+)/, 
                        kind: monaco.languages.SymbolKind.Class,
                        nameGroup: 1
                    },
                    // 带类作用域的函数（如 Ball::init, EffectBuffer &EffectBuffer::get, static void __fastcall Ball::normalize）
                    // 匹配：[修饰符/调用约定]* [返回类型]? [修饰符/调用约定]* [类::函数名]
                    { 
                        regex: /^\s*(?:(?:virtual|static|inline|explicit|constexpr|friend|__\w+|WINAPI|CALLBACK|APIENTRY|STDCALL|CDECL)\s+)*(?:[\w:]+(?:<[^>]*>)?\s*[*&]*\s*)?(?:(?:__\w+|WINAPI|CALLBACK|APIENTRY|STDCALL|CDECL)\s+)?(\w+::[~\w]+)\s*\(/, 
                        kind: monaco.languages.SymbolKind.Function,
                        nameGroup: 1
                    },
                    // 带修饰符的函数（如 virtual void init, static __forceinline void rotateZ, __forceinline int getValue）
                    // 匹配：[修饰符/调用约定]+ [返回类型]? [修饰符/调用约定]* [函数名]
                    { 
                        regex: /^\s*(?:(?:virtual|static|inline|explicit|constexpr|friend|__\w+|WINAPI|CALLBACK|APIENTRY|STDCALL|CDECL)\s+)+(?:[\w:]+(?:<[^>]*>)?\s*[*&]*\s*)?(?:(?:__\w+|WINAPI|CALLBACK|APIENTRY|STDCALL|CDECL)\s+)?([\w~]+)\s*\(/, 
                        kind: monaco.languages.SymbolKind.Function,
                        nameGroup: 1
                    },
                    // 带指针/引用返回类型的函数（如 int* getValue, const char& getName）
                    { 
                        regex: /^\s*(?:const\s+)?[\w:]+(?:<[^>]*>)?\s*([*&]+)\s*([\w~]+)\s*\(/, 
                        kind: monaco.languages.SymbolKind.Function,
                        nameGroup: 2
                    },
                    // 带返回类型的函数（返回类型必须是大写开头或包含下划线，如 HRESULT, D3D11_TEXTURE2D）
                    { 
                        regex: /^\s*([A-Z][A-Z0-9_]*(?:<[^>]*>)?)\s+([*&]*)\s*([\w~]+)\s*\(/, 
                        kind: monaco.languages.SymbolKind.Function,
                        nameGroup: 3
                    },
                    // 带常见返回类型的函数（void, int, bool, char, float, double, long, short, auto）
                    { 
                        regex: /^\s*(void|int|bool|char|float|double|long|short|auto|size_t|uint|uint32_t|uint64_t|int32_t|int64_t)\s+([*&]*)\s*([\w~]+)\s*\(/, 
                        kind: monaco.languages.SymbolKind.Function,
                        nameGroup: 3
                    }
                ],
                csharp: [
                    // 命名空间
                    { 
                        regex: /^\s*namespace\s+([\w.]+)\s*(?:\{|$)/, 
                        kind: monaco.languages.SymbolKind.Namespace,
                        nameGroup: 1
                    },
                    // 类/接口/结构体/枚举/记录
                    { 
                        regex: /^\s*(?:(?:public|private|protected|internal|static|sealed|abstract|partial)\s+)*(?:class|interface|struct|enum|record)\s+([\w<>]+)/, 
                        kind: monaco.languages.SymbolKind.Class,
                        nameGroup: 1
                    },
                    // 方法
                    { 
                        regex: /^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|extern|unsafe|new)\s+)*(?:[\w<>[\]?]+\s+)?([\w]+)\s*(?:<[^>]*>)?\s*\(/, 
                        kind: monaco.languages.SymbolKind.Method,
                        nameGroup: 1
                    },
                    // 属性
                    { 
                        regex: /^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract)\s+)*(?:[\w<>[\]?]+\s+)([\w]+)\s*\{\s*(?:get|set)/, 
                        kind: monaco.languages.SymbolKind.Property,
                        nameGroup: 1
                    }
                ],
                c: [
                    // 结构体/枚举/联合体
                    { 
                        regex: /^\s*(?:typedef\s+)?(?:struct|union|enum|interface)\s+([\w]+)(?:\s*\{|$)/, 
                        kind: monaco.languages.SymbolKind.Struct,
                        nameGroup: 1
                    },
                    // 函数
                    { 
                        regex: /^\s*(?:static|inline|extern)?\s*(?:[\w]+(?:\s*\*)*\s+)?([\w]+)\s*\([^)]*\)\s*(?:\{|$)/, 
                        kind: monaco.languages.SymbolKind.Function,
                        nameGroup: 1
                    }
                ]
            };
            
            // 获取当前语言的模式
            let activePatterns = [];
            if (languageId === 'cpp') {
                activePatterns = patterns.cpp;
            } else if (languageId === 'csharp') {
                activePatterns = patterns.csharp;
            } else if (languageId === 'c') {
                activePatterns = patterns.c;
            }
            
            if (activePatterns.length === 0) {
                return symbols;
            }
            
            // 符号栈：用于跟踪嵌套的符号
            const symbolStack = [];
            // 等待花括号的符号
            let pendingSymbol = null;
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const lineNumber = i + 1;
                const trimmedLine = line.trim();
                
                // 跳过注释行
                if (trimmedLine.startsWith('//') || trimmedLine.startsWith('/*') || trimmedLine.startsWith('*')) {
                    continue;
                }
                
                // 标记：这一行是否创建了新符号（避免重复计数花括号）
                let symbolCreatedOnThisLine = false;
                
                // 如果没有等待的符号，尝试匹配新符号
                if (!pendingSymbol) {
                    for (const pattern of activePatterns) {
                        const match = line.match(pattern.regex);
                        if (match) {
                            const name = match[pattern.nameGroup];
                            
                            // 过滤控制流关键字（仅对函数/方法模式）
                            if (pattern.kind === monaco.languages.SymbolKind.Function || 
                                pattern.kind === monaco.languages.SymbolKind.Method) {
                                // 提取函数名（去掉类作用域前缀，如 Ball::init -> init）
                                const functionName = name.includes('::') ? name.split('::').pop() : name;
                                // 如果是控制流关键字，跳过
                                if (controlFlowKeywords.has(functionName.trim())) {
                                    continue;
                                }
                            }
                            
                            const hasOpenBrace = line.includes('{');
                            const hasSemicolon = line.includes(';');
                            
                            // 如果有分号但没有花括号，说明是函数声明而不是定义，跳过
                            if (hasSemicolon && !hasOpenBrace) {
                                continue;
                            }
                            
                            if (hasOpenBrace) {
                                // 同一行有花括号，创建符号并入栈
                                const symbol = {
                                    name: name,
                                    kind: pattern.kind,
                                    range: new monaco.Range(lineNumber, 1, lineNumber, 1),
                                    selectionRange: new monaco.Range(lineNumber, 1, lineNumber, line.length + 1),
                                    children: []
                                };
                                
                                // 添加到父符号或根列表
                                if (symbolStack.length > 0) {
                                    symbolStack[symbolStack.length - 1].symbol.children.push(symbol);
                                } else {
                                    symbols.push(symbol);
                                }
                                
                                // 计算这行的花括号数量
                                const openCount = (line.match(/\{/g) || []).length;
                                const closeCount = (line.match(/\}/g) || []).length;
                                const netBraces = openCount - closeCount;
                                
                                // 只有当净增加花括号时才入栈
                                if (netBraces > 0) {
                                    symbolStack.push({
                                        symbol: symbol,
                                        startLine: lineNumber,
                                        braceLevel: netBraces  // 直接使用净花括号数
                                    });
                                } else if (netBraces === 0) {
                                    // 单行函数/类，直接设置结束位置
                                    symbol.range = new monaco.Range(lineNumber, 1, lineNumber, line.length + 1);
                                }
                                
                                symbolCreatedOnThisLine = true;
                            } else {
                                // 没有花括号，等待下一行
                                pendingSymbol = {
                                    name: name,
                                    kind: pattern.kind,
                                    startLine: lineNumber
                                };
                            }
                            break;
                        }
                    }
                } else {
                    // 检查等待的符号是否找到了开括号或分号
                    if (line.includes(';')) {
                        // 遇到分号，说明这是函数声明而不是定义，放弃这个符号
                        pendingSymbol = null;
                    } else if (line.includes('{')) {
                        const symbol = {
                            name: pendingSymbol.name,
                            kind: pendingSymbol.kind,
                            range: new monaco.Range(pendingSymbol.startLine, 1, lineNumber, 1),
                            selectionRange: new monaco.Range(pendingSymbol.startLine, 1, pendingSymbol.startLine, lines[pendingSymbol.startLine - 1].length + 1),
                            children: []
                        };
                        
                        // 添加到父符号或根列表
                        if (symbolStack.length > 0) {
                            symbolStack[symbolStack.length - 1].symbol.children.push(symbol);
                        } else {
                            symbols.push(symbol);
                        }
                        
                        // 计算这行的花括号数量
                        const openCount = (line.match(/\{/g) || []).length;
                        const closeCount = (line.match(/\}/g) || []).length;
                        const netBraces = openCount - closeCount;
                        
                        // 只有当净增加花括号时才入栈
                        if (netBraces > 0) {
                            symbolStack.push({
                                symbol: symbol,
                                startLine: pendingSymbol.startLine,
                                braceLevel: netBraces  // 直接使用净花括号数
                            });
                        } else if (netBraces === 0) {
                            // 单行函数/类
                            symbol.range = new monaco.Range(pendingSymbol.startLine, 1, lineNumber, line.length + 1);
                        }
                        
                        pendingSymbol = null;
                        symbolCreatedOnThisLine = true;
                    }
                }
                
                // 处理花括号以更新符号范围（但跳过刚创建符号的行，避免重复计数）
                if (symbolStack.length > 0 && !symbolCreatedOnThisLine) {
                    const openCount = (line.match(/\{/g) || []).length;
                    const closeCount = (line.match(/\}/g) || []).length;
                    
                    // 更新栈顶符号的花括号层级
                    symbolStack[symbolStack.length - 1].braceLevel += openCount;
                    symbolStack[symbolStack.length - 1].braceLevel -= closeCount;
                    
                    // 处理闭括号 - 可能需要弹出多个符号
                    while (symbolStack.length > 0 && symbolStack[symbolStack.length - 1].braceLevel === 0) {
                        const item = symbolStack.pop();
                        item.symbol.range = new monaco.Range(
                            item.startLine,
                            1,
                            lineNumber,
                            line.length + 1
                        );
                    }
                }
            }
            
            // 处理未闭合的符号（设置到文件末尾）
            while (symbolStack.length > 0) {
                const item = symbolStack.pop();
                item.symbol.range = new monaco.Range(
                    item.startLine,
                    1,
                    lines.length,
                    lines[lines.length - 1].length + 1
                );
            }
            
            return symbols;
        }
    };
}
