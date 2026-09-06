// OOC Chat v1.0.0
// Dedicated OOC input bar for SillyTavern.

import { getContext } from '../../../extensions.js';

const CONTAINER_ID = 'ooc-chat-container';
const INPUT_ID = 'ooc-chat-input';
const SEND_ID = 'ooc-chat-send';
const OOC_PREFIX = '(ooc: Answer in English. ';

let sending = false;
let observer = null;

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

    const messageText = `${OOC_PREFIX}${text})`;
    const message = {
        name: context.name1,
        is_user: true,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: messageText,
        extra: {
            ooc_chat: true,
        },
    };

    setSendingState(true);

    try {
        // Add the OOC text as a real user message without touching #send_textarea.
        context.chat.push(message);
        const messageId = context.chat.length - 1;

        await emitIfAvailable(context, 'MESSAGE_SENT', messageId);
        context.addOneMessage(message);
        await emitIfAvailable(context, 'USER_MESSAGE_RENDERED', messageId);
        await context.saveChat();

        input.value = '';
        resizeInput(input);
        context.scrollChatToBottom?.();

        // Generate from the newly-added OOC user message.
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
        // Do not send in the middle of Korean/Japanese/Chinese IME composition.
        if (event.isComposing || event.keyCode === 229) return;

        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendOocMessage();
        }
    });

    button.addEventListener('click', sendOocMessage);
    return container;
}

function ensureOocBar() {
    if (document.getElementById(CONTAINER_ID)) return;

    const sendForm = document.getElementById('send_form');
    if (!sendForm?.parentElement) return;

    const bar = buildBar();
    sendForm.parentElement.insertBefore(bar, sendForm);
}

function startObserver() {
    if (observer || !document.body) return;

    observer = new MutationObserver(() => ensureOocBar());
    observer.observe(document.body, {
        childList: true,
        subtree: true,
    });
}

async function initOocChat() {
    ensureOocBar();
    startObserver();
    console.log('[OOC Chat] v1.0.0 loaded');
}

export async function init() {
    await initOocChat();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOocChat, { once: true });
} else {
    initOocChat();
}

setTimeout(ensureOocBar, 500);
