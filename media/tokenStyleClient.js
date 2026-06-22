//@ts-check

// 通过扩展端异步获取 token 的现有样式（仅 rules），带本地兜底与超时

export async function requestTokenStyle(token) {
    // 本地兜底读取（避免扩展未实现或超时）
    function readLocalRule(token) {
        const rules = window.vsCodeEditorConfiguration?.customThemeRules;
        if (Array.isArray(rules)) {
            const r = rules.find(x => x && x.token === token);
            if (r) return { foreground: r.foreground, fontStyle: r.fontStyle };
        }
        return null;
    }

    // 优先尝试向扩展请求，超时后回退到本地
    return new Promise((resolve) => {
        try {
            const reqId = `ts_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            const timeout = setTimeout(() => {
                window.removeEventListener('message', onMessage);
                resolve(readLocalRule(token));
            }, 1500); // 1.5s 超时兜底

            function onMessage(event) {
                const msg = event.data;
                if (msg && msg.type === 'tokenStyle.get.result' && msg.token === token && (!msg.reqId || msg.reqId === reqId)) {
                    //console.log('[definition] tokenStyle.get.result:', msg);
                    clearTimeout(timeout);
                    window.removeEventListener('message', onMessage);
                    if (msg.error) {
                        resolve(readLocalRule(token));
                    } else {
                        resolve(msg.style || readLocalRule(token));
                    }
                }
            }

            window.addEventListener('message', onMessage);
            window.vscode.postMessage({ type: 'tokenStyle.get', token, reqId });
        } catch (e) {
            // 任意异常直接走本地兜底
            resolve(readLocalRule(token));
        }
    });
}
