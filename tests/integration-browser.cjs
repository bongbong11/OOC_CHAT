const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const oocRoot = path.resolve(__dirname, '..');
const translatorRoot = path.resolve(process.argv[2] || path.join(oocRoot, '../in_tr'));
const screenshotDir = process.env.SCREENSHOT_DIR;
const modules = {
    '/script.js': `export const getCurrentChatId=()=>harness.chatId;export let is_send_press=false;export const saveSettingsDebounced=()=>harness.persistSettings();export const substituteParams=t=>t;export const sendTextareaMessage=async()=>{harness.normalSends.push(document.querySelector('#send_textarea').value);document.querySelector('#send_textarea').value='';};`,
    '/scripts/extensions.js': `export const extension_settings=harness.ctx.extensionSettings;export const getContext=()=>harness.ctx;`,
    '/scripts/openai.js': `export const oai_settings={preset_settings_openai:'Default'};export const promptManager={activeCharacter:0,getPromptOrderEntry:(_,id)=>harness.entries[id],getPromptOrderForCharacter:()=>[{identifier:'a',enabled:true},{identifier:'b',enabled:false}],getPromptById:id=>({name:id,role:'system'})};`,
    '/scripts/RossAscends-mods.js': `export const shouldSendOnEnter=()=>true;`,
    '/scripts/extensions/shared.js': `export const ConnectionManagerRequestService={getSupportedProfiles:()=>[{id:'profile',name:'Test profile',api:'openai',model:'Test model'}],sendRequest:(...args)=>new Promise((resolve,reject)=>harness.requests.push({args,resolve,reject}))};`,
};
const html = `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:#20232a;color:white;font:16px sans-serif;--SmartThemeBodyColor:white;--SmartThemeEmColor:#bbb;--SmartThemeBlurTintColor:#20232a;--SmartThemeBorderColor:#555;--mainFontSize:16px;--mainFontFamily:sans-serif}main{width:100%;max-width:900px;margin:auto;padding:4px}#chat{height:120px;overflow:auto}#send_form{display:flex}#send_textarea{min-width:0;flex:1}.text_pole{color:white;background:#303640;border:1px solid #666;border-radius:5px;padding:5px}.menu_button{color:white;background:#383e46;border:1px solid #666;padding:5px;border-radius:5px;cursor:pointer}.inline-drawer-content{display:none}#extensions_settings2{max-width:100%;overflow:hidden}
</style><link rel="stylesheet" href="/scripts/extensions/third-party/OOC_CHAT/style.css"><link rel="stylesheet" href="/scripts/extensions/third-party/in_tr/style.css">
<main><div id="chat"></div><form id="send_form" onsubmit="return false"><textarea id="send_textarea"></textarea><div id="rightSendForm"><button id="send_but" type="button">Send</button></div></form><div id="extensionsMenu"></div><div id="extensions_settings2"></div></main>
<script>
window.harness={chatId:'one',requests:[],normalSends:[],saves:[],prompts:[],toasts:[],entries:{a:{enabled:true},b:{enabled:false}}};
const listeners={};
harness.ctx={chat:[],characterId:0,groupId:null,name1:'Test',CONNECT_API_MAP:{openai:{selected:'openai'}},extensionSettings:{inputTranslator:{profileId:'profile',contextTurns:0,maxTranslationTokens:6144,autoTranslateOnSend:true},OOC_CHAT:{instruction:'Answer in English.',promptExclusions:{Default:['a']}}},accountStorage:localStorage,saveSettingsDebounced(){},eventTypes:{CHAT_CHANGED:'changed',MESSAGE_SENT:'sent',USER_MESSAGE_RENDERED:'rendered'},eventSource:{on:(type,fn)=>(listeners[type]??=[]).push(fn),emit:async(type,id)=>{for(const fn of listeners[type]??[])await fn(id);}},saveChat:async()=>{harness.saves.push(JSON.parse(JSON.stringify(harness.ctx.chat)));localStorage.setItem('test-chat',JSON.stringify(harness.ctx.chat));},addOneMessage:message=>{const id=harness.ctx.chat.indexOf(message);const node=document.createElement('div');node.className='mes';node.setAttribute('mesid',id);const text=document.createElement('div');text.className='mes_text';text.textContent=message.mes;node.append(text);document.querySelector('#chat').append(node);},executeSlashCommandsWithOptions:async()=>{const copy=harness.ctx.chat.filter(m=>!m.is_system).map((m,index)=>({...m,index}));let abort=false;window.oocChatGenerationInterceptor(copy,4096,()=>{abort=true;});if(!abort){harness.prompts.push(copy);await harness.ctx.saveChat();}},scrollChatToBottom(){}};
window.SillyTavern={getContext:()=>harness.ctx};window.toastr={error:m=>harness.toasts.push(m),warning:m=>harness.toasts.push(m),success(){},info(){}};
const savedSettings=JSON.parse(localStorage.getItem('test-settings')||'null');if(savedSettings)harness.ctx.extensionSettings=savedSettings;
harness.persistSettings=()=>localStorage.setItem('test-settings',JSON.stringify(harness.ctx.extensionSettings));
if(!localStorage.getItem('seeded')){localStorage.setItem('OOC_CHAT_PERSONA_PROMPT','Legacy persona.');localStorage.setItem('seeded','1');}
</script><script type="module">await import('/scripts/extensions/third-party/OOC_CHAT/index.js');await import('/scripts/extensions/third-party/in_tr/entry.js');window.ready=true;</script>`;

