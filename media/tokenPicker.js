//@ts-check

// Token style picker (color + bold + italic). Only OK applies; anything else closes without saving.

let lastPickColorPosition = null;

export function resetPickColorPosition() {
    lastPickColorPosition = null;
}

function el(tag, className) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    return node;
}

function normalizeHex(c) {
    if (typeof c !== 'string') {
        return '';
    }
    let s = c.trim();
    if (!s) {
        return '';
    }
    if (!s.startsWith('#')) {
        s = '#' + s;
    }
    return /^#[0-9a-fA-F]{6,8}$/.test(s) ? s.slice(0, 7) : s;
}

/**
 * @param {{ token?: string, foreground?: string, fontStyle?: string, description?: string, source?: string }} options
 * @param {string} domColor
 * @param {string} word
 */
export async function pickTokenStyle(options = {
    token: '',
    foreground: '#ff0000',
    fontStyle: '',
    description: '',
    source: ''
}, domColor = '#808080', word = '') {
    const hasInitialColor = typeof options.foreground === 'string' && !!options.foreground.trim();
    const initialColor = hasInitialColor ? normalizeHex(options.foreground) : '#ff0000';
    const fallbackColor = normalizeHex(domColor) || '#808080';
    const style = {
        bold: options.fontStyle?.includes('bold') || false,
        italic: options.fontStyle?.includes('italic') || false
    };
    const tokenText = options.token || '';
    const SOURCE_LABELS = {
        monaco: 'monaco',
        semantic: 'semantic',
        textmate: 'textmate',
        custom: 'custom'
    };

    return new Promise(resolve => {
        try {
            let colorPicking = false;
            const container = el('div', 'tp-dialog');

            const head = el('div', 'tp-head');
            const title = el('div', 'tp-title');
            title.textContent = 'Token Style';
            const closeButton = el('button', 'tp-close');
            closeButton.type = 'button';
            closeButton.textContent = '×';
            closeButton.title = 'Close';
            closeButton.setAttribute('aria-label', 'Close');
            head.appendChild(title);
            head.appendChild(closeButton);

            const preview = el('div', 'tp-preview');
            const wordEl = el('div', 'tp-word');
            let displayWord = word || 'Cur Token';
            if (displayWord.length > 30) {
                displayWord = displayWord.slice(0, 27) + '...';
            }
            wordEl.textContent = displayWord;
            const scopeEl = el('div', 'tp-scope');
            scopeEl.textContent = tokenText || '(none)';
            preview.appendChild(wordEl);
            preview.appendChild(scopeEl);

            const styleContainer = el('div', 'tp-controls');

            const colorContainer = document.createElement('div');
            colorContainer.style.position = 'relative';
            colorContainer.style.width = '30px';
            colorContainer.style.height = '30px';

            const input = document.createElement('input');
            input.type = 'color';
            input.value = hasInitialColor ? initialColor : fallbackColor;
            input.style.width = '30px';
            input.style.height = '30px';

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
            slash.style.width = '42.426px';
            slash.style.height = '2px';
            slash.style.background = 'var(--vscode-errorForeground)';
            slash.style.transform = 'rotate(45deg)';
            slash.style.opacity = '0.7';
            disabledIndicator.appendChild(slash);

            colorContainer.appendChild(input);
            colorContainer.appendChild(disabledIndicator);

            const noColorButton = document.createElement('div');
            noColorButton.style.position = 'relative';
            noColorButton.style.width = '15px';
            noColorButton.style.height = '15px';
            noColorButton.style.cursor = 'pointer';
            noColorButton.style.display = 'flex';
            noColorButton.style.alignItems = 'center';
            noColorButton.style.justifyContent = 'center';
            noColorButton.style.border = '1px solid var(--vscode-button-border, transparent)';
            noColorButton.style.borderRadius = '2px';
            noColorButton.style.backgroundColor = 'var(--vscode-button-background)';
            noColorButton.style.marginLeft = '-8px';
            noColorButton.style.marginRight = '8px';
            noColorButton.style.alignSelf = 'flex-end';
            noColorButton.title = 'Use theme default';
            noColorButton.addEventListener('mouseover', () => {
                noColorButton.style.backgroundColor = 'var(--vscode-button-hoverBackground)';
            });
            noColorButton.addEventListener('mouseout', () => {
                noColorButton.style.backgroundColor = 'var(--vscode-button-background)';
            });
            const buttonSlash = document.createElement('div');
            buttonSlash.style.width = '12px';
            buttonSlash.style.height = '1.5px';
            buttonSlash.style.background = 'var(--vscode-button-foreground)';
            buttonSlash.style.transform = 'rotate(45deg)';
            buttonSlash.style.opacity = '0.9';
            noColorButton.appendChild(buttonSlash);

            const boldCheckbox = document.createElement('input');
            boldCheckbox.type = 'checkbox';
            boldCheckbox.id = 'bold-checkbox';
            boldCheckbox.checked = style.bold;
            boldCheckbox.style.margin = '0';
            const boldLabel = document.createElement('label');
            boldLabel.htmlFor = 'bold-checkbox';
            boldLabel.textContent = 'Bold';
            boldLabel.style.color = 'var(--vscode-editor-foreground)';
            boldLabel.addEventListener('click', e => {
                e.preventDefault();
                boldCheckbox.click();
            });

            const italicCheckbox = document.createElement('input');
            italicCheckbox.type = 'checkbox';
            italicCheckbox.id = 'italic-checkbox';
            italicCheckbox.checked = style.italic;
            italicCheckbox.style.margin = '0';
            const italicLabel = document.createElement('label');
            italicLabel.htmlFor = 'italic-checkbox';
            italicLabel.textContent = 'Italic';
            italicLabel.style.color = 'var(--vscode-editor-foreground)';
            italicLabel.addEventListener('click', e => {
                e.preventDefault();
                italicCheckbox.click();
            });

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

            const sourceBadge = document.createElement('span');
            sourceBadge.textContent = SOURCE_LABELS[options.source] || '';
            sourceBadge.title = 'Active token source';
            sourceBadge.style.marginLeft = 'auto';
            sourceBadge.style.alignSelf = 'center';
            sourceBadge.style.padding = '2px 8px';
            sourceBadge.style.fontSize = '12px';
            sourceBadge.style.fontFamily = 'var(--vscode-font-family)';
            sourceBadge.style.borderRadius = '3px';
            sourceBadge.style.whiteSpace = 'nowrap';
            sourceBadge.style.color = 'var(--vscode-badge-foreground)';
            sourceBadge.style.background = 'var(--vscode-badge-background)';
            sourceBadge.style.border = '1px solid var(--vscode-contrastBorder, transparent)';

            styleContainer.appendChild(colorContainer);
            styleContainer.appendChild(noColorButton);
            styleContainer.appendChild(boldOption);
            styleContainer.appendChild(italicOption);
            if (sourceBadge.textContent) {
                styleContainer.appendChild(sourceBadge);
            }

            const actions = el('div', 'tp-actions');
            const okButton = el('button', 'tp-ok');
            okButton.type = 'button';
            okButton.textContent = 'OK';
            actions.appendChild(okButton);

            container.appendChild(head);
            container.appendChild(preview);
            container.appendChild(styleContainer);
            container.appendChild(actions);

            const colorCleared = () => disabledIndicator.style.display === 'flex';

            const paintPreview = () => {
                const shown = colorCleared()
                    ? fallbackColor
                    : (normalizeHex(input.value) || fallbackColor);
                wordEl.style.color = shown;
                wordEl.style.fontWeight = boldCheckbox.checked ? '700' : '400';
                wordEl.style.fontStyle = italicCheckbox.checked ? 'italic' : 'normal';
            };

            const currentResult = () => ({
                foreground: colorCleared() ? null : input.value,
                bold: boldCheckbox.checked,
                italic: italicCheckbox.checked
            });

            input.addEventListener('mousedown', () => {
                colorPicking = true;
            });
            input.addEventListener('input', () => {
                colorPicking = false;
                disabledIndicator.style.display = 'none';
                paintPreview();
            });
            input.addEventListener('change', () => {
                colorPicking = false;
                disabledIndicator.style.display = 'none';
                paintPreview();
            });
            noColorButton.addEventListener('click', () => {
                disabledIndicator.style.display = 'flex';
                input.value = fallbackColor;
                paintPreview();
            });
            boldCheckbox.addEventListener('change', paintPreview);
            italicCheckbox.addEventListener('change', paintPreview);

            if (lastPickColorPosition) {
                container.style.left = lastPickColorPosition.left + 'px';
                container.style.top = lastPickColorPosition.top + 'px';
            } else {
                container.style.left = '50%';
                container.style.top = '50%';
                container.style.transform = 'translate(-50%, -50%)';
            }

            document.body.appendChild(container);
            paintPreview();

            let isDragging = false;
            let startX = 0;
            let startY = 0;
            let startLeft = 0;
            let startTop = 0;

            head.addEventListener('mousedown', e => {
                if (e.target === closeButton || closeButton.contains(/** @type {Node} */ (e.target))) {
                    return;
                }
                isDragging = true;
                startX = e.clientX;
                startY = e.clientY;
                const rect = container.getBoundingClientRect();
                startLeft = rect.left;
                startTop = rect.top;
                container.style.transform = 'none';
                container.style.left = startLeft + 'px';
                container.style.top = startTop + 'px';
            });

            const dragHandler = e => {
                if (!isDragging) {
                    return;
                }
                const left = startLeft + (e.clientX - startX);
                const top = startTop + (e.clientY - startY);
                container.style.left = left + 'px';
                container.style.top = top + 'px';
                lastPickColorPosition = { left, top };
            };

            const dragEndHandler = () => {
                if (isDragging) {
                    const rect = container.getBoundingClientRect();
                    lastPickColorPosition = { left: rect.left, top: rect.top };
                }
                isDragging = false;
            };

            document.addEventListener('mousemove', dragHandler);
            document.addEventListener('mouseup', dragEndHandler);

            /** @type {((e: MouseEvent) => void) | null} */
            let outsideClickHandler = null;
            /** @type {((e: KeyboardEvent) => void) | null} */
            let escHandler = null;
            /** @type {(() => void) | null} */
            let blurHandler = null;
            let settled = false;

            const cleanup = () => {
                if (container.parentNode) {
                    const rect = container.getBoundingClientRect();
                    lastPickColorPosition = { left: rect.left, top: rect.top };
                    container.parentNode.removeChild(container);
                }
                document.removeEventListener('mousemove', dragHandler);
                document.removeEventListener('mouseup', dragEndHandler);
                if (outsideClickHandler) {
                    document.removeEventListener('mousedown', outsideClickHandler);
                }
                if (escHandler) {
                    document.removeEventListener('keydown', escHandler);
                }
                if (blurHandler) {
                    window.removeEventListener('blur', blurHandler);
                }
            };

            const finish = apply => {
                if (settled) {
                    return;
                }
                settled = true;
                const result = apply ? currentResult() : null;
                cleanup();
                resolve(result);
            };

            okButton.addEventListener('click', () => finish(true));
            closeButton.addEventListener('click', () => finish(false), { once: true });

            escHandler = e => {
                if (e.key === 'Escape') {
                    finish(false);
                }
            };
            document.addEventListener('keydown', escHandler);

            blurHandler = () => {
                if (colorPicking) {
                    colorPicking = false;
                    return;
                }
                finish(false);
            };
            window.addEventListener('blur', blurHandler);

            outsideClickHandler = e => {
                if (!container.contains(/** @type {Node} */ (e.target))) {
                    finish(false);
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
