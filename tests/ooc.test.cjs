const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export async function init()', 'async function init()');
const flush = () => new Promise(resolve => setImmediate(resolve));
const LEGACY = 'OOC_CHAT_PERSONA_PROMPT', PRESETS = 'OOC_CHAT_PERSONA_PRESETS';

function setup({ text = '설명해 줘', storage = new Map(), translator = true, translationEnabled=true, savedSettings=null } = {}) {
    const input = { value: text, disabled: false, style: {}, focus() {}, scrollHeight: 32 };
    const button = { disabled: false, classList: { toggle() {} }, setAttribute() {} };
    const listeners = {}, requests = [], saves = [], rendered = [], prompts = [], toasts = [];
    const entries = { a: { enabled: true }, b: { enabled: false } };
    let chatId = 'first', failStorage = false, failSave = false, saveHook, generateHook, copyHook;
    const extension_settings = { OOC_CHAT: savedSettings??{ instruction: 'Answer in English.', promptExclusions: { Default: ['a', 'b'] } } };
    if(!savedSettings&&translationEnabled!==null)extension_settings.OOC_CHAT.translateInput=translationEnabled;
    const context = {
        chat: [], characterId: 0, groupId: null, name1: 'Tester',
        accountStorage: {
            getItem: key => storage.get(key) ?? null,
            setItem: (key, value) => { if (failStorage) throw Error('storage failed'); storage.set(key, value); },
        },
        eventTypes: { CHAT_CHANGED: 'changed', MESSAGE_SENT: 'sent', USER_MESSAGE_RENDERED: 'rendered' },
        eventSource: {
            on: (type, fn) => (listeners[type] ??= []).push(fn),
            emit: async (type, id) => { for (const fn of listeners[type] ?? []) await fn(id); },
        },
        saveChat: async () => { if (failSave) throw Error('save failed'); saves.push(JSON.parse(JSON.stringify(context.chat))); await saveHook?.(); },
        addOneMessage: message => rendered.push(message.mes),
        executeSlashCommandsWithOptions: async () => {
            if (generateHook) await generateHook();
            let copy = context.chat.filter(m => !m.is_system).map((m, index) => ({ ...m, index }));
            if(copyHook)copy=copyHook(copy);
            let aborted = false;
            sandbox.oocChatGenerationInterceptor(copy, 4096, () => { aborted = true; });
            if (!aborted) { prompts.push(copy); await context.saveChat(); }
        },
    };
    const sandbox = {
        getContext: () => context, extension_settings,
        oai_settings: { preset_settings_openai: 'Default' },
        promptManager: { activeCharacter: 0, getPromptOrderEntry: (_, id) => entries[id] },
        getCurrentChatId: () => chatId, is_send_press: false, saveSettingsDebounced() {},
        crypto: { randomUUID }, AbortController,
        console: { log() {}, error() {} }, requestAnimationFrame() {}, setTimeout() {},
        document: {
            readyState: 'loading', addEventListener() {},
            documentElement: { style: { setProperty() {} } },
            getElementById: id => ({ 'ooc-chat-input': input, 'ooc-chat-send': button })[id] ?? null,
        },
        window: { toastr: { error: message => toasts.push(message) } },
    };
    if (translator) sandbox.window.inputTranslator = { version: 1, translate: (text, options) => new Promise((resolve, reject) => requests.push({ text, options, resolve, reject })) };
    vm.createContext(sandbox);
    vm.runInContext(source + '\nthis.api={sendOocMessage,getPersonaStore,getPersonaPrompt,selectPersonaPrompt,savePersonaPrompt,deletePersonaPrompt,getOocDisplayText,buildOocGenerationText,setTranslationEnabled}; loadSettings(); ensureOocBar=()=>{};scheduleVisibleDecoration=()=>{};decorateOocMessage=()=>{};bindEvents();', sandbox);
    return {
        ...sandbox.api, input, requests, context, saves, rendered, prompts, entries, storage, toasts, sandbox,
        settings:extension_settings.OOC_CHAT,
        reply: value => requests.at(-1).resolve(value),
        changeChat: async (id = 'second', replace = true) => { chatId = id; if (replace) context.chat = []; await context.eventSource.emit('changed'); },
        edit: value => { input.value = value; vm.runInContext('inputRevision+=1;', sandbox); },
        failStorage: value => { failStorage = value; }, failSave: value => { failSave = value; },
        onSave: fn => { saveHook = fn; }, onGenerate: fn => { generateHook = fn; },
        onModelCopy: fn => { copyHook=fn; },
    };
}

