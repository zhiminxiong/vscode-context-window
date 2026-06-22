//@ts-check

// 定义列表面板 UI：文件名显示、悬浮预览、列表渲染、键盘导航等。
// 以工厂函数形式创建，内部持有 editor 引用与各自的私有状态。

export function createDefinitionList(editor) {
    const vscode = window.vscode;

    let __defHoverEl = null;
    let __defHoverAnchor = null;

    // 全局变量存储当前定义数据和键盘处理函数
    let currentDefinitions = [];
    let handleDefinitionListKeydown = null;

    function showDefinitionItemHover(item) {
        // 同一项内不重复创建，避免闪烁
        if (__defHoverEl && __defHoverAnchor === item) return;

        hideDefinitionItemHover();

        const rect = item.getBoundingClientRect();

        const wrap = document.createElement('div');
        wrap.className = 'definition-item-float-wrap';
        wrap.style.left = rect.left + 'px';
        wrap.style.top = rect.top + 'px';

        const el = item.cloneNode(true);
        el.classList.add('definition-item-float');
        el.style.position = 'static';
        el.style.visibility = 'hidden';
        el.style.whiteSpace = 'nowrap';
        el.style.width = 'auto';

        wrap.appendChild(el);
        document.body.appendChild(wrap);

        const naturalWidth = el.scrollWidth;
        const maxW = Math.max(0, (window.innerWidth - 12) - rect.left);
        wrap.style.width = Math.min(naturalWidth, maxW) + 'px';

        const isActive = item.classList.contains('active');
        const bgVar = isActive ? 'var(--vscode-list-activeSelectionBackground)' : 'var(--vscode-list-hoverBackground)';
        const fgVar = isActive ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-list-hoverForeground)';
        el.style.backgroundColor = bgVar;
        el.style.color = fgVar;
        el.querySelectorAll('*').forEach(n => (n.style.color = 'inherit'));

        wrap.style.mixBlendMode = 'normal';
        el.style.mixBlendMode = 'normal';
        wrap.style.opacity = '1';
        el.style.opacity = '1';

        el.style.visibility = 'visible';
        __defHoverEl = wrap;
        __defHoverAnchor = item;
    }

    function hideDefinitionItemHover() {
        if (__defHoverEl && __defHoverEl.parentNode) __defHoverEl.parentNode.removeChild(__defHoverEl);
        __defHoverEl = null;
        __defHoverAnchor = null;
    }

    // 更新文件名显示函数
    function updateFilenameDisplay(uri) {
        const filenameDisplay = document.querySelector('.filename-display');
        const pathContainer = filenameDisplay?.querySelector('.filename-path');
        const icon = pathContainer?.querySelector('.filename-icon');
        const pathText = pathContainer?.querySelector('.filename-path-text');
        if (uri && filenameDisplay) {
            let filePath = uri;
            try {
                filePath = decodeURIComponent(uri);
            } catch (e) {
                //console.log('[definition] Error decoding URI:', e);
                filePath = uri;
            }
            const filename = filePath.split('/').pop().split('\\').pop();
            //const displayText = `${filename}       (${filePath})`;
            //console.log('[definition] File name:', filename, uri);
            //filenameDisplay.textContent = displayText || '';
            filenameDisplay.querySelector('.filename-text').textContent = filename;
            icon.textContent = '📄'; // 你想用的Unicode图标
            icon.style.display = 'inline-block';
            pathText.textContent = filePath;
        } else if (filenameDisplay) {
            filenameDisplay.querySelector('.filename-text').textContent = "";
            icon.textContent = "";
            icon.style.display = 'none';
            pathText.textContent = "";
        }
    }

    function updateDefinitionList(definitions) {
        const listItems = document.querySelector('#definition-list .list-items');
        if (!listItems) {
            return;
        }

        // 只有在有多个定义时才显示定义列表面板
        const definitionList = document.querySelector('#definition-list');
        if (definitionList) {
            if (definitions && definitions.length > 1) {
                definitionList.style.display = 'flex';
            } else {
                // 如果只有一个或没有定义，隐藏列表面板
                definitionList.style.display = 'none';
                // 强制Monaco编辑器重新布局以占满整个空间
                if (editor) {
                    setTimeout(() => {
                        editor.layout();
                    }, 100);
                }
                return;
            }
        }

        // 清空现有内容
        listItems.innerHTML = '';

        // 如果没有定义，显示空状态
        if (!definitions || definitions.length === 0) {
            listItems.innerHTML = '<div style="padding: 10px; color: var(--vscode-descriptionForeground); font-style: italic;">No definitions found</div>';
            return;
        }

        const getFileName = (path) => path.replace(/^.*[\\/]/, '');

        // 创建定义项
        definitions.forEach((def, index) => {
            const item = document.createElement('div');
            item.className = `definition-item${def.isActive ? ' active' : ''}`;

            // 直接使用def中的数据，不需要解析location字符串
            const filePath = def.filePath;
            const lineNumber = def.lineNumber + 1; // 转换为1-based行号
            const columnNumber = def.columnNumber || 1;

            //console.log('[definition] File name:', filePath, lineNumber, columnNumber);
            const fileNameWithExt = getFileName(filePath);
            const symbolName = fileNameWithExt || `Definition ${index + 1}`;

            item.innerHTML = `
                <span class="definition-number">${symbolName}</span>
                <div class="definition-info">
                    <span class="file-path">${filePath}</span>
                    <span class="line-info">- Line: ${lineNumber}, Column: ${columnNumber}</span>
                </div>
            `;

            // tips
            //const fullText = `${symbolName} - ${filePath} - Line: ${lineNumber}, Column: ${columnNumber}`;
            //item.setAttribute('title', fullText);

            const RIGHT_TRIGGER_RATIO = 0.1;   // 右侧占比
            const RIGHT_TRIGGER_MIN_PX = 60;  // 右侧最小像素
            const RIGHT_HYSTERESIS_PX = 4; // 滞回宽度，防抖

            // 获取触发区域（定义列表可视区域的右边界）
            function getDefinitionRegionRect(item) {
                const region =
                    document.querySelector('#definition-list') ||
                    document.querySelector('#definition-list .list-items') ||
                    item.parentElement;
                return region.getBoundingClientRect();
            }

            item.addEventListener('mouseenter', () => {
                item.__defInRight = false;
                const onMove = (e) => {
                    const regionRect = getDefinitionRegionRect(item);
                    const triggerWidth = Math.max(regionRect.width * RIGHT_TRIGGER_RATIO, RIGHT_TRIGGER_MIN_PX);
                    const thresholdX = regionRect.right - triggerWidth;

                    let wantShow;
                    if (item.__defInRight) {
                        // 已显示时，只有明显离开才隐藏（阈值-滞回）
                        wantShow = e.clientX >= (thresholdX - RIGHT_HYSTERESIS_PX);
                    } else {
                        // 未显示时，只有明显进入才显示（阈值+滞回）
                        wantShow = e.clientX >= (thresholdX + RIGHT_HYSTERESIS_PX);
                    }

                    if (wantShow && !item.__defInRight) {
                        item.__defInRight = true;
                        showDefinitionItemHover(item); // 不会重复重建
                    } else if (!wantShow && item.__defInRight) {
                        item.__defInRight = false;
                        hideDefinitionItemHover();
                    }
                };
                item.__defHoverMove = onMove;
                item.addEventListener('mousemove', onMove);
            });

            item.addEventListener('mouseleave', () => {
                if (item.__defHoverMove) {
                    item.removeEventListener('mousemove', item.__defHoverMove);
                    item.__defHoverMove = null;
                }
                item.__defInRight = false;
                hideDefinitionItemHover();
            });
            if (!window.__defHoverScrollBound) {
                window.addEventListener('scroll', hideDefinitionItemHover, true);
                window.addEventListener('wheel', hideDefinitionItemHover, { passive: true, capture: true });
                window.addEventListener('resize', hideDefinitionItemHover);
                window.__defHoverScrollBound = true;
            }

            // 添加点击事件
            item.addEventListener('click', () => {
                selectDefinitionItem(index, def);
            });

            // 添加双击事件 - 直接复用底部导航栏的双击跳转功能
            item.addEventListener('dblclick', () => {
                // 先选择当前定义项，更新Context Window的内容
                selectDefinitionItem(index, def);

                // 然后直接调用底部导航栏的双击跳转逻辑
                setTimeout(() => {
                    vscode.postMessage({
                        type: 'doubleClick',
                        location: 'bottomArea'
                    });
                }, 100); // 稍微延迟确保内容已更新
            });

            listItems.appendChild(item);

            // 如果是默认激活的项，自动选择它
            if (def.isActive) {
                setTimeout(() => {
                    selectDefinitionItem(index, def);
                }, 100);
            }
        });

        // 添加键盘事件监听
        setupDefinitionListKeyboardNavigation(definitions);

        // 强制Monaco编辑器重新布局以适应新的容器大小
        if (editor) {
            setTimeout(() => {
                editor.layout();
            }, 100);
        }
    }

    function selectDefinitionItem(index, def) {
        // 移除其他项的active状态
        document.querySelectorAll('.definition-item').forEach(i => i.classList.remove('active'));
        // 添加当前项的active状态
        const items = document.querySelectorAll('.definition-item');
        if (items[index]) {
            items[index].classList.add('active');
            // 滚动到可见区域
            items[index].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        // 发送消息到扩展
        vscode.postMessage({
            type: 'definitionItemSelected',
            filePath: def.filePath,
            lineNumber: def.lineNumber,
            index: index
        });
    }

    function setupDefinitionListKeyboardNavigation(definitions) {
        currentDefinitions = definitions;

        // 移除之前的事件监听器
        if (handleDefinitionListKeydown) {
            document.removeEventListener('keydown', handleDefinitionListKeydown);
        }

        // 创建新的事件处理函数
        handleDefinitionListKeydown = function(e) {
            const items = document.querySelectorAll('.definition-item');
            if (items.length === 0) return;

            const currentActive = document.querySelector('.definition-item.active');
            let currentIndex = currentActive ? Array.from(items).indexOf(currentActive) : 0;

            switch (e.key) {
                case 'ArrowUp':
                case 'Up':
                    e.preventDefault();
                    currentIndex = Math.max(0, currentIndex - 1);
                    selectDefinitionItem(currentIndex, currentDefinitions[currentIndex]);
                    break;

                case 'ArrowDown':
                case 'Down':
                    e.preventDefault();
                    currentIndex = Math.min(items.length - 1, currentIndex + 1);
                    selectDefinitionItem(currentIndex, currentDefinitions[currentIndex]);
                    break;

                case 'p':
                    if (e.ctrlKey) {
                        e.preventDefault();
                        currentIndex = Math.max(0, currentIndex - 1);
                        selectDefinitionItem(currentIndex, currentDefinitions[currentIndex]);
                    }
                    break;

                case 'n':
                    if (e.ctrlKey) {
                        e.preventDefault();
                        currentIndex = Math.min(items.length - 1, currentIndex + 1);
                        selectDefinitionItem(currentIndex, currentDefinitions[currentIndex]);
                    }
                    break;

                case 'Escape':
                    e.preventDefault();
                    // 发送消息关闭定义列表
                    vscode.postMessage({
                        type: 'closeDefinitionList'
                    });
                    break;

                case 'Enter':
                    e.preventDefault();
                    // Enter键选择当前项（已经通过selectDefinitionItem处理了）
                    break;
            }
        };

        // 添加新的事件监听器
        document.addEventListener('keydown', handleDefinitionListKeydown);
    }

    function clearDefinitionList() {
        const listItems = document.querySelector('#definition-list .list-items');
        if (listItems) {
            listItems.innerHTML = '';
        }

        // 隐藏定义列表，让Monaco编辑器占满整个空间
        const definitionList = document.querySelector('#definition-list');
        const mainContainer = document.querySelector('#main-container');

        if (definitionList) {
            definitionList.style.display = 'none';
        }

        if (mainContainer) {
            mainContainer.style.flexDirection = 'row';
        }

        // 强制Monaco编辑器重新布局以适应新的容器大小
        if (editor) {
            setTimeout(() => {
                editor.layout();
            }, 100);
        }

        // 移除键盘事件监听器
        if (handleDefinitionListKeydown) {
            document.removeEventListener('keydown', handleDefinitionListKeydown);
            handleDefinitionListKeydown = null;
        }
    }

    return {
        updateDefinitionList,
        clearDefinitionList,
        updateFilenameDisplay
    };
}
