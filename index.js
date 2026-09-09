// OOC Chat v1.4.1
// Dedicated OOC input bar for SillyTavern.

import { extension_settings, getContext } from '../../../extensions.js';
import { oai_settings, promptManager } from '../../../openai.js';
import { saveSettingsDebounced } from '../../../../script.js';

const EXT_NAME = 'OOC_CHAT';
const CONTAINER_ID = 'ooc-chat-container';
const ROW_ID = 'ooc-chat-row';
const LABEL_ID = 'ooc-chat-label';
const INPUT_ID = 'ooc-chat-input';
const SEND_ID = 'ooc-chat-send';
const COLLAPSE_ID = 'ooc-chat-collapse';
const SETTINGS_ID = 'ooc-chat-settings';
const POPOVER_ID = 'ooc-chat-prompt-popover';
const CLEAR_ID = 'ooc-chat-prompt-clear';

const defaultSettings = {
    instruction: 'Answer in English.',
    messageColor: '#8fd3ff',
    showInput: true,
    promptExclusions: {},
};

let settings = {};
let sending = false;
let eventsBound = false;
let documentHandlersBound = false;
let initialized = false;
let barCollapsed = false;

function loadSettings() {
    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = { ...defaultSettings };
    }

    settings = extension_settings[EXT_NAME];

    if (typeof settings.instruction !== 'string') {
        settings.instruction = defaultSettings.instruction;
    }
    if (typeof settings.messageColor !== 'string' || !settings.messageColor) {
        settings.messageColor = defaultSettings.messageColor;
    }
    if (typeof settings.showInput !== 'boolean') {
        settings.showInput = defaultSettings.showInput;
    }
    if (!settings.promptExclusions || typeof settings.promptExclusions !== 'object' || Array.isArray(settings.promptExclusions)) {
        settings.promptExclusions = {};
    }

    applyMessageColor();
}

function saveSettings() {
    extension_settings[EXT_NAME] = settings;
    saveSettingsDebounced();
}

function applyMessageColor() {
    document.documentElement.style.setProperty('--ooc-chat-message-color', settings.messageColor || defaultSettings.messageColor);
}

function applyBarVisibility() {
    const bar = document.getElementById(CONTAINER_ID);
    if (!bar) return;
    bar.hidden = !settings.showInput;
    if (!settings.showInput) closePromptPopover();
}

function setBarCollapsed(value) {
    barCollapsed = Boolean(value);
    const bar = document.getElementById(CONTAINER_ID);
    const collapseButton = document.getElementById(COLLAPSE_ID);
    if (!bar || !collapseButton) return;

    bar.classList.toggle('ooc-chat-collapsed', barCollapsed);
    collapseButton.setAttribute('aria-expanded', String(!barCollapsed));
    collapseButton.title = barCollapsed ? 'OOC 입력창 펼치기' : 'OOC 입력창 접기';

    const icon = collapseButton.querySelector('i');
    if (icon) {
        icon.className = barCollapsed ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down';
    }

    if (barCollapsed) closePromptPopover();
}

function toast(message, type = 'info') {
    const toastr = window.toastr;
    if (toastr && typeof toastr[type] === 'function') {
        toastr[type](message, 'OOC Chat');
    } else {
        console[type === 'error' ? 'error' : 'log'](`[OOC Chat] ${message}`);
    }
}