test('Korean input: only one translation, identical English in display, saves and model request', async () => {
    const s = setup(); const pending = s.sendOocMessage();
    await s.sendOocMessage(); assert.equal(s.requests.length, 1); assert.equal(s.context.chat.length, 0);
    s.reply('Please explain.'); await pending;
    assert.equal(s.getOocDisplayText(s.context.chat[0]), 'Please explain.');
    assert.equal(s.rendered[0], '(OOC: Answer in English. Please explain.)');
    assert.equal(s.prompts[0][0].mes, s.context.chat[0].mes);
    assert.ok(s.saves.every(chat => chat[0].mes === s.context.chat[0].mes));
    assert.equal(s.input.value, ''); assert.equal(s.input.disabled, false);
    assert.equal(s.entries.a.enabled, true); assert.equal(s.entries.b.enabled, false);
});

test('English/wrapped OOC sends directly without translator; no character and host busy do not send', async () => {
    const s = setup({ text: '(OOC: Explain.)', translator: false }); await s.sendOocMessage();
    assert.equal(s.getOocDisplayText(s.context.chat[0]), 'Explain.');
    for (const mode of ['busy', 'no character']) {
        const blocked = setup({ text: 'Explain.' });
        if (mode === 'busy') blocked.sandbox.is_send_press = true; else blocked.context.characterId = null;
        await blocked.sendOocMessage(); assert.equal(blocked.context.chat.length, 0);
    }
});

for (const response of ['', '  ', '한글', '/send bad', undefined, { content: 'English' }]) {
    test(`invalid external result ${JSON.stringify(response)} preserves source and never saves/sends`, async () => {
        const s = setup(); const pending = s.sendOocMessage(); s.reply(response); await pending;
        assert.equal(s.input.value, '설명해 줘'); assert.equal(s.saves.length, 0); assert.equal(s.prompts.length, 0); assert.equal(s.input.disabled, false);
    });
}

test('missing translator and failed provider preserve source and allow retry', async () => {
    const missing = setup({ translator: false }); await missing.sendOocMessage(); assert.equal(missing.context.chat.length, 0);
    const s = setup(); let pending = s.sendOocMessage(); s.requests[0].reject(Error('provider failed')); await pending;
    assert.equal(s.input.value, '설명해 줘'); assert.equal(s.context.chat.length, 0);
    pending = s.sendOocMessage(); s.reply('Explain.'); await pending; assert.equal(s.context.chat.length, 1);
});

test('chat away/back and input edit/undo reject late translation', async () => {
    for (const action of ['chat', 'edit']) {
        const s = setup(); const pending = s.sendOocMessage();
        if (action === 'chat') { await s.changeChat('second', false); await s.changeChat('first', false); }
        else { s.edit('수정'); s.edit('설명해 줘'); }
        s.reply('Explain.'); await pending;
        assert.equal(s.context.chat.length, 0); assert.equal(s.prompts.length, 0); assert.equal(s.input.value, '설명해 줘');
    }
});

test('a generation starting during translation cannot receive the OOC message', async () => {
    const s = setup(); const pending = s.sendOocMessage(); s.sandbox.is_send_press = true; s.reply('Explain.'); await pending;
    assert.equal(s.context.chat.length, 0); assert.equal(s.input.value, '설명해 줘');
});

test('save failure rolls back only new message, keeps input, and restores UI/exclusions', async () => {
    const s = setup({ text: 'Explain.' }); s.context.chat.push({ mes: 'previous', is_user: false }); s.failSave(true);
    await s.sendOocMessage(); assert.equal(s.context.chat.length, 1); assert.equal(s.input.value, 'Explain.');
    assert.equal(s.rendered.length, 0); assert.equal(s.prompts.length, 0); assert.equal(s.input.disabled, false); assert.equal(s.entries.a.enabled, true);
});

