//@ts-check

// 通用 Token 样式选择器（颜色 + 粗体 + 斜体），Promise 形式返回结果或 null

let lastPickColorPosition = null; // 记录上次弹窗位置

// 重置弹窗位置（下次居中显示）
export function resetPickColorPosition() {
    lastPickColorPosition = null;
}

// { "token": "keyword.type", "foreground": "#ff0000", "fontStyle": "bold italic", "description": "function|class etc." }
export async function pickTokenStyle(options = {
    token: '',
    foreground: '#ff0000',
    fontStyle: '',
    description: ''
}, domColor = '#808080', word = '') {
    // Monaco 主题规则的 foreground 不带 '#'（如 "267f99"），但 <input type=color> 与 CSS color
    // 都要求 "#rrggbb"，否则会被当非法值显示为黑色。这里统一规整，使面板显示与编辑器实际渲染一致。
    const normalizeHex = (c) => {
        if (typeof c !== 'string') { return ''; }
        let s = c.trim();
        if (!s) { return ''; }
        if (!s.startsWith('#')) { s = '#' + s; }
        // <input type=color> 仅支持 #rrggbb（不支持 alpha），截断到 7 位
        return /^#[0-9a-fA-F]{6,8}$/.test(s) ? s.slice(0, 7) : s;
    };
    const hasInitialColor = typeof options.foreground === 'string' && options.foreground.trim();
    const initialColor = hasInitialColor ? normalizeHex(options.foreground) : '#ff0000';

    //console.log('[definition] pickColor initial:', initialColor, ' domColor:', domColor, ' hasInitialColor:', hasInitialColor);

    const style = {
        bold: options.fontStyle?.includes('bold') || false,
        italic: options.fontStyle?.includes('italic') || false
    };

    const tokenText = options.token || '';
    //console.log('[definition] domcolor: ', domColor);

    return new Promise(resolve => {
        try {
            //console.log('[definition] pickColor options:', options);
            // 创建统一容器
            const container = document.createElement('div');
            container.style.position = 'fixed';
            container.style.zIndex = '10000';
            container.style.background = 'var(--vscode-editor-background)';
            container.style.border = '1px solid var(--vscode-input-border)';
            container.style.borderRadius = '4px';
            container.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.2)';
            container.style.display = 'flex';
            container.style.flexDirection = 'column';
            container.style.overflow = 'hidden';
            // 宽度自适应内容：内容短时保持最小宽度，内容长时撑开，超过上限再换行
            container.style.width = 'auto';
            container.style.minWidth = '300px';
            container.style.maxWidth = '90vw';
            container.style.boxSizing = 'border-box';

            // 使用上次记录的位置，如果没有则居中显示
            if (lastPickColorPosition) {
                container.style.left = lastPickColorPosition.left + 'px';
                container.style.top = lastPickColorPosition.top + 'px';
                // 移除 transform，因为我们使用具体坐标
                container.style.transform = 'none';
            } else {
                // 首次显示时居中
                container.style.left = '50%';
                container.style.top = '50%';
                container.style.transform = 'translate(-50%, -50%)';
            }

            // 创建可拖动标题栏
            const titleBar = document.createElement('div');
            titleBar.style.background = 'var(--vscode-titleBar-activeBackground)';
            titleBar.style.color = 'var(--vscode-titleBar-activeForeground)';
            titleBar.style.padding = '5px 8px';
            titleBar.style.display = 'flex';
            titleBar.style.justifyContent = 'space-between';
            titleBar.style.alignItems = 'center';
            titleBar.style.userSelect = 'none';

            // 标题文字
            const titleText = document.createElement('span');
            titleText.textContent = 'Select Token Style';
            titleText.style.fontSize = '15px';
            //titleText.style.fontWeight = '600';
            titleText.style.fontFamily = 'var(--vscode-font-family)';

            // 关闭按钮
            const closeButton = document.createElement('button');
            closeButton.textContent = '×';
            closeButton.style.background = 'var(--vscode-titleBar-activeBackground)'; // 使用标题栏背景色
            closeButton.style.border = 'none';
            closeButton.style.color = 'var(--vscode-titleBar-activeForeground)';  // 使用标题栏前景色
            closeButton.style.fontSize = '18px';
            closeButton.style.fontWeight = 'bold';
            closeButton.style.cursor = 'pointer';
            closeButton.style.padding = '0';
            closeButton.style.width = '26px';
            closeButton.style.height = '26px';
            closeButton.style.display = 'flex';
            closeButton.style.alignItems = 'center';
            closeButton.style.justifyContent = 'center';
            closeButton.style.borderRadius = '3px';

            // 修改悬停效果
            closeButton.addEventListener('mouseover', () => {
                closeButton.style.background = 'var(--vscode-errorForeground)'; // hover 时使用错误前景色（通常是红色）
            });
            closeButton.addEventListener('mouseout', () => {
                closeButton.style.background = 'var(--vscode-titleBar-activeBackground)'; // 恢复标题栏背景色
            });

            // 内容区域
            const contentArea = document.createElement('div');
            contentArea.style.padding = '10px';
            contentArea.style.display = 'flex';
            contentArea.style.flexDirection = 'column';
            contentArea.style.gap = '10px';

            // 显示当前token内容
            const tokenLabel = document.createElement('div');
            tokenLabel.style.display = 'flex';
            tokenLabel.style.alignItems = 'flex-end';
            tokenLabel.style.flexWrap = 'wrap';  // 内容过长时换行，避免被裁切
            tokenLabel.style.gap = '5px';
            tokenLabel.style.alignSelf = 'flex-start';
            tokenLabel.style.width = '100%';
            tokenLabel.style.marginBottom = '5px';

            const tokenPrefix = document.createElement('span');
            const maxWordLen = 30;  // 可调整的最大长度
            let displayWord = word || 'Cur Token';
            if (displayWord.length > maxWordLen) {
                displayWord = displayWord.slice(0, maxWordLen - 3) + '...';
            }
            tokenPrefix.textContent = displayWord + ' : ';
            tokenPrefix.style.color = 'var(--vscode-editor-foreground)';
            tokenPrefix.style.fontSize = '13px';
            tokenPrefix.style.fontFamily = 'var(--vscode-font-family)';
            tokenPrefix.style.fontStyle = 'italic';
            tokenPrefix.style.display = 'inline-block';
            tokenPrefix.style.verticalAlign = 'bottom';
            tokenPrefix.style.lineHeight = '1';

            const tokenValue = document.createElement('span');
            tokenValue.textContent = tokenText || '(none)';
            tokenValue.style.color = hasInitialColor ? initialColor : domColor;// || 'var(--vscode-editor-foreground)';//'#000080';  // 蓝黑色
            tokenValue.style.fontSize = '16px';   // 比前缀大一号
            tokenValue.style.fontFamily = 'var(--vscode-font-family)';
            if (style.italic) tokenValue.style.fontStyle = 'italic';
            if (style.bold) tokenValue.style.fontWeight = '500';
            //tokenValue.style.fontWeight = '500';  // 稍微加粗
            tokenValue.style.display = 'inline-block';
            tokenValue.style.verticalAlign = 'bottom';
            tokenValue.style.lineHeight = '1';
            tokenValue.style.maxWidth = '100%';        // 不超出容器
            tokenValue.style.overflowWrap = 'anywhere'; // 超长 scope 自动断行

            tokenLabel.appendChild(tokenPrefix);
            tokenLabel.appendChild(tokenValue);
            tokenLabel.style.marginBottom = '5px';
            contentArea.appendChild(tokenLabel);

            // 创建样式选项容器（同一行）
            const styleContainer = document.createElement('div');
            styleContainer.style.display = 'flex';
            styleContainer.style.alignItems = 'flex-end';
            styleContainer.style.gap = '15px';

            const colorContainer = document.createElement('div');
            colorContainer.style.position = 'relative';
            colorContainer.style.width = '30px';
            colorContainer.style.height = '30px';

            // 创建颜色选择器
            const input = document.createElement('input');
            input.type = 'color';
            input.value = hasInitialColor ? initialColor : domColor; // 默认灰色
            //console.log('create input:', input.value);
            input.style.width = '30px';
            input.style.height = '30px';

            // 创建斜线指示器
            const disabledIndicator = document.createElement('div');
            disabledIndicator.style.position = 'absolute';
            disabledIndicator.style.top = '0';
            disabledIndicator.style.left = '0';
            disabledIndicator.style.width = '100%';
            disabledIndicator.style.height = '100%';
            disabledIndicator.style.pointerEvents = 'none';
            disabledIndicator.style.alignItems = 'center';
            disabledIndicator.style.justifyContent = 'center';
            disabledIndicator.style.zIndex = '1';
            disabledIndicator.style.display = hasInitialColor ? 'none' : 'flex';

            const slash = document.createElement('div');
            slash.style.width = '42.426px';   // 30px * √2
            slash.style.height = '2px';
            slash.style.background = 'var(--vscode-errorForeground)';
            slash.style.transform = 'rotate(45deg)';
            slash.style.opacity = '0.7';

            disabledIndicator.appendChild(slash);

            // ⭐ 添加颜色选择事件处理
            input.addEventListener('input', () => {
                // 当用户选择颜色时，隐藏斜线
                disabledIndicator.style.display = 'none';
                input.style.opacity = '1';
            });

            // ⭐ 添加颜色选择完成事件
            input.addEventListener('change', () => {
                // 确保斜线保持隐藏
                disabledIndicator.style.display = 'none';
                input.style.opacity = '1';
            });

            colorContainer.appendChild(input);
            colorContainer.appendChild(disabledIndicator);

            // 在创建样式选项时添加以下代码
            const noColorButton = document.createElement('div');
            noColorButton.style.position = 'relative';
            noColorButton.style.width = '15px';  // 缩小到一半
            noColorButton.style.height = '15px';  // 缩小到一半
            noColorButton.style.cursor = 'pointer';
            noColorButton.style.display = 'flex';
            noColorButton.style.alignItems = 'center';
            noColorButton.style.justifyContent = 'center';
            noColorButton.style.border = '1px solid var(--vscode-button-border, transparent)';
            noColorButton.style.borderRadius = '2px';
            noColorButton.style.backgroundColor = 'var(--vscode-button-background)';
            noColorButton.style.marginLeft = '-8px';  // 只留 1px 间隙
            noColorButton.style.marginRight = '8px';
            noColorButton.style.alignSelf = 'flex-end';
            noColorButton.style.marginBottom = '0';

            // 鼠标悬停效果
            noColorButton.addEventListener('mouseover', () => {
                noColorButton.style.backgroundColor = 'var(--vscode-button-hoverBackground)';
            });
            noColorButton.addEventListener('mouseout', () => {
                noColorButton.style.backgroundColor = 'var(--vscode-button-background)';
            });

            // 修改斜线样式
            const buttonSlash = document.createElement('div');
            buttonSlash.style.width = '12px';  // 缩小斜线
            buttonSlash.style.height = '1.5px';  // 稍微减小高度
            buttonSlash.style.background = 'var(--vscode-button-foreground)';
            buttonSlash.style.transform = 'rotate(45deg)';
            buttonSlash.style.opacity = '0.9';

            noColorButton.appendChild(buttonSlash);

            // 添加点击事件
            noColorButton.addEventListener('click', () => {
                // 显示颜色选择器上的斜线
                disabledIndicator.style.display = 'flex';
                input.style.opacity = '1';
                // 设置默认灰色
                input.value = domColor;
            });

            // 粗体复选框
            const boldCheckbox = document.createElement('input');
            boldCheckbox.type = 'checkbox';
            boldCheckbox.id = 'bold-checkbox';
            boldCheckbox.checked = style.bold;
            boldCheckbox.style.margin = '0';
            const boldLabel = document.createElement('label');
            boldLabel.htmlFor = 'bold-checkbox';
            boldLabel.textContent = 'Bold';
            boldLabel.style.color = 'var(--vscode-editor-foreground)';
            boldLabel.addEventListener('click', (e) => {
                e.preventDefault();
                boldCheckbox.click();
            });

            // 斜体复选框
            const italicCheckbox = document.createElement('input');
            italicCheckbox.type = 'checkbox';
            italicCheckbox.id = 'italic-checkbox';
            italicCheckbox.checked = style.italic;
            italicCheckbox.style.margin = '0';
            const italicLabel = document.createElement('label');
            italicLabel.htmlFor = 'italic-checkbox';
            italicLabel.textContent = 'Italic';
            italicLabel.style.color = 'var(--vscode-editor-foreground)';
            italicLabel.addEventListener('click', (e) => {
                e.preventDefault();
                italicCheckbox.click();
            });

            // 创建确定按钮容器（居中）
            const buttonContainer = document.createElement('div');
            buttonContainer.style.display = 'flex';
            buttonContainer.style.flexDirection = 'column'; // 垂直堆叠
            buttonContainer.style.alignItems = 'center';    // 水平居中按钮
            buttonContainer.style.justifyContent = 'center';
            buttonContainer.style.marginTop = '10px';
            buttonContainer.style.width = '100%';

            // 分隔条（位于按钮上方）
            const btnSeparator = document.createElement('div');
            btnSeparator.style.width = '100%';
            btnSeparator.style.height = '1px';
            btnSeparator.style.background = 'var(--vscode-editorWidget-border)'; // 主题感知颜色
            btnSeparator.style.opacity = '1';
            btnSeparator.style.marginBottom = '8px';
            btnSeparator.style.alignSelf = 'stretch'; // 拉满容器宽度

            buttonContainer.appendChild(btnSeparator);

            // 创建确定按钮
            const confirmButton = document.createElement('button');
            confirmButton.textContent = 'OK';
            confirmButton.style.padding = '5px 15px';
            confirmButton.style.background = 'var(--vscode-button-background)';
            confirmButton.style.color = 'var(--vscode-button-foreground)';
            confirmButton.style.border = 'none';
            confirmButton.style.borderRadius = '2px';
            confirmButton.style.cursor = 'pointer';

            // 组装样式选项
            const boldOption = document.createElement('div');
            boldOption.style.display = 'flex';
            boldOption.style.alignItems = 'center';
            boldOption.style.gap = '5px';
            boldOption.style.height = '15px';
            boldOption.appendChild(boldCheckbox);
            boldOption.appendChild(boldLabel);

            const italicOption = document.createElement('div');
            italicOption.style.display = 'flex';
            italicOption.style.alignItems = 'center';
            italicOption.style.gap = '5px';
            italicOption.style.height = '15px';
            italicOption.appendChild(italicCheckbox);
            italicOption.appendChild(italicLabel);

            // 组装样式容器（颜色选择器和样式选项在同一行）
            styleContainer.appendChild(colorContainer);
            styleContainer.appendChild(noColorButton);
            styleContainer.appendChild(boldOption);
            styleContainer.appendChild(italicOption);

            // 组装按钮容器
            buttonContainer.appendChild(confirmButton);

            // 组装标题栏
            titleBar.appendChild(titleText);
            titleBar.appendChild(closeButton);

            // 组装内容区域
            contentArea.appendChild(styleContainer);
            contentArea.appendChild(buttonContainer);

            // 组装容器
            container.appendChild(titleBar);
            container.appendChild(contentArea);
            document.body.appendChild(container);

            // 拖动功能实现
            let isDragging = false;
            let startX, startY, startLeft, startTop;

            titleBar.addEventListener('mousedown', (e) => {
                isDragging = true;
                startX = e.clientX;
                startY = e.clientY;
                // 获取当前实际位置而不是转换后的位置
                const rect = container.getBoundingClientRect();
                startLeft = rect.left;
                startTop = rect.top;
                // 移除transform以便直接控制位置
                container.style.transform = 'none';
                container.style.left = startLeft + 'px';
                container.style.top = startTop + 'px';
            });

            const dragHandler = (e) => {
                if (!isDragging) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                const newLeft = startLeft + dx;
                const newTop = startTop + dy;
                container.style.left = newLeft + 'px';
                container.style.top = newTop + 'px';
                // 更新位置记录
                lastPickColorPosition = { left: newLeft, top: newTop };
            };

            const dragEndHandler = () => {
                if (isDragging) {
                    // 在拖动结束时记录最终位置
                    const rect = container.getBoundingClientRect();
                    lastPickColorPosition = {
                        left: rect.left,
                        top: rect.top
                    };
                }
                isDragging = false;
            };

            document.addEventListener('mousemove', dragHandler);
            document.addEventListener('mouseup', dragEndHandler);

            let escHandler = null;
            let blurHandler = null;
            let outsideClickHandler = null;

            const cleanup = () => {
                if (container && container.parentNode) {
                    // 记录关闭时的位置
                    const rect = container.getBoundingClientRect();
                    lastPickColorPosition = {
                        left: rect.left,
                        top: rect.top
                    };
                    container.parentNode.removeChild(container);
                }
                document.removeEventListener('mousemove', dragHandler);
                document.removeEventListener('mouseup', dragEndHandler);

                if (typeof outsideClickHandler === 'function') {
                    document.removeEventListener('mousedown', outsideClickHandler);
                }
                if (typeof escHandler === 'function') {
                    document.removeEventListener('keydown', escHandler);
                }
                if (typeof blurHandler === 'function') {
                    window.removeEventListener('blur', blurHandler);
                }
            };

            // 关闭按钮事件
            closeButton.addEventListener('click', () => {
                cleanup();
                resolve(null);
            }, { once: true });

            // 确定按钮点击事件
            confirmButton.addEventListener('click', () => {
                const result = {
                    foreground: disabledIndicator.style.display === 'flex' ? null : input.value,//input.value || null,
                    bold: boldCheckbox.checked,
                    italic: italicCheckbox.checked
                };
                cleanup();
                resolve(result);
            }, { once: true });

            // ESC键关闭
            escHandler = (e) => {
                if (e.key === 'Escape') {
                    cleanup();
                    resolve(null);
                    document.removeEventListener('keydown', escHandler);
                }
            };
            document.addEventListener('keydown', escHandler);

            blurHandler = () => {
                cleanup();
                resolve(null);
            };
            window.addEventListener('blur', blurHandler);

            // 点击外部关闭
            outsideClickHandler = (e) => {
                if (!container.contains(e.target)) {
                    cleanup();
                    resolve(null);
                    document.removeEventListener('mousedown', outsideClickHandler);
                }
            };
            setTimeout(() => {
                document.addEventListener('mousedown', outsideClickHandler);
            }, 0);

        } catch (error) {
            console.error('Error in pickColor:', error);
            resolve(null);
        }
    });
}
