// OOC Chat v1.2.0
// Dedicated OOC input bar for SillyTavern.

import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const EXT_NAME = 'OOC_CHAT';
const CONTAINER_ID = 'ooc-chat-container';
const INPUT_ID = 'ooc-chat-input';
const SEND_ID = 'ooc-chat-send';
const SETTINGS_ID = 'ooc-chat-settings';

const defaultSettings = {
    instruction: 'Answer in English.',
    messageColor: '#8fd3ff',
    showInput: true,
};

let settings = {};
let sending = false;
let bodyObserver = null;
let chatObserver = null;

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

function buildOocMessageText(text) {
    const instruction = String(settings.instruction ?? '').trim();
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
        String(settings.instruction ?? '').trim(),
        'Answer in English.',
    ].filter(Boolean);

    for (const prefix of candidates) {
        if (inner.toLowerCase().startsWith(prefix.toLowerCase())) {
            inner = inner.slice(prefix.length).trimStart();
            break;
        }
    }

    return inner;
}

function decorateOocMessages() {
    const context = getContext();
    if (!context || !Array.isArray(context.chat)) return;

    document.querySelectorAll('#chat .mes[mesid]').forEach((messageElement) => {
        const messageId = Number(messageElement.getAttribute('mesid'));
        if (!Number.isInteger(messageId)) return;

        const message = context.chat[messageId];
        if (!message?.extra?.ooc_chat) {
            messageElement.classList.remove('ooc-chat-message');
            return;
        }

        const displayText = getOocDisplayText(message);
        const textElement = messageElement.querySelector('.mes_text');
        if (!textElement || displayText === null) return;

        messageElement.classList.add('ooc-chat-message');
        messageElement.dataset.oocChat = 'true';

        if (textElement.textContent !== displayText) {
            textElement.textContent = displayText;
        }
    });
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

    const messageText = buildOocMessageText(text);
    const message = {
        name: context.name1,
        is_user: true,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: messageText,
        extra: {
            ooc_chat: true,
            ooc_display_text: text,
        },
    };

    setSendingState(true);

    try {
        context.chat.push(message);
        const messageId = context.chat.length - 1;

        await emitIfAvailable(context, 'MESSAGE_SENT', messageId);
        context.addOneMessage(message);
        await emitIfAvailable(context, 'USER_MESSAGE_RENDERED', messageId);
        await context.saveChat();

        decorateOocMessages();

        input.value = '';
        resizeInput(input);
        context.scrollChatToBottom?.();

        await context.executeSlashCommandsWithOptions('/trigger', {
            handleParserErrors: true,
            handleExecutionErrors: true,
        });
    } catch (error) {
        console.error('[OOC Chat] Failed to send OOC message:', error);
        toast(`OOC 전송 오류: ${error?.message || error}`, 'error');
    } finally {
        setSendingState(false);
        input.focus();
    }
}

function buildBar() {
    const container = document.createElement('div');
    container.id = CONTAINER_ID;
    container.innerHTML = `
        <div class="ooc-chat-label" title="Out of Character">OOC</div>
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
    `;

    const input = container.querySelector(`#${INPUT_ID}`);
    const button = container.querySelector(`#${SEND_ID}`);

    input.addEventListener('input', () => resizeInput(input));
    input.addEventListener('keydown', (event) => {
        if (event.isComposing || event.keyCode === 229) return;

        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendOocMessage();
        }
    });

    button.addEventListener('click', sendOocMessage);
    return container;
}

function injectSettingsPanel() {
    if (document.getElementById(SETTINGS_ID)) return;

    const settingsRoot = document.getElementById('extensions_settings');
    if (!settingsRoot) return;

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
        decorateOocMessages();
        toast('설정을 저장했어.', 'success');
    });
}

function ensureOocBar() {
    let bar = document.getElementById(CONTAINER_ID);

    if (!bar) {
        const sendForm = document.getElementById('send_form');
        if (!sendForm?.parentElement) return;

        bar = buildBar();
        sendForm.parentElement.insertBefore(bar, sendForm);
    }

    applyBarVisibility();
}

function ensureChatObserver() {
    const chat = document.getElementById('chat');
    if (!chat || chatObserver) return;

    chatObserver = new MutationObserver(() => decorateOocMessages());
    chatObserver.observe(chat, {
        childList: true,
        subtree: true,
    });
}

function startBodyObserver() {
    if (bodyObserver || !document.body) return;

    bodyObserver = new MutationObserver(() => {
        ensureOocBar();
        injectSettingsPanel();
        ensureChatObserver();
    });

    bodyObserver.observe(document.body, {
        childList: true,
        subtree: true,
    });
}

async function initOocChat() {
    loadSettings();
    ensureOocBar();
    injectSettingsPanel();
    ensureChatObserver();
    decorateOocMessages();
    startBodyObserver();
    console.log('[OOC Chat] v1.2.0 loaded');
}

export async function init() {
    await initOocChat();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOocChat, { once: true });
} else {
    initOocChat();
}

setTimeout(() => {
    ensureOocBar();
    injectSettingsPanel();
    ensureChatObserver();
    decorateOocMessages();
}, 500);