function resizeInput(input) {
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 96)}px`;
}

function setSendingState(value) {
    sending = value;

    const input = document.getElementById(INPUT_ID);
    const button = document.getElementById(SEND_ID);

    if (input) input.disabled = value;
    if (button) {
        button.disabled = value;
        button.classList.toggle('ooc-chat-sending', value);
        button.setAttribute('aria-busy', String(value));
    }
}

async function emitIfAvailable(context, eventName, messageId) {
    const eventType = context?.eventTypes?.[eventName];
    if (!eventType || !context?.eventSource?.emit) return;
    await context.eventSource.emit(eventType, messageId);
}

function getInstruction() {
    return String(settings.instruction ?? '').trim();
}

function buildOocMessageText(text, instruction = getInstruction()) {
    const inner = instruction ? `${instruction} ${text}` : text;
    return `(OOC: ${inner})`;
}

function getOocDisplayText(message) {
    if (!message?.extra?.ooc_chat) return null;

    if (typeof message.extra.ooc_display_text === 'string') {
        return message.extra.ooc_display_text;
    }

    const raw = String(message.mes ?? '');
    const match = raw.match(/^\(ooc:\s*([\s\S]*?)\)$/i);
    if (!match) return raw;

    let inner = match[1].trim();
    const candidates = [
        typeof message.extra.ooc_instruction === 'string' ? message.extra.ooc_instruction.trim() : '',
        getInstruction(),
        defaultSettings.instruction,
    ].filter(Boolean);

    for (const prefix of candidates) {
        if (inner.toLowerCase().startsWith(prefix.toLowerCase())) {
            inner = inner.slice(prefix.length).trimStart();
            break;
        }
    }

    return inner;
}

function decorateOocMessage(messageId) {
    const id = Number(messageId);
    if (!Number.isInteger(id)) return;

    const context = getContext();
    const message = context?.chat?.[id];
    if (!message?.extra?.ooc_chat) return;

    const messageElement = document.querySelector(`#chat .mes[mesid="${id}"]`);
    const textElement = messageElement?.querySelector('.mes_text');
    if (!messageElement || !textElement) return;

    const displayText = getOocDisplayText(message);
    if (displayText === null) return;

    messageElement.classList.add('ooc-chat-message');
    messageElement.dataset.oocChat = 'true';

    if (textElement.textContent !== displayText) {
        textElement.textContent = displayText;
    }
}

function decorateVisibleOocMessages() {
    const context = getContext();
    if (!context || !Array.isArray(context.chat)) return;

    document.querySelectorAll('#chat .mes[mesid]').forEach((messageElement) => {
        const id = Number(messageElement.getAttribute('mesid'));
        if (!Number.isInteger(id)) return;
        if (context.chat[id]?.extra?.ooc_chat) decorateOocMessage(id);
    });
}

function scheduleVisibleDecoration() {
    requestAnimationFrame(() => decorateVisibleOocMessages());
    setTimeout(decorateVisibleOocMessages, 100);
}

function getCurrentPresetName() {
    return String(oai_settings?.preset_settings_openai || 'Default');
}

function getPresetStorageKey(presetName = getCurrentPresetName()) {
    return encodeURIComponent(String(presetName));
}

function getExcludedPromptIds(presetName = getCurrentPresetName()) {
    const key = getPresetStorageKey(presetName);
    const value = settings.promptExclusions?.[key];
    return Array.isArray(value) ? value.filter(id => typeof id === 'string') : [];
}

function setPromptExcluded(presetName, identifier, excluded) {
    const key = getPresetStorageKey(presetName);
    const selected = new Set(getExcludedPromptIds(presetName));

    if (excluded) selected.add(identifier);
    else selected.delete(identifier);

    if (selected.size > 0) settings.promptExclusions[key] = [...selected];
    else delete settings.promptExclusions[key];

    saveSettings();
}

function clearPromptExclusions(presetName = getCurrentPresetName()) {
    const key = getPresetStorageKey(presetName);
    delete settings.promptExclusions[key];
    saveSettings();
    renderPromptPopover();
    requestAnimationFrame(positionPromptPopover);
}

function getCurrentPresetPromptEntries() {
    if (!promptManager || typeof promptManager.getPromptOrderForCharacter !== 'function' || typeof promptManager.getPromptById !== 'function') {
        return null;
    }

    try {
        const order = promptManager.getPromptOrderForCharacter(promptManager.activeCharacter);
        if (!Array.isArray(order)) return [];

        return order.flatMap((entry, index) => {
            if (!entry?.identifier) return [];
            const prompt = promptManager.getPromptById(entry.identifier);
            if (!prompt || prompt.marker || prompt.extension) return [];

            return [{
                identifier: String(entry.identifier),
                name: String(prompt.name || entry.identifier),
                role: String(prompt.role || ''),
                enabled: entry.enabled !== false,
                index,
            }];
        });
    } catch {
        return null;
    }
}