test('chat switch during save cannot render, clear another input, or trigger generation', async () => {
    const s = setup({ text: 'Explain.' }); s.onSave(async () => { await s.changeChat(); s.input.value = 'new draft'; });
    await s.sendOocMessage(); assert.equal(s.rendered.length, 0); assert.equal(s.prompts.length, 0); assert.equal(s.input.value, 'new draft');
});

test('persona injection modifies only model copy; every save stays clean; exclusion states restore after failure', async () => {
    const s = setup({ text: 'Explain.', storage: new Map([[LEGACY, 'Be precise.']]) });
    s.onGenerate(() => { assert.equal(s.entries.a.enabled, false); assert.equal(s.entries.b.enabled, false); });
    await s.sendOocMessage();
    assert.equal(s.prompts[0][0].mes, s.buildOocGenerationText('Explain.', 'Answer in English.', 'Be precise.'));
    assert.ok(s.saves.every(chat => !chat[0].mes.includes('OOC_INSTRUCTION')));
    assert.equal(s.entries.a.enabled, true); assert.equal(s.entries.b.enabled, false);
    s.input.value = 'Next.'; s.onGenerate(() => { throw Error('model failed'); }); await s.sendOocMessage();
    assert.equal(s.entries.a.enabled, true); assert.ok(!s.context.chat[1].mes.includes('OOC_INSTRUCTION')); assert.equal(s.input.disabled, false);
});

test('delayed trigger after chat switch aborts instead of generating in another chat', async () => {
    const s = setup({ text: 'Explain.' }); let resume;
    s.onGenerate(() => new Promise(resolve => { resume = resolve; }));
    const pending = s.sendOocMessage(); await flush();
    await s.changeChat(); assert.equal(s.entries.a.enabled, true);
    s.context.chat.push({ is_user: true, mes: 'Another chat' }); resume(); await pending;
    assert.equal(s.prompts.length, 0); assert.equal(s.saves.length, 1);
});

test('deleted/edited target and unrelated generations cannot receive persona', async () => {
    for (const action of ['delete', 'edit']) {
        const s = setup({ text: 'Explain.', storage: new Map([[LEGACY, 'Persona']]) });
        s.onGenerate(() => { if (action === 'delete') s.context.chat.length = 0; else s.context.chat[0].mes = 'Edited'; });
        await s.sendOocMessage(); assert.equal(s.prompts.length, 0);
    }
    const s = setup(); const unrelated = [{ index: 0, mes: 'Regular chat', is_user: true }];
    s.sandbox.oocChatGenerationInterceptor(unrelated, 4096, () => assert.fail('must not abort'));
    assert.equal(unrelated[0].mes, 'Regular chat');
});

test('legacy prompt migrates byte-for-byte; reload, selection, edit, rename, delete and no resurrection', () => {
    const legacy = '  Legacy\n프롬프트\n '; const storage = new Map([[LEGACY, legacy]]); const s = setup({ storage });
    assert.equal(s.getPersonaPrompt(), legacy); assert.equal(storage.get(LEGACY), legacy);
    const id = s.savePersonaPrompt('', 'Second', 'Second prompt'); assert.equal(s.getPersonaPrompt(), 'Second prompt');
    s.savePersonaPrompt(id, 'Renamed', 'Updated'); assert.equal(setup({ storage }).getPersonaPrompt(), 'Updated');
    s.selectPersonaPrompt('legacy'); assert.equal(s.getPersonaPrompt(), legacy);
    s.selectPersonaPrompt(''); assert.equal(s.getPersonaPrompt(), '');
    s.deletePersonaPrompt(id); s.deletePersonaPrompt('legacy'); assert.equal(setup({ storage }).getPersonaStore().items.length, 0);
    assert.equal(storage.get(LEGACY), legacy); assert.equal(setup({ storage }).getPersonaPrompt(), '');
});

