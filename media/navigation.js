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
        setupJumpMode();
        setupUpdateMode();
        setupSiIndicator();
        setupViewToggles();
    }

    const NAV_ICONS = {
        live: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 3C4.67 3 1.82 5.07 1 8c.82 2.93 3.67 5 7 5s6.18-2.07 7-5c-.82-2.93-3.67-5-7-5zm0 8a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-1.5A1.5 1.5 0 1 0 8 6a1.5 1.5 0 0 0 0 3z"/></svg>',
        sticky: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 3C4.67 3 1.82 5.07 1 8c.82 2.93 3.67 5 7 5s6.18-2.07 7-5c-.82-2.93-3.67-5-7-5zm0 8a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-1.5A1.5 1.5 0 1 0 8 6a1.5 1.5 0 0 0 0 3z"/><path fill="currentColor" d="M1.15 2.85 13.15 14.85l.7-.7L1.85 2.15l-.7.7z"/></svg>',
        definition: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M3 2h7v1H4v9h9V8h1v5H3V2zm6.15 0H14v4.85h-1V3.7L7.85 8.85l-.7-.7L12.3 3h-3.15V2z"/></svg>',
        typeDefinition: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M3 2h10v12H3V2zm1 1v2.2h8V3H4zm0 3.2V13h8V6.2H4zM6.2 8h3.6v1H6.2V8z"/></svg>',
        implementation: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M2 4h8v10H2V4zm1 1v8h6V5H3zm3-2h8v10h-1V4H6V3z"/></svg>',
        references: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M2 3h12v1.25H2V3zm0 4.4h12v1.25H2V7.4zm0 4.35h8v1.25H2v-1.25z"/></svg>',
        jumpTrail: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M.4 3.2 4.15 8 .4 12.8 0 11.55 3 8 0 4.45z"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/><path fill="currentColor" d="M11.85 3.2 15.6 8 11.85 12.8 11.45 11.55 14.6 8 11.45 4.45z"/></svg>',
        lineBlame: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M3 12h6"/><path d="M15 12h6"/></svg>',
        hoverTips: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M14.5 2h-13l-.5.5v9l.5.5H4v2.5l.854.146L7.207 12H14.5l.5-.5v-9l-.5-.5zm-.5 9H6.793L5 12.793V11H2V3h12v8z"/></svg>',
        stickyScroll: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.2" y="2.75" width="10.1" height="1" rx=".5" fill="currentColor"/><rect x="1.2" y="6.7" width="5.35" height="1" rx=".5" fill="currentColor"/><rect x="1.2" y="10.65" width="3.45" height="1" rx=".5" fill="currentColor"/><g fill="currentColor" transform="translate(11.15 9.55) rotate(40) scale(1.28)"><circle cx="0" cy="-2.25" r="1.55"/><path d="M-2 .25 2 .25 1.1-1.7h-2.2z"/><rect x="-.45" y=".2" width=".9" height="4.2" rx=".45"/></g></svg>'
    };

    function setNavIcon(el, key) {
        if (el) {
            el.innerHTML = NAV_ICONS[key] || '';
        }
    }

    // 底栏右侧跳转模式：点击上拉 Definition / Type Definition / Implementation / References。
    function setupJumpMode() {
        const JUMP_MODE_ITEMS = [
            { id: 'definition', label: 'Definition', short: 'Definition', title: 'Go to Definition (default)' },
            { id: 'typeDefinition', label: 'Type Definition', short: 'Type Definition', title: 'Go to Type Definition' },
            { id: 'implementation', label: 'Implementation', short: 'Implementation', title: 'Go to Implementation' },
            { id: 'references', label: 'References', short: 'References', title: 'List references and open in Context' }
        ];

        function currentMode() {
            const cfg = (window.vsCodeEditorConfiguration && window.vsCodeEditorConfiguration.contextEditorCfg) || {};
            const mode = cfg.jumpMode;
            return JUMP_MODE_ITEMS.some(item => item.id === mode) ? mode : 'definition';
        }

        function modeItem(id) {
            return JUMP_MODE_ITEMS.find(item => item.id === id) || JUMP_MODE_ITEMS[0];
        }

        window.updateJumpMode = function() {
            const btn = document.getElementById('jump-mode');
            const label = document.getElementById('jump-mode-label');
            const item = modeItem(currentMode());
            if (label) {
                label.textContent = item.short;
            }
            setNavIcon(document.getElementById('jump-mode-icon'), item.id);
            if (btn) {
                btn.title = 'Jump mode: ' + item.title;
            }
        };

        let onDocDown = null;

        function closeMenu() {
            const menu = document.getElementById('jump-mode-menu');
            if (menu) {
                menu.remove();
            }
            const btn = document.getElementById('jump-mode');
            if (btn) {
                btn.classList.remove('open');
            }
            if (onDocDown) {
                document.removeEventListener('mousedown', onDocDown, true);
                onDocDown = null;
            }
        }

        function openMenu() {
            const btn = document.getElementById('jump-mode');
            if (!btn) {
                return;
            }
            if (document.getElementById('jump-mode-menu')) {
                closeMenu();
                return;
            }

            const menu = document.createElement('div');
            menu.id = 'jump-mode-menu';
            menu.className = 'jump-mode-menu';
            const selected = currentMode();
            JUMP_MODE_ITEMS.forEach(item => {
                const el = document.createElement('div');
                el.className = 'jump-mode-menu-item' + (item.id === selected ? ' selected' : '');
                el.title = item.title;
                const icon = document.createElement('span');
                icon.className = 'nav-mode-icon';
                setNavIcon(icon, item.id);
                const text = document.createElement('span');
                text.textContent = (item.id === selected ? '✔ ' : '') + item.label;
                el.appendChild(icon);
                el.appendChild(text);
                el.addEventListener('mousedown', e => {
                    e.preventDefault();
                    e.stopPropagation();
                    closeMenu();
                    if (item.id === selected) {
                        return;
                    }
                    const label = document.getElementById('jump-mode-label');
                    if (label) {
                        label.textContent = item.short;
                    }
                    setNavIcon(document.getElementById('jump-mode-icon'), item.id);
                    btn.title = 'Jump mode: ' + item.title;
                    window.vscode.postMessage({ type: 'setJumpMode', mode: item.id });
                });
                menu.appendChild(el);
            });
            menu.addEventListener('contextmenu', e => {
                e.preventDefault();
                e.stopPropagation();
            });
            document.body.appendChild(menu);
            btn.classList.add('open');

            const rect = btn.getBoundingClientRect();
            const menuRect = menu.getBoundingClientRect();
            let left = rect.right - menuRect.width;
            let top = rect.top - menuRect.height - 4;
            if (left < 4) {
                left = 4;
            }
            if (top < 4) {
                top = rect.bottom + 4;
            }
            menu.style.left = left + 'px';
            menu.style.top = top + 'px';

            onDocDown = (e) => {
                if (btn.contains(e.target) || menu.contains(e.target)) {
                    return;
                }
                closeMenu();
            };
            document.addEventListener('mousedown', onDocDown, true);
            window.addEventListener('blur', function onBlur() {
                closeMenu();
                window.removeEventListener('blur', onBlur);
            });
        }

        const btn = document.getElementById('jump-mode');
        if (btn) {
            btn.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                openMenu();
            });
            btn.addEventListener('contextmenu', e => {
                e.preventDefault();
                e.stopPropagation();
            });
        }

        window.updateJumpMode();
    }

    // 底栏 Update Mode：点击在 Live / Sticky 之间切换，不展开列表。
    function setupUpdateMode() {
        function currentMode() {
            const cfg = (window.vsCodeEditorConfiguration && window.vsCodeEditorConfiguration.contextEditorCfg) || {};
            return cfg.updateMode === 'sticky' ? 'sticky' : 'live';
        }

        function paintUpdateMode(sticky) {
            const btn = document.getElementById('update-mode');
            const text = document.getElementById('update-mode-text');
            if (text) {
                text.textContent = sticky ? 'Sticky' : 'Live';
            }
            setNavIcon(document.getElementById('update-mode-icon'), sticky ? 'sticky' : 'live');
            if (btn) {
                btn.classList.toggle('is-sticky', sticky);
                btn.title = sticky
                    ? 'Update mode: Sticky — keep last context until a new symbol is found'
                    : 'Update mode: Live — clear when no symbol is found at the cursor';
            }
        }

        window.updateUpdateMode = function() {
            paintUpdateMode(currentMode() === 'sticky');
        };

        const btn = document.getElementById('update-mode');
        if (btn) {
            btn.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                const next = currentMode() === 'sticky' ? 'live' : 'sticky';
                paintUpdateMode(next === 'sticky');
                window.vscode.postMessage({ type: 'setUpdateMode', value: next });
            });
            btn.addEventListener('contextmenu', e => {
                e.preventDefault();
                e.stopPropagation();
            });
        }

        window.updateUpdateMode();
    }

    // 底部导航栏右侧 {si} 指示器：标识「双击选中整对括号/引号」开关状态，点击切换。
    function setupSiIndicator() {
        const siIndicator = document.getElementById('si-indicator');

        // 依据下发的 contextEditorCfg.doubleClickSelectsBracketPair 刷新指示器开/关外观与提示。
        // 暴露到 window，供 main.js 在收到 updateContextEditorCfg 时调用。
        window.updateSiIndicator = function() {
            const cfg = (window.vsCodeEditorConfiguration && window.vsCodeEditorConfiguration.contextEditorCfg) || {};
            const on = !!cfg.doubleClickSelectsBracketPair;
            window.selectBracketPairEnabled = on;
            if (!siIndicator) { return; }
            siIndicator.classList.toggle('enabled', on);
            siIndicator.title = on
                ? 'Double-click selects the whole bracket/quote pair (including delimiters): ON — click to disable'
                : 'Double-click selects the whole bracket/quote pair (including delimiters): OFF — click to enable';
        };

        window.flipSelectBracketPair = function() {
            const root = window.vsCodeEditorConfiguration || (window.vsCodeEditorConfiguration = {});
            const cfg = root.contextEditorCfg || (root.contextEditorCfg = {});
            cfg.doubleClickSelectsBracketPair = !cfg.doubleClickSelectsBracketPair;
            window.updateSiIndicator();
            window.vscode.postMessage({ type: 'toggleSelectBracketPair' });
        };

        if (siIndicator) {
            siIndicator.addEventListener('click', () => {
                window.flipSelectBracketPair();
            });
            // 该指示器区域禁用浏览器原生右键菜单，避免误触
            siIndicator.addEventListener('contextmenu', e => {
                e.preventDefault();
                e.stopPropagation();
            });
        }

        // 用初始下发的配置渲染一次
        window.updateSiIndicator();
    }

    function setupViewToggles() {
        const items = [
            {
                id: 'toggle-jump-trail',
                icon: 'jumpTrail',
                on: () => !!window.jumpTrailEnabled,
                title: on => on
                    ? 'Jump Trail: ON — click to hide the hop trail'
                    : 'Jump Trail: OFF — click to show the hop trail',
                flip: () => window.postMessage({ type: 'JumpTrail' })
            },
            {
                id: 'toggle-sticky-scroll',
                icon: 'stickyScroll',
                on: () => !!window.stickyScroll,
                title: on => on
                    ? 'Sticky Scroll: ON — click to hide sticky lines'
                    : 'Sticky Scroll: OFF — click to show sticky lines',
                flip: () => window.postMessage({ type: 'StickyScroll' })
            },
            {
                id: 'toggle-line-blame',
                icon: 'lineBlame',
                on: () => !!window.lineBlameEnabled,
                title: on => on
                    ? 'Git Line Blame: ON — click to hide line summaries'
                    : 'Git Line Blame: OFF — click to show line summaries',
                flip: () => window.postMessage({ type: 'LineBlame' })
            },
            {
                id: 'toggle-hover-tips',
                icon: 'hoverTips',
                on: () => !!window.enableHover,
                title: on => on
                    ? 'Hover Tips: ON — click to hide editor hover'
                    : 'Hover Tips: OFF — click to show editor hover',
                flip: () => window.postMessage({ type: 'EnableHover' })
            }
        ];

        window.updateViewToggles = function() {
            for (const item of items) {
                const el = document.getElementById(item.id);
                if (!el) {
                    continue;
                }
                const on = item.on();
                el.classList.toggle('is-on', on);
                el.title = item.title(on);
                el.setAttribute('aria-pressed', on ? 'true' : 'false');
            }
        };

        for (const item of items) {
            const el = document.getElementById(item.id);
            if (!el) {
                continue;
            }
            setNavIcon(el, item.icon);
            el.addEventListener('click', () => {
                item.flip();
            });
            el.addEventListener('contextmenu', e => {
                e.preventDefault();
                e.stopPropagation();
            });
        }
        window.updateViewToggles();
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

    window.showCustomContextMenu = function(e, items) {
        e.preventDefault();
        e.stopPropagation();
        const oldMenu = document.getElementById('custom-context-menu');
        if (oldMenu) {
            oldMenu.remove();
        }
        const menu = document.createElement('div');
        menu.id = 'custom-context-menu';
        menu.className = 'custom-context-menu';
        menu.style.visibility = 'hidden';
        menu.addEventListener('mousedown', ev => ev.stopPropagation());
        menu.addEventListener('mouseup', ev => ev.stopPropagation());
        menu.addEventListener('click', ev => ev.stopPropagation());
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
            if (item.disabled) {
                el.classList.add('is-disabled');
            }
            el.onclick = () => {
                if (!item.disabled && item.action) {
                    item.action();
                }
                menu.remove();
            };
            menu.appendChild(el);
        });
        document.body.appendChild(menu);
        const menuRect = menu.getBoundingClientRect();
        let left = e.clientX;
        let top = e.clientY;
        const padding = 4;
        if (left + menuRect.width > window.innerWidth - padding) {
            left = window.innerWidth - menuRect.width - padding;
        }
        if (top + menuRect.height > window.innerHeight - padding) {
            top = window.innerHeight - menuRect.height - padding;
        }
        menu.style.left = Math.max(left, padding) + 'px';
        menu.style.top = Math.max(top, padding) + 'px';
        menu.style.visibility = 'visible';
        document.addEventListener('mousedown', function onDocClick() {
            menu.remove();
            document.removeEventListener('mousedown', onDocClick);
        });
        window.addEventListener('blur', function onBlur() {
            menu.remove();
            window.removeEventListener('blur', onBlur);
        });
    };

    function handleContextMenu(e) {
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
            },
            {
                label: 'Float (Independent Window)',
                action: () => window.vscode.postMessage({ type: 'floatIndependent' })
            },
            { type: 'separator' },
            {
                label: 'Pick Token Style',
                checked: window.pickTokenStyle,
                action: () => window.postMessage({ type: 'PickTokenStyle' })
            }
        ];
        window.showCustomContextMenu(e, items);
    }
})();