function ensurePromptPopover() {
    let popover = document.getElementById(POPOVER_ID);
    if (popover) return popover;

    popover = document.createElement('div');
    popover.id = POPOVER_ID;
    popover.hidden = true;
    popover.innerHTML = `
        <div class="ooc-chat-popover-header">
            <div class="ooc-chat-popover-heading">
                <div class="ooc-chat-popover-title">OOC 프롬프트 제외</div>
                <div id="ooc-chat-popover-preset" class="ooc-chat-popover-preset"></div>
            </div>
            <div class="ooc-chat-popover-actions">
                <button id="${CLEAR_ID}" class="menu_button ooc-chat-prompt-clear" type="button" title="현재 프리셋 체크 모두 해제">전체 해제</button>
                <button id="ooc-chat-popover-close" class="menu_button ooc-chat-popover-close" type="button" title="닫기" aria-label="닫기">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
        </div>
        <div id="ooc-chat-prompt-list" class="ooc-chat-prompt-list"></div>
        <div class="ooc-chat-popover-note">체크한 프롬프트는 이 프리셋에서 OOC로 보낼 때만 제외돼. 선택은 즉시 저장돼.</div>
    `;

    document.body.appendChild(popover);
    popover.querySelector('#ooc-chat-popover-close')?.addEventListener('click', closePromptPopover);
    popover.querySelector(`#${CLEAR_ID}`)?.addEventListener('click', () => clearPromptExclusions());
    return popover;
}

function renderPromptPopover() {
    const popover = ensurePromptPopover();
    const presetName = getCurrentPresetName();
    const presetElement = popover.querySelector('#ooc-chat-popover-preset');
    const listElement = popover.querySelector('#ooc-chat-prompt-list');
    const clearButton = popover.querySelector(`#${CLEAR_ID}`);
    if (!presetElement || !listElement) return;

    presetElement.textContent = `현재 프리셋: ${presetName}`;
    listElement.replaceChildren();

    const entries = getCurrentPresetPromptEntries();
    const selected = new Set(getExcludedPromptIds(presetName));
    if (clearButton) clearButton.disabled = selected.size === 0;

    if (entries === null) {
        const message = document.createElement('div');
        message.className = 'ooc-chat-prompt-empty';
        message.textContent = 'Prompt Manager를 아직 읽을 수 없어. 잠시 후 다시 열어줘.';
        listElement.appendChild(message);
        return;
    }

    if (entries.length === 0) {
        const message = document.createElement('div');
        message.className = 'ooc-chat-prompt-empty';
        message.textContent = '현재 프리셋에서 선택할 수 있는 프롬프트가 없어.';
        listElement.appendChild(message);
        return;
    }

    for (const entry of entries) {
        const label = document.createElement('label');
        label.className = 'ooc-chat-prompt-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = selected.has(entry.identifier);
        checkbox.dataset.promptIdentifier = entry.identifier;
        checkbox.addEventListener('change', () => {
            setPromptExcluded(presetName, entry.identifier, checkbox.checked);
            const currentSelected = getExcludedPromptIds(presetName);
            if (clearButton) clearButton.disabled = currentSelected.length === 0;
        });

        const text = document.createElement('span');
        text.className = 'ooc-chat-prompt-item-text';

        const name = document.createElement('span');
        name.className = 'ooc-chat-prompt-name';
        name.textContent = entry.name;

        const meta = document.createElement('span');
        meta.className = 'ooc-chat-prompt-meta';
        const metaParts = [];
        if (entry.role) metaParts.push(entry.role);
        if (!entry.enabled) metaParts.push('현재 OFF');
        meta.textContent = metaParts.join(' · ');

        text.appendChild(name);
        if (meta.textContent) text.appendChild(meta);
        label.append(checkbox, text);
        listElement.appendChild(label);
    }
}