test('blank and duplicate names, storage failures and malformed/future data never overwrite valid data', () => {
    const s = setup(); const id = s.savePersonaPrompt('', 'Name', 'Prompt'); const before = s.storage.get(PRESETS);
    assert.throws(() => s.savePersonaPrompt('', 'Name', 'Bad')); assert.throws(() => s.savePersonaPrompt('', ' ', 'Bad'));
    assert.equal(s.storage.get(PRESETS), before); s.failStorage(true);
    assert.throws(() => s.savePersonaPrompt(id, 'Name', 'Bad')); assert.throws(() => s.deletePersonaPrompt(id)); assert.equal(s.storage.get(PRESETS), before);
    for (const raw of ['{', '{"version":2,"items":[],"selectedId":""}', '{"version":1,"items":[],"selectedId":"missing"}']) {
        const corrupt = setup({ storage: new Map([[PRESETS, raw], [LEGACY, 'Legacy']]) });
        assert.throws(() => corrupt.getPersonaPrompt()); assert.equal(corrupt.storage.get(PRESETS), raw);
    }
    const legacy = setup({ storage: new Map([[LEGACY, 'Original']]) }); legacy.failStorage(true); assert.throws(() => legacy.getPersonaStore()); assert.equal(legacy.storage.get(LEGACY), 'Original');
});

test('empty saved prompt suppresses injection and editing old OOC messages keeps legacy display behavior', async () => {
    const s = setup({ text: 'Explain.' }); s.savePersonaPrompt('', 'Empty', ''); await s.sendOocMessage();
    assert.equal(s.prompts[0][0].mes, s.context.chat[0].mes);
    s.context.chat[0].mes = '(OOC: Answer in English. Edited.)'; assert.equal(s.getOocDisplayText(s.context.chat[0]), 'Edited.');
});

test('group member changes during generation keep persona bound to the same group chat', async () => {
    const s = setup({ text: 'Explain.', storage: new Map([[LEGACY, 'Persona']]) });
    s.context.groupId='group';s.context.characterId=null;
    s.onGenerate(()=>{s.context.characterId=2;});await s.sendOocMessage();
    assert.equal(s.prompts.length,1);assert.ok(s.prompts[0][0].mes.includes('Persona'));
});

test('partial exclusion failure restores previously changed entries', async () => {
    const s=setup({text:'Explain.'});
    s.sandbox.promptManager.getPromptOrderEntry=(_,id)=>{if(id==='b')throw Error('Prompt manager failed');return s.entries[id];};
    await s.sendOocMessage();assert.equal(s.entries.a.enabled,true);assert.equal(s.prompts.length,0);assert.equal(s.input.disabled,false);
});

test('prompt creation also works without secure-context randomUUID', () => {
    const s=setup();delete s.sandbox.crypto.randomUUID;
    const id=s.savePersonaPrompt('','HTTP prompt','Persona');assert.ok(id);assert.equal(s.getPersonaPrompt(),'Persona');
});

test('chat switch during an active OOC generation requests host cancellation', async () => {
    const s=setup({text:'Explain.'});let resume,stopped=0;
    s.context.stopGeneration=()=>{stopped+=1;};
    s.onGenerate(()=>new Promise(resolve=>{resume=resolve;}));
    const pending=s.sendOocMessage();await flush();s.sandbox.is_send_press=true;
    await s.changeChat();assert.equal(stopped,1);resume();await pending;assert.equal(s.prompts.length,0);
});

test('system messages excluded by the host cannot shift the OOC target out of the model request', async () => {
    const s=setup({text:'Explain.',storage:new Map([[LEGACY,'Persona']])});
    s.context.chat.push({is_system:true,is_user:false,mes:'System notice'},{is_system:false,is_user:false,mes:'Greeting'});
    await s.sendOocMessage();
    assert.equal(s.prompts.length,1,JSON.stringify(s.toasts));
    assert.equal(s.prompts[0][1].mes,s.buildOocGenerationText('Explain.','Answer in English.','Persona'));
    assert.equal(s.context.chat[2].mes,'(OOC: Answer in English. Explain.)');
});

