// media/navigation.js
(function() {
    // 等待DOM加载完成
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    function init() {
        setupNavigation();
        setupDoubleClickArea();
    }

    function setupNavigation() {
        // 导航按钮事件处理
        const backButton = document.getElementById('nav-back');
        const forwardButton = document.getElementById('nav-forward');
        const jumpButton = document.getElementById('nav-jump');

        if (backButton) {
            backButton.addEventListener('click', () => {
                window.vscode.postMessage({
                    type: 'navigate',
                    direction: 'back'
                });
            });
        }

        if (forwardButton) {
            forwardButton.addEventListener('click', () => {
                window.vscode.postMessage({
                    type: 'navigate',
                    direction: 'forward'
                });
            });
        }

        if (jumpButton) {
            jumpButton.addEventListener('click', () => {
                window.vscode.postMessage({
                    type: 'doubleClick',
                    location: 'bottomArea'
                });
            });
        }

        // 更新按钮状态
        window.updateNavButtons = function(canGoBack, canGoForward) {
            if (backButton) backButton.disabled = !canGoBack;
            if (forwardButton) forwardButton.disabled = !canGoForward;
        };

        // 导航区域右键防止默认菜单
        const navArea = document.querySelector('.nav-bar');
        if (navArea) {
            navArea.addEventListener('contextmenu', e => {
                e.preventDefault();
                e.stopPropagation();
            });
        }
    }

    function setupDoubleClickArea() {
        // 双击事件处理
        const doubleClickArea = document.querySelector('.double-click-area');
        if (doubleClickArea) {
            doubleClickArea.addEventListener('dblclick', () => {
                window.vscode.postMessage({
                    type: 'doubleClick',
                    location: 'bottomArea'
                });
            });

            doubleClickArea.addEventListener('contextmenu', handleContextMenu);
        }
    }

    function handleContextMenu(e) {
        e.preventDefault();
        e.stopPropagation();
        
        // 先移除已有菜单
        const oldMenu = document.getElementById('custom-context-menu');
        if (oldMenu) oldMenu.remove();

        // 创建菜单
        const menu = document.createElement('div');
        menu.id = 'custom-context-menu';
        menu.className = 'custom-context-menu';
        menu.style.visibility = 'hidden'; // 先隐藏，后面再显示

        // 阻止事件穿透
        menu.addEventListener('mousedown', e => e.stopPropagation());
        menu.addEventListener('mouseup', e => e.stopPropagation());
        menu.addEventListener('click', e => e.stopPropagation());

        // 菜单项
        const items = [
            { 
                label: 'Pin',
                checked: window.isPinned,
                action: () => window.vscode.postMessage({ type: 'pin' }) 
            },
            {
                label: 'Unpin',
                checked: !window.isPinned,
                action: () => window.vscode.postMessage({ type: 'unpin' }) 
            },
            { type: 'separator' }, // 分割条
            { 
                label: 'Copy filename', 
                action: () => {
                    const filename = document.querySelector('.filename-text')?.textContent || '';
                    if (filename) {
                        navigator.clipboard.writeText(filename);
                    }
                }
            },
            { 
                label: 'Reveal In File Explorer', 
                action: () => {
                    const filenameDisplay = document.querySelector('.filename-display');
                    const pathContainer = filenameDisplay?.querySelector('.filename-path');
                    const pathText = pathContainer?.querySelector('.filename-path-text')?.textContent;
                    if (pathText) {
                        window.vscode.postMessage({
                            type: 'revealInFileExplorer',
                            filePath: pathText
                        });
                    }
                }
            },
            { type: 'separator' }, // 分割条
            {
                label: 'Float',
                action: () => window.vscode.postMessage({ type: 'float' })
            }
        ];

        items.forEach(item => {
            if (item.type === 'separator') {
                const sep = document.createElement('div');
                sep.className = 'custom-context-menu-separator';
                menu.appendChild(sep);
                return;
            }
            const el = document.createElement('div');
            el.textContent = (item.checked ? '✔ ' : '') + item.label;
            el.className = 'custom-context-menu-item';
            el.onclick = () => {
                item.action();
                menu.remove();
            };
            menu.appendChild(el);
        });

        document.body.appendChild(menu);

        // 计算菜单位置，防止溢出
        const menuRect = menu.getBoundingClientRect();
        let left = e.clientX;
        let top = e.clientY;
        const padding = 4; // 距离边缘的最小距离

        if (left + menuRect.width > window.innerWidth - padding) {
            left = window.innerWidth - menuRect.width - padding;
        }
        if (top + menuRect.height > window.innerHeight - padding) {
            top = window.innerHeight - menuRect.height - padding;
        }
        left = Math.max(left, padding);
        top = Math.max(top, padding);

        menu.style.left = left + 'px';
        menu.style.top = top + 'px';
        menu.style.visibility = 'visible';

        // 点击其它地方关闭菜单
        document.addEventListener('mousedown', function onDocClick() {
            menu.remove();
            document.removeEventListener('mousedown', onDocClick);
        });

        // webview失去焦点时关闭菜单
        window.addEventListener('blur', function onBlur() {
            menu.remove();
            window.removeEventListener('blur', onBlur);
        });
    }
})();