function positionPromptPopover() {
    const popover = document.getElementById(POPOVER_ID);
    const label = document.getElementById(LABEL_ID);
    if (!popover || popover.hidden || !label) return;

    const rect = label.getBoundingClientRect();
    const margin = 8;
    const gap = 6;
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;

    let left = rect.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));

    let top = rect.top - height - gap;
    if (top < margin) top = rect.bottom + gap;
    top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));

    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
}

function openPromptPopover() {
    if (barCollapsed) return;
    const popover = ensurePromptPopover();
    renderPromptPopover();
    popover.hidden = false;
    requestAnimationFrame(positionPromptPopover);
}

function closePromptPopover() {
    const popover = document.getElementById(POPOVER_ID);
    if (popover) popover.hidden = true;
}

function togglePromptPopover() {
    const popover = ensurePromptPopover();
    if (popover.hidden) openPromptPopover();
    else closePromptPopover();
}

function applyPromptExclusionsForCurrentGeneration() {
    const excludedIds = getExcludedPromptIds();
    if (excludedIds.length === 0) return () => {};

    if (!promptManager || typeof promptManager.getPromptOrderEntry !== 'function') {
        throw new Error('Prompt Manager를 사용할 수 없어 OOC 프롬프트 제외를 적용할 수 없어.');
    }

    const states = [];
    for (const identifier of excludedIds) {
        const entry = promptManager.getPromptOrderEntry(promptManager.activeCharacter, identifier);
        if (!entry) continue;
        states.push({ entry, enabled: entry.enabled });
        entry.enabled = false;
    }

    return () => {
        for (const state of states) {
            state.entry.enabled = state.enabled;
        }
    };
}

async function sendOocMessage() {
    if (sending) return;

    const input = document.getElementById(INPUT_ID);
    if (!input) return;

    const text = input.value.trim();
    if (!text) return;

    const context = getContext();
    if (!context || !Array.isArray(context.chat)) {
        toast('현재 채팅을 찾을 수 없어.', 'error');
        return;
    }

    const hasCharacter = context.characterId !== undefined && context.characterId !== null;
    const hasGroup = context.groupId !== undefined && context.groupId !== null && context.groupId !== '';
    if (!hasCharacter && !hasGroup) {
        toast('먼저 캐릭터나 그룹 채팅을 열어줘.', 'warning');
        return;
    }

    const instruction = getInstruction();
    const message = {
        name: context.name1,
        is_user: true,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: buildOocMessageText(text, instruction),
        extra: {
            ooc_chat: true,
            ooc_instruction: instruction,
        },
    };

    setSendingState(true);
    closePromptPopover();

    let restorePromptStates = () => {};

    try {
        restorePromptStates = applyPromptExclusionsForCurrentGeneration();

        context.chat.push(message);
        const messageId = context.chat.length - 1;

        await emitIfAvailable(context, 'MESSAGE_SENT', messageId);
        context.addOneMessage(message);
        await emitIfAvailable(context, 'USER_MESSAGE_RENDERED', messageId);
        await context.saveChat();

        decorateOocMessage(messageId);

        input.value = '';
        resizeInput(input);
        context.scrollChatToBottom?.();

        // /trigger normally returns before Generate() runs. await=true keeps the
        // selected prompts disabled through prompt assembly and the generation.
        await context.executeSlashCommandsWithOptions('/trigger await=true', {
            handleParserErrors: true,
            handleExecutionErrors: true,
        });
    } catch (error) {
        console.error('[OOC Chat] Failed to send OOC message:', error);
        toast(`OOC 전송 오류: ${error?.message || error}`, 'error');
    } finally {
        restorePromptStates();
        setSendingState(false);
        if (!barCollapsed && settings.showInput) input.focus();
    }
}