test('request identity survives deep copies and absent model indexes without applying to an old OOC', async () => {
    const s=setup({text:'Repeat.',storage:new Map([[LEGACY,'Current persona']])});
    s.context.chat.push({is_system:true,mes:'Notice'},{is_user:true,mes:'(OOC: Repeat.)',extra:{ooc_chat:true}});
    s.onModelCopy(copy=>JSON.parse(JSON.stringify(copy)).map(({index,...message})=>message));
    await s.sendOocMessage();assert.equal(s.prompts.length,1);assert.equal(s.prompts[0][0].mes,'(OOC: Repeat.)');
    assert.ok(s.prompts[0][1].mes.includes('Current persona'));
    const firstId=s.context.chat.at(-1).extra.ooc_request_id;s.input.value='Repeat.';await s.sendOocMessage();
    assert.notEqual(s.context.chat.at(-1).extra.ooc_request_id,firstId);
    assert.ok(!s.prompts[1][1].mes.includes('OOC_INSTRUCTION'));assert.ok(s.prompts[1][2].mes.includes('Current persona'));
});

test('missing request identity in the model copy fails safely instead of using another OOC', async () => {
    const s=setup({text:'Explain.'});s.onModelCopy(copy=>copy.map(message=>({...message,extra:{ooc_chat:true}})));
    await s.sendOocMessage();assert.equal(s.prompts.length,0);assert.equal(s.context.chat[0].mes,'(OOC: Answer in English. Explain.)');
    assert.equal(s.entries.a.enabled,true);assert.equal(s.input.disabled,false);
});

test('missing integration setting defaults to original Korean sending without a translation extension', async () => {
    const s=setup({translator:false,translationEnabled:null,storage:new Map([[LEGACY,'Persona']])});
    assert.equal(s.settings.translateInput,false);await s.sendOocMessage();
    assert.equal(s.getOocDisplayText(s.context.chat[0]),'설명해 줘');assert.equal(s.prompts.length,1);
    assert.equal(s.prompts[0][0].mes,s.buildOocGenerationText('설명해 줘','Answer in English.','Persona'));
    assert.equal(s.entries.a.enabled,true);assert.equal(s.input.value,'');
});

test('integration OFF sends original even if a translation extension is installed', async () => {
    const s=setup({translationEnabled:false});await s.sendOocMessage();
    assert.equal(s.requests.length,0);assert.equal(s.getOocDisplayText(s.context.chat[0]),'설명해 줘');
    assert.equal(s.prompts[0][0].mes,s.context.chat[0].mes);
});

test('switching integration OFF then ON cancels a pending translation; a deliberate OFF retry sends original once', async () => {
    const s=setup();const pending=s.sendOocMessage();s.setTranslationEnabled(false);
    assert.equal(s.requests[0].options.signal.aborted,true);s.setTranslationEnabled(true);s.reply('Late translation');await pending;
    assert.equal(s.context.chat.length,0);assert.equal(s.input.value,'설명해 줘');assert.equal(s.input.disabled,false);
    s.setTranslationEnabled(false);await s.sendOocMessage();assert.equal(s.context.chat.length,1);assert.equal(s.getOocDisplayText(s.context.chat[0]),'설명해 줘');
    assert.equal(s.requests.length,1);
});

test('integration changes after sending affect the next request without aborting current model generation', async () => {
    const s=setup();s.onGenerate(()=>s.setTranslationEnabled(false));const pending=s.sendOocMessage();s.reply('Explain.');await pending;
    assert.equal(s.prompts.length,1);assert.equal(s.requests[0].options.signal.aborted,false);
    s.input.value='다음 질문';await s.sendOocMessage();assert.equal(s.requests.length,1);assert.equal(s.prompts.length,2);
    assert.equal(s.getOocDisplayText(s.context.chat[1]),'다음 질문');
});

test('integration choice restores from settings and invalid legacy values default OFF', () => {
    const s=setup({translationEnabled:null});s.setTranslationEnabled(true);
    const restored=setup({savedSettings:JSON.parse(JSON.stringify(s.settings))});assert.equal(restored.settings.translateInput,true);
    restored.setTranslationEnabled(false);assert.equal(setup({savedSettings:JSON.parse(JSON.stringify(restored.settings))}).settings.translateInput,false);
    assert.equal(setup({translationEnabled:'true'}).settings.translateInput,false);
});