(async () => {
    new (require('node:vm').Script)(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost').pathname;
        if (url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
        if (modules[url]) { res.setHeader('Content-Type', 'text/javascript'); res.end(modules[url]); return; }
        const match = url.match(/^\/scripts\/extensions\/third-party\/(in_tr|OOC_CHAT)\/([a-z.]+)$/);
        if (match) { res.setHeader('Content-Type', match[2].endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(fs.readFileSync(path.join(match[1] === 'OOC_CHAT' ? oocRoot : translatorRoot, match[2]))); return; }
        res.statusCode = 404; res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        const errors = []; page.on('pageerror', e => { errors.push(e.message); console.error('PAGE:', e.message); });
        async function integrationChecked(value){await page.evaluate(()=>document.querySelector('#ooc-chat-settings .inline-drawer-content').style.display='block');await page.locator('#ooc-chat-translate-input').setChecked(value);}
        await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.ready);
        assert.equal(await page.locator('#ooc-chat-translate-input').isChecked(),false);
        await page.locator('#ooc-chat-label').click(); await page.locator('[data-ooc-tab="persona"]').click();
        assert.equal(await page.locator('#ooc-chat-persona-input').inputValue(), 'Legacy persona.');
        await page.getByRole('button', { name: '추가', exact: true }).click();
        await page.locator('#ooc-chat-persona-name').fill('새 이름'); await page.locator('#ooc-chat-persona-input').fill('Be concise.');
        await page.locator('.ooc-chat-persona-actions').getByRole('button', { name: '저장', exact: true }).click();
        const selected = await page.locator('#ooc-chat-persona-select').inputValue();
        await page.reload(); await page.waitForFunction(() => window.ready);
        await page.locator('#ooc-chat-label').click(); await page.locator('[data-ooc-tab="persona"]').click();
        assert.equal(await page.locator('#ooc-chat-persona-select').inputValue(), selected); assert.equal(await page.locator('#ooc-chat-persona-input').inputValue(), 'Be concise.');
        await page.locator('#ooc-chat-persona-name').fill('Edited name'); await page.locator('#ooc-chat-persona-input').fill('Edited persona.');
        await page.locator('.ooc-chat-persona-actions').getByRole('button', { name: '저장', exact: true }).click();
        await page.locator('#ooc-chat-persona-select').selectOption('legacy');
        assert.equal(await page.locator('#ooc-chat-persona-input').inputValue(), 'Legacy persona.');
        await page.locator('#ooc-chat-persona-select').selectOption(selected);
        // Long content and names must not hide controls at mobile/desktop widths.
        await page.locator('#ooc-chat-persona-name').fill('매우 긴 이름 '.repeat(25));
        await page.locator('.ooc-chat-persona-actions').getByRole('button', { name: '저장', exact: true }).click();
        for (const width of [320, 390, 768, 1280]) {
            await page.setViewportSize({ width, height: 800 });
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const layout = await page.evaluate(() => {
                const popover = document.querySelector('#ooc-chat-prompt-popover');
                const rect = popover.getBoundingClientRect();
                return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, left: rect.left, right: rect.right };
            });
            assert.ok(layout.documentWidth <= width, JSON.stringify(layout)); assert.ok(layout.left >= 0 && layout.right <= width, JSON.stringify(layout));
            for (const text of ['추가', '저장', '삭제']) assert.ok(await page.locator('.ooc-chat-persona-actions').getByRole('button', { name: text, exact: true }).isVisible());
            if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, `qa-ooc-${width}.png`) });
        }
        await page.locator('#ooc-chat-popover-close').click();
        await page.evaluate(()=>{harness.savedTranslator=window.inputTranslator;delete window.inputTranslator;});
        await page.locator('#ooc-chat-input').fill('번역 없이 전송');await page.locator('#ooc-chat-send').click();
        await page.waitForFunction(()=>harness.prompts.length===1&&!document.querySelector('#ooc-chat-input').disabled);
        assert.equal(await page.locator('#chat .mes_text').textContent(),'번역 없이 전송');
        assert.equal(await page.evaluate(()=>harness.requests.length),0);
        await page.evaluate(()=>{window.inputTranslator=harness.savedTranslator;});
        await integrationChecked(true);await page.reload();await page.waitForFunction(()=>window.ready);
        assert.equal(await page.locator('#ooc-chat-translate-input').isChecked(),true);
        await page.evaluate(()=>harness.ctx.chat.push({is_system:true,is_user:false,mes:'Synthetic system notice'}));
        await page.locator('#send_textarea').fill('일반 채팅 초안'); await page.locator('#ooc-chat-input').fill('설명해 줘');
        await page.locator('#ooc-chat-send').click(); await page.waitForFunction(() => harness.requests.length === 1);
        assert.equal(await page.locator('#send_textarea').inputValue(), '일반 채팅 초안');
        await page.evaluate(() => { const r=harness.requests[0]; if(r.args[2]!==6144)throw Error('token setting bypassed');if(!r.args[1].includes('Render Korean idioms'))throw Error('loader bypassed');if(r.args[3].includePreset!==false)throw Error('preset inherited');r.resolve({content:'Please explain.'}); });
        await page.waitForFunction(() => harness.prompts.length === 1 && !document.querySelector('#ooc-chat-input').disabled);
        const result = await page.evaluate(() => ({ display: document.querySelector('#chat .mes_text').textContent, saves: harness.saves, prompt: harness.prompts[0], normal: harness.normalSends.length, excluded: harness.entries.a.enabled }));
        assert.equal(result.display, 'Please explain.'); assert.equal(result.normal, 0); assert.equal(result.excluded, true);
        assert.ok(result.saves.every(chat => chat.find(message=>message.extra?.ooc_chat)?.mes === '(OOC: Answer in English. Please explain.)'));
        assert.ok(result.prompt[0].mes.includes('Edited persona.')); assert.ok(result.prompt[0].mes.includes('Please explain.'));
        // Direct English, failure/retry, and a late provider on a chat switch.
        await page.locator('#ooc-chat-input').fill('Direct English.'); await page.locator('#ooc-chat-send').click(); await page.waitForFunction(() => harness.prompts.length === 2);
        assert.equal(await page.evaluate(() => harness.requests.length), 1);
        await page.locator('#ooc-chat-input').fill('실패 테스트'); await page.locator('#ooc-chat-send').click(); await page.waitForFunction(() => harness.requests.length === 2);
        await page.evaluate(() => harness.requests[1].reject(Error('API failure'))); await page.waitForFunction(() => !document.querySelector('#ooc-chat-input').disabled);
        assert.equal(await page.locator('#ooc-chat-input').inputValue(), '실패 테스트'); assert.equal(await page.evaluate(() => harness.prompts.length), 2);
        await page.locator('#ooc-chat-send').click(); await page.waitForFunction(() => harness.requests.length === 3);
        await page.evaluate(async () => { harness.chatId='two';harness.ctx.chat.length=0;await harness.ctx.eventSource.emit('changed');document.querySelector('#ooc-chat-input').value='New draft';harness.requests[2].resolve({content:'Late result'}); });
        await page.waitForFunction(() => !document.querySelector('#ooc-chat-input').disabled);
        assert.equal(await page.locator('#ooc-chat-input').inputValue(), 'New draft'); assert.equal(await page.evaluate(() => harness.ctx.chat.length), 0);
        await page.locator('#ooc-chat-input').fill('번역 중 설정 변경');await page.locator('#ooc-chat-send').click();await page.waitForFunction(()=>harness.requests.length===4);
        await integrationChecked(false);await integrationChecked(true);await page.evaluate(()=>harness.requests[3].resolve({content:'Late after setting change'}));
        await page.waitForFunction(()=>!document.querySelector('#ooc-chat-input').disabled);
        assert.equal(await page.locator('#ooc-chat-input').inputValue(),'번역 중 설정 변경');assert.equal(await page.evaluate(()=>harness.ctx.chat.length),0);
        await integrationChecked(false);await page.reload();await page.waitForFunction(()=>window.ready);
        assert.equal(await page.locator('#ooc-chat-translate-input').isChecked(),false);
        // Delete all presets and verify retained legacy key cannot resurrect them.
        await page.locator('#ooc-chat-label').click(); await page.locator('[data-ooc-tab="persona"]').click();
        await page.locator('.ooc-chat-persona-actions').getByRole('button', { name: '삭제', exact: true }).click();
        await page.locator('#ooc-chat-persona-select').selectOption('legacy'); await page.locator('.ooc-chat-persona-actions').getByRole('button', { name: '삭제', exact: true }).click();
        await page.reload(); await page.waitForFunction(() => window.ready); await page.locator('#ooc-chat-label').click(); await page.locator('[data-ooc-tab="persona"]').click();
        assert.equal(await page.locator('#ooc-chat-persona-select option').count(), 2);
        assert.equal(await page.evaluate(() => localStorage.getItem('OOC_CHAT_PERSONA_PROMPT')), 'Legacy persona.');
        await page.locator('#ooc-chat-popover-close').click();
        await page.locator('#ooc-chat-input').fill('Keyboard input');
        await page.locator('#ooc-chat-input').press('Shift+Enter');
        assert.equal(await page.locator('#ooc-chat-input').inputValue(), 'Keyboard input\n');
        await page.evaluate(() => { const input=document.querySelector('#ooc-chat-input');input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',repeat:true,bubbles:true})); });
        assert.equal(await page.evaluate(() => harness.prompts.length), 0);
        await page.locator('#ooc-chat-input').press('Enter');await page.waitForFunction(() => harness.prompts.length===1);
        await page.locator('#send_textarea').fill('일반 채팅');await page.locator('#send_but').click();await page.waitForFunction(() => harness.requests.length===1);
        await page.evaluate(()=>harness.requests[0].resolve({content:'Regular chat.'}));await page.waitForFunction(()=>harness.normalSends.length===1);
        assert.equal(await page.evaluate(()=>harness.normalSends[0]),'Regular chat.');
        assert.deepEqual(errors, []);
        console.log('PASS: real Chrome UI at 320/390/768/1280; persona migration/CRUD/reload; actual entry/guard/loader translation chain; English bypass, provider failure, stale response; no page errors.');
    } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