function buildBar() {
    const container = document.createElement('div');
    container.id = CONTAINER_ID;
    container.innerHTML = `
        <div id="${ROW_ID}" class="ooc-chat-row">
            <button id="${LABEL_ID}" class="ooc-chat-label" type="button" title="OOC 프롬프트 제외 설정" aria-label="OOC 프롬프트 제외 설정">OOC</button>
            <textarea
                id="${INPUT_ID}"
                class="text_pole"
                rows="1"
                spellcheck="true"
                autocomplete="off"
                placeholder="OOC question..."
                aria-label="OOC message input"
            ></textarea>
            <button
                id="${SEND_ID}"
                class="menu_button"
                type="button"
                title="Send OOC message"
                aria-label="Send OOC message"
            >
                <i class="fa-solid fa-paper-plane"></i>
            </button>
        </div>
        <button id="${COLLAPSE_ID}" class="ooc-chat-collapse" type="button" title="OOC 입력창 접기" aria-label="OOC 입력창 접기" aria-expanded="true">
            <i class="fa-solid fa-chevron-down"></i>
        </button>
    `;

    const input = container.querySelector(`#${INPUT_ID}`);
    const sendButton = container.querySelector(`#${SEND_ID}`);
    const labelButton = container.querySelector(`#${LABEL_ID}`);
    const collapseButton = container.querySelector(`#${COLLAPSE_ID}`);

    input.addEventListener('input', () => resizeInput(input));
    input.addEventListener('keydown', (event) => {
        if (event.isComposing || event.keyCode === 229) return;

        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendOocMessage();
        }
    });

    sendButton.addEventListener('click', sendOocMessage);
    labelButton.addEventListener('click', togglePromptPopover);
    collapseButton.addEventListener('click', () => setBarCollapsed(!barCollapsed));
    return container;
}

function findSettingsRoot() {
    return document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
}

function injectSettingsPanel() {
    if (document.getElementById(SETTINGS_ID)) return true;

    const settingsRoot = findSettingsRoot();
    if (!settingsRoot) return false;

    const panel = document.createElement('div');
    panel.id = SETTINGS_ID;
    panel.className = 'extension_container';
    panel.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>OOC Chat</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down interactable" tabindex="0"></div>
            </div>
            <div class="inline-drawer-content ooc-chat-settings-content">
                <label class="checkbox_label" for="ooc-chat-show-input">
                    <input id="ooc-chat-show-input" type="checkbox" />
                    <span>OOC 입력창 보이기</span>
                </label>

                <label for="ooc-chat-instruction">OOC 뒤 고정 문구</label>
                <textarea
                    id="ooc-chat-instruction"
                    class="text_pole"
                    rows="2"
                    placeholder="예: Answer in English."
                ></textarea>
                <small>모델에는 (OOC: [이 문구] [입력 내용]) 형태로 전달돼. 비워두면 (OOC: [입력 내용])만 전달돼.</small>

                <label for="ooc-chat-color">OOC 메시지 글자색</label>
                <div class="ooc-chat-color-row">
                    <input id="ooc-chat-color" type="color" />
                    <span id="ooc-chat-color-value"></span>
                </div>

                <small>입력창 왼쪽의 OOC 버튼을 누르면 현재 프리셋의 OOC 제외 프롬프트를 선택할 수 있어.</small>
                <button id="ooc-chat-settings-save" class="menu_button" type="button">저장</button>
            </div>
        </div>
    `;

    settingsRoot.appendChild(panel);

    const showInput = panel.querySelector('#ooc-chat-show-input');
    const instructionInput = panel.querySelector('#ooc-chat-instruction');
    const colorInput = panel.querySelector('#ooc-chat-color');
    const colorValue = panel.querySelector('#ooc-chat-color-value');
    const saveButton = panel.querySelector('#ooc-chat-settings-save');

    showInput.checked = settings.showInput;
    instructionInput.value = settings.instruction;
    colorInput.value = settings.messageColor;
    colorValue.textContent = settings.messageColor;

    showInput.addEventListener('change', () => {
        settings.showInput = showInput.checked;
        applyBarVisibility();
        saveSettings();
    });

    colorInput.addEventListener('input', () => {
        colorValue.textContent = colorInput.value;
        document.documentElement.style.setProperty('--ooc-chat-message-color', colorInput.value);
    });

    saveButton.addEventListener('click', () => {
        settings.showInput = showInput.checked;
        settings.instruction = instructionInput.value.trim();
        settings.messageColor = colorInput.value;
        applyBarVisibility();
        applyMessageColor();
        saveSettings();
        scheduleVisibleDecoration();
        toast('설정을 저장했어.', 'success');
    });

    return true;
}

function ensureOocBar() {
    let bar = document.getElementById(CONTAINER_ID);

    if (!bar) {
        const sendForm = document.getElementById('send_form');
        if (!sendForm?.parentElement) return false;

        bar = buildBar();
        sendForm.parentElement.insertBefore(bar, sendForm);
        setBarCollapsed(barCollapsed);
    }

    applyBarVisibility();
    return true;
}

function ensureUi() {
    ensureOocBar();
    injectSettingsPanel();
}

function scheduleUiBootstrap() {
    [0, 250, 1000, 2500, 5000].forEach((delay) => {
        setTimeout(ensureUi, delay);
    });
}

function bindDocumentHandlers() {
    if (documentHandlersBound) return;
    documentHandlersBound = true;

    document.addEventListener('pointerdown', (event) => {
        const popover = document.getElementById(POPOVER_ID);
        if (!popover || popover.hidden) return;

        const label = document.getElementById(LABEL_ID);
        if (popover.contains(event.target) || label?.contains(event.target)) return;
        closePromptPopover();
    }, true);

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closePromptPopover();
    });

    window.addEventListener('resize', () => {
        const popover = document.getElementById(POPOVER_ID);
        if (popover && !popover.hidden) positionPromptPopover();
    });
}

function bindEvents() {
    if (eventsBound) return;

    const context = getContext();
    const eventSource = context?.eventSource;
    const eventTypes = context?.eventTypes;
    if (!eventSource || !eventTypes) return;

    if (eventTypes.APP_READY) {
        eventSource.on(eventTypes.APP_READY, () => {
            ensureUi();
            scheduleVisibleDecoration();
        });
    }

    if (eventTypes.CHAT_CHANGED) {
        eventSource.on(eventTypes.CHAT_CHANGED, () => {
            ensureOocBar();
            closePromptPopover();
            scheduleVisibleDecoration();
        });
    }

    if (eventTypes.OAI_PRESET_CHANGED_AFTER) {
        eventSource.on(eventTypes.OAI_PRESET_CHANGED_AFTER, () => {
            const popover = document.getElementById(POPOVER_ID);
            if (popover && !popover.hidden) {
                renderPromptPopover();
                requestAnimationFrame(positionPromptPopover);
            }
        });
    }

    if (eventTypes.USER_MESSAGE_RENDERED) {
        eventSource.on(eventTypes.USER_MESSAGE_RENDERED, (messageId) => decorateOocMessage(messageId));
    }

    if (eventTypes.MESSAGE_EDITED) {
        eventSource.on(eventTypes.MESSAGE_EDITED, (messageId) => {
            setTimeout(() => decorateOocMessage(messageId), 0);
        });
    }

    eventsBound = true;
}

async function initOocChat() {
    if (initialized) return;
    initialized = true;

    loadSettings();
    bindEvents();
    bindDocumentHandlers();
    ensureUi();
    scheduleUiBootstrap();
    scheduleVisibleDecoration();
    console.log('[OOC Chat] v1.4.1 loaded');
}

export async function init() {
    await initOocChat();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOocChat, { once: true });
} else {
    initOocChat();
}
