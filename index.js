// OOC Chat v1.6.2
import { extension_settings, getContext } from '../../../extensions.js';
import { oai_settings, promptManager } from '../../../openai.js';
import { saveSettingsDebounced, getCurrentChatId, is_send_press } from '../../../../script.js';

const EXT_NAME='OOC_CHAT';
const CONTAINER_ID='ooc-chat-container',ROW_ID='ooc-chat-row',LABEL_ID='ooc-chat-label',INPUT_ID='ooc-chat-input',SEND_ID='ooc-chat-send',COLLAPSE_ID='ooc-chat-collapse',SETTINGS_ID='ooc-chat-settings',POPOVER_ID='ooc-chat-prompt-popover',CLEAR_ID='ooc-chat-prompt-clear';
const PERSONA_STORAGE_KEY='OOC_CHAT_PERSONA_PROMPT';
const PERSONA_PRESETS_KEY='OOC_CHAT_PERSONA_PRESETS';
const KOREAN_INPUT_RE=/[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF\uD7B0-\uD7FF]/;
let chatRevision=0,inputRevision=0,activeSend=null;
const defaultSettings={instruction:'Answer in English.',messageColor:'#8fd3ff',showInput:true,translateInput:false,promptExclusions:{}};
let settings={},sending=false,eventsBound=false,documentHandlersBound=false,initialized=false,barCollapsed=false,activePopoverTab='exclusions';

function loadSettings(){
    if(!extension_settings[EXT_NAME]) extension_settings[EXT_NAME]={...defaultSettings};
    settings=extension_settings[EXT_NAME];
    if(typeof settings.instruction!=='string') settings.instruction=defaultSettings.instruction;
    if(typeof settings.messageColor!=='string'||!settings.messageColor) settings.messageColor=defaultSettings.messageColor;
    if(typeof settings.showInput!=='boolean') settings.showInput=defaultSettings.showInput;
    if(typeof settings.translateInput!=='boolean') settings.translateInput=defaultSettings.translateInput;
    if(!settings.promptExclusions||typeof settings.promptExclusions!=='object'||Array.isArray(settings.promptExclusions)) settings.promptExclusions={};
    applyMessageColor();
}
function saveSettings(){extension_settings[EXT_NAME]=settings;saveSettingsDebounced();}
function setTranslationEnabled(value){settings.translateInput=value===true;if(!settings.translateInput&&activeSend?.translating)activeSend.controller.abort();saveSettings();}
function applyMessageColor(){document.documentElement.style.setProperty('--ooc-chat-message-color',settings.messageColor||defaultSettings.messageColor);}
function applyBarVisibility(){const bar=document.getElementById(CONTAINER_ID);if(!bar)return;bar.hidden=!settings.showInput;if(!settings.showInput)closePromptPopover();}
function setBarCollapsed(v){barCollapsed=Boolean(v);const bar=document.getElementById(CONTAINER_ID),b=document.getElementById(COLLAPSE_ID);if(!bar||!b)return;bar.classList.toggle('ooc-chat-collapsed',barCollapsed);b.setAttribute('aria-expanded',String(!barCollapsed));b.title=barCollapsed?'OOC 입력창 펼치기':'OOC 입력창 접기';const i=b.querySelector('i');if(i)i.className=barCollapsed?'fa-solid fa-chevron-up':'fa-solid fa-chevron-down';if(barCollapsed)closePromptPopover();}
function toast(message,type='info'){const t=window.toastr;if(t&&typeof t[type]==='function')t[type](message,'OOC Chat');else console[type==='error'?'error':'log'](`[OOC Chat] ${message}`);}
function resizeInput(input){if(!input)return;input.style.height='auto';input.style.height=`${Math.min(input.scrollHeight,96)}px`;}
function setSendingState(v){sending=v;const i=document.getElementById(INPUT_ID),b=document.getElementById(SEND_ID);if(i)i.disabled=v;if(b){b.disabled=v;b.classList.toggle('ooc-chat-sending',v);b.setAttribute('aria-busy',String(v));}}
async function emitIfAvailable(c,n,id){const t=c?.eventTypes?.[n];if(t&&c?.eventSource?.emit)await c.eventSource.emit(t,id);}
function getInstruction(){return String(settings.instruction??'').trim();}
function normalizeOocInput(text){const trimmed=String(text??'').trim();const match=trimmed.match(/^\(\s*ooc\s*:\s*([\s\S]*?)\s*\)$/i);return match?match[1].trim():trimmed;}
function newOocId(){return globalThis.crypto?.randomUUID?.()??('ooc-'+Date.now()+'-'+Math.random().toString(36).slice(2));}
function buildOocMessageText(text,instruction=getInstruction()){const inner=instruction?`${instruction} ${text}`:text;return `(OOC: ${inner})`;}
function buildOocGenerationText(text,instruction,persona){const p=String(persona??'').trim();if(!p)return buildOocMessageText(text,instruction);const request=instruction?`${instruction} ${text}`:text;return `(OOC:\n<OOC_INSTRUCTION>\n${p}\n</OOC_INSTRUCTION>\n\n<OOC_REQUEST>\n${request}\n</OOC_REQUEST>\n)`;}
function getOocDisplayText(m){if(!m?.extra?.ooc_chat)return null;if(typeof m.extra.ooc_display_text==='string')return m.extra.ooc_display_text;const raw=String(m.mes??''),match=raw.match(/^\(ooc:\s*([\s\S]*?)\)$/i);if(!match)return raw;let inner=match[1].trim();const candidates=[typeof m.extra.ooc_instruction==='string'?m.extra.ooc_instruction.trim():'',getInstruction(),defaultSettings.instruction].filter(Boolean);for(const p of candidates){if(inner.toLowerCase().startsWith(p.toLowerCase())){inner=inner.slice(p.length).trimStart();break;}}return inner;}
function decorateOocMessage(messageId){const id=Number(messageId);if(!Number.isInteger(id))return;const c=getContext(),m=c?.chat?.[id];if(!m?.extra?.ooc_chat)return;const el=document.querySelector(`#chat .mes[mesid="${id}"]`),text=el?.querySelector('.mes_text');if(!el||!text)return;const display=getOocDisplayText(m);if(display===null)return;el.classList.add('ooc-chat-message');el.dataset.oocChat='true';if(text.textContent!==display)text.textContent=display;}
function decorateVisibleOocMessages(){const c=getContext();if(!c||!Array.isArray(c.chat))return;document.querySelectorAll('#chat .mes[mesid]').forEach(el=>{const id=Number(el.getAttribute('mesid'));if(Number.isInteger(id)&&c.chat[id]?.extra?.ooc_chat)decorateOocMessage(id);});}
function scheduleVisibleDecoration(){requestAnimationFrame(decorateVisibleOocMessages);setTimeout(decorateVisibleOocMessages,100);}

function getCurrentPresetName(){return String(oai_settings?.preset_settings_openai||'Default');}
function getPresetStorageKey(name=getCurrentPresetName()){return encodeURIComponent(String(name));}
function getExcludedPromptIds(name=getCurrentPresetName()){const v=settings.promptExclusions?.[getPresetStorageKey(name)];return Array.isArray(v)?v.filter(x=>typeof x==='string'):[];}
function setPromptExcluded(name,id,excluded){const key=getPresetStorageKey(name),s=new Set(getExcludedPromptIds(name));excluded?s.add(id):s.delete(id);if(s.size)settings.promptExclusions[key]=[...s];else delete settings.promptExclusions[key];saveSettings();}
function clearPromptExclusions(name=getCurrentPresetName()){delete settings.promptExclusions[getPresetStorageKey(name)];saveSettings();renderPromptPopover();requestAnimationFrame(positionPromptPopover);}
function getCurrentPresetPromptEntries(){if(!promptManager||typeof promptManager.getPromptOrderForCharacter!=='function'||typeof promptManager.getPromptById!=='function')return null;try{const order=promptManager.getPromptOrderForCharacter(promptManager.activeCharacter);if(!Array.isArray(order))return[];return order.flatMap((entry,index)=>{if(!entry?.identifier)return[];const p=promptManager.getPromptById(entry.identifier);if(!p||p.marker||p.extension)return[];return[{identifier:String(entry.identifier),name:String(p.name||entry.identifier),role:String(p.role||''),enabled:entry.enabled!==false,index}];});}catch{return null;}}
function getPersonaStorage(){const storage=getContext()?.accountStorage;if(!storage)throw new Error('AccountStorage를 사용할 수 없어.');return storage;}
function writePersonaStore(store){getPersonaStorage().setItem(PERSONA_PRESETS_KEY,JSON.stringify(store));}
function getPersonaStore(){
    const storage=getPersonaStorage(),raw=storage.getItem(PERSONA_PRESETS_KEY);
    if(raw!==null&&raw!==undefined){
        let store;try{store=JSON.parse(raw);}catch{throw new Error('저장된 OOC 프롬프트 목록을 읽을 수 없어. 기존 데이터는 보존했어.');}
        const ids=new Set(),names=new Set();
        if(store?.version!==1||!Array.isArray(store.items)||typeof store.selectedId!=='string'||store.items.some(item=>{
            if(!item||typeof item.id!=='string'||!item.id||typeof item.name!=='string'||!item.name.trim()||typeof item.prompt!=='string'||ids.has(item.id)||names.has(item.name))return true;
            ids.add(item.id);names.add(item.name);return false;
        })||(store.selectedId&&!ids.has(store.selectedId)))throw new Error('OOC 프롬프트 목록 형식이 올바르지 않아. 기존 데이터는 보존했어.');
        return store;
    }
    const legacy=storage.getItem(PERSONA_STORAGE_KEY),store={version:1,selectedId:'',items:[]};
    if(typeof legacy==='string'&&legacy.length){
        store.items.push({id:'legacy',name:'기존 OOC 프롬프트',prompt:legacy});store.selectedId='legacy';
        // Keep the legacy key intact; the new key is authoritative even when empty.
        writePersonaStore(store);
    }
    return store;
}
function getPersonaPrompt(){const store=getPersonaStore();return store.items.find(item=>item.id===store.selectedId)?.prompt??'';}
function selectPersonaPrompt(id){const store=getPersonaStore();if(id&&!store.items.some(item=>item.id===id))throw new Error('선택한 프롬프트를 찾을 수 없어.');store.selectedId=id;writePersonaStore(store);}
function savePersonaPrompt(id,name,prompt){
    const store=getPersonaStore(),title=String(name??'').trim();
    if(!title)throw new Error('프롬프트 이름을 입력해 줘.');
    if(store.items.some(item=>item.name===title&&item.id!==id))throw new Error('같은 이름이 있어. 다른 이름을 입력해 줘.');
    const item=id?store.items.find(item=>item.id===id):{id:newOocId(),name:title,prompt:''};
    if(!item)throw new Error('수정할 프롬프트를 찾을 수 없어.');
    item.name=title;item.prompt=String(prompt??'');if(!id)store.items.push(item);
    store.selectedId=item.id;writePersonaStore(store);return item.id;
}
function deletePersonaPrompt(id){const store=getPersonaStore();store.items=store.items.filter(item=>item.id!==id);if(store.selectedId===id)store.selectedId='';writePersonaStore(store);}

function ensurePromptPopover(){let p=document.getElementById(POPOVER_ID);if(p)return p;p=document.createElement('div');p.id=POPOVER_ID;p.hidden=true;p.innerHTML=`
<div class="ooc-chat-popover-header"><div class="ooc-chat-popover-heading"><div class="ooc-chat-popover-title">OOC 설정</div><div id="ooc-chat-popover-preset" class="ooc-chat-popover-preset"></div></div><div class="ooc-chat-popover-actions"><button id="${CLEAR_ID}" class="menu_button ooc-chat-prompt-clear" type="button" title="현재 프리셋 체크 모두 해제">전체 해제</button><button id="ooc-chat-popover-close" class="menu_button ooc-chat-popover-close" type="button" title="닫기" aria-label="닫기"><i class="fa-solid fa-xmark"></i></button></div></div>
<div class="ooc-chat-tabs" role="tablist"><button class="ooc-chat-tab" type="button" data-ooc-tab="exclusions" role="tab">프롬프트 제외</button><button class="ooc-chat-tab" type="button" data-ooc-tab="persona" role="tab">OOC 프롬프트</button></div><div id="ooc-chat-popover-body" class="ooc-chat-popover-body"></div>`;document.body.appendChild(p);p.querySelector('#ooc-chat-popover-close')?.addEventListener('click',closePromptPopover);p.querySelector(`#${CLEAR_ID}`)?.addEventListener('click',()=>clearPromptExclusions());p.querySelectorAll('[data-ooc-tab]').forEach(b=>b.addEventListener('click',()=>{activePopoverTab=b.dataset.oocTab==='persona'?'persona':'exclusions';renderPromptPopover();requestAnimationFrame(positionPromptPopover);}));return p;}
function renderPromptPopover(){const p=ensurePromptPopover(),name=getCurrentPresetName(),preset=p.querySelector('#ooc-chat-popover-preset'),body=p.querySelector('#ooc-chat-popover-body'),clear=p.querySelector(`#${CLEAR_ID}`);if(!preset||!body)return;p.querySelectorAll('[data-ooc-tab]').forEach(b=>{const on=b.dataset.oocTab===activePopoverTab;b.classList.toggle('active',on);b.setAttribute('aria-selected',String(on));});if(activePopoverTab==='persona'){preset.textContent='모든 프리셋 공통 · AccountStorage';if(clear)clear.hidden=true;renderPersonaTab(body);}else{preset.textContent=`현재 프리셋: ${name}`;if(clear)clear.hidden=false;renderExclusionsTab(body,name,clear);}}
function renderExclusionsTab(body,name,clear){body.replaceChildren();const list=document.createElement('div');list.className='ooc-chat-prompt-list';const entries=getCurrentPresetPromptEntries(),selected=new Set(getExcludedPromptIds(name));if(clear)clear.disabled=selected.size===0;if(entries===null||entries.length===0){const m=document.createElement('div');m.className='ooc-chat-prompt-empty';m.textContent=entries===null?'Prompt Manager를 아직 읽을 수 없어. 잠시 후 다시 열어줘.':'현재 프리셋에서 선택할 수 있는 프롬프트가 없어.';list.appendChild(m);}else for(const e of entries){const label=document.createElement('label');label.className='ooc-chat-prompt-item';const cb=document.createElement('input');cb.type='checkbox';cb.checked=selected.has(e.identifier);cb.dataset.promptIdentifier=e.identifier;cb.addEventListener('change',()=>{setPromptExcluded(name,e.identifier,cb.checked);if(clear)clear.disabled=getExcludedPromptIds(name).length===0;});const text=document.createElement('span');text.className='ooc-chat-prompt-item-text';const n=document.createElement('span');n.className='ooc-chat-prompt-name';n.textContent=e.name;const meta=document.createElement('span');meta.className='ooc-chat-prompt-meta';meta.textContent=[e.role,!e.enabled?'현재 OFF':''].filter(Boolean).join(' · ');text.appendChild(n);if(meta.textContent)text.appendChild(meta);label.append(cb,text);list.appendChild(label);}const note=document.createElement('div');note.className='ooc-chat-popover-note';note.textContent='체크한 프롬프트는 이 프리셋에서 OOC로 보낼 때만 제외돼. 선택은 즉시 저장돼.';body.append(list,note);}
function renderPersonaTab(body){
    body.replaceChildren();let store;
    try{store=getPersonaStore();}catch(e){const error=document.createElement('div');error.className='ooc-chat-prompt-empty';error.textContent=e.message;body.appendChild(error);return;}
    const wrap=document.createElement('div');wrap.className='ooc-chat-persona-pane';
    const select=document.createElement('select');select.id='ooc-chat-persona-select';select.className='text_pole';select.setAttribute('aria-label','적용할 OOC 프롬프트');
    for(const item of [{id:'',name:'사용 안 함'},...store.items,{id:'__new__',name:'새 프롬프트 작성'}]){const option=document.createElement('option');option.value=item.id;option.textContent=item.name;select.appendChild(option);}
    select.value=store.selectedId;
    const name=document.createElement('input');name.id='ooc-chat-persona-name';name.className='text_pole';name.placeholder='프롬프트 이름';name.setAttribute('aria-label','OOC 프롬프트 이름');
    const ta=document.createElement('textarea');ta.id='ooc-chat-persona-input';ta.className='text_pole ooc-chat-persona-input';ta.rows=10;ta.placeholder='OOC에서만 사용할 인격/작동 프롬프트. 비워두면 추가 주입하지 않아.';
    const status=document.createElement('div');status.className='ooc-chat-persona-status';status.setAttribute('role','status');
    const actions=document.createElement('div');actions.className='ooc-chat-persona-actions';
    const add=document.createElement('button'),save=document.createElement('button'),del=document.createElement('button');
    for(const button of [add,save,del]){button.className='menu_button';button.type='button';}
    add.textContent='추가';save.textContent='저장';del.textContent='삭제';del.classList.add('ooc-chat-persona-delete');
    let editingId=store.selectedId;
    function fill(id){editingId=id;const item=store.items.find(item=>item.id===id);name.value=item?.name??'';ta.value=item?.prompt??'';del.disabled=!item;status.textContent=item?'선택한 프롬프트가 적용돼.':'새 프롬프트는 이름과 내용을 입력한 뒤 저장해 줘.';}
    function report(e){status.textContent=e.message;toast(`OOC 프롬프트 오류: ${e.message}`,'error');}
    function startNew(){select.value='__new__';fill('');name.focus();}
    select.addEventListener('change',()=>{try{if(select.value==='__new__'){startNew();return;}selectPersonaPrompt(select.value);store=getPersonaStore();fill(select.value);if(!select.value)status.textContent='추가 OOC 프롬프트를 사용하지 않아.';}catch(e){select.value=store.selectedId;report(e);}});
    add.addEventListener('click',startNew);
    save.addEventListener('click',()=>{try{savePersonaPrompt(editingId,name.value,ta.value);renderPersonaTab(body);requestAnimationFrame(positionPromptPopover);}catch(e){report(e);}});
    del.addEventListener('click',()=>{try{deletePersonaPrompt(editingId);renderPersonaTab(body);requestAnimationFrame(positionPromptPopover);}catch(e){report(e);}});
    for(const field of [name,ta])field.addEventListener('input',()=>status.textContent='저장되지 않은 변경사항이 있어.');
    fill(editingId);actions.append(add,save,del);
    const note=document.createElement('div');note.className='ooc-chat-popover-note';note.textContent='이름별로 계정에 저장돼. 목록 선택은 즉시 적용되며, 편집 내용은 저장 버튼을 눌러야 남아. 선택을 바꾸기 전에 수정 내용을 저장해 줘. 선택한 프롬프트는 최신 OOC user 입력의 <OOC_INSTRUCTION> 블록에만 임시 결합돼.';
    wrap.append(select,name,ta,status,actions,note);body.appendChild(wrap);
}
function positionPromptPopover(){const p=document.getElementById(POPOVER_ID),label=document.getElementById(LABEL_ID);if(!p||p.hidden||!label)return;const r=label.getBoundingClientRect(),m=8,g=6,w=p.offsetWidth,h=p.offsetHeight;let left=Math.max(m,Math.min(r.left,window.innerWidth-w-m)),top=r.top-h-g;if(top<m)top=r.bottom+g;top=Math.max(m,Math.min(top,window.innerHeight-h-m));p.style.left=`${Math.round(left)}px`;p.style.top=`${Math.round(top)}px`;}
function openPromptPopover(){if(barCollapsed)return;const p=ensurePromptPopover();renderPromptPopover();p.hidden=false;requestAnimationFrame(positionPromptPopover);}
function closePromptPopover(){const p=document.getElementById(POPOVER_ID);if(p)p.hidden=true;}
function togglePromptPopover(){const p=ensurePromptPopover();p.hidden?openPromptPopover():closePromptPopover();}
function applyPromptExclusionsForCurrentGeneration(){
    const ids=getExcludedPromptIds();if(!ids.length)return()=>{};
    if(!promptManager||typeof promptManager.getPromptOrderEntry!=='function')throw new Error('Prompt Manager를 사용할 수 없어 OOC 프롬프트 제외를 적용할 수 없어.');
    const states=[],restore=()=>{for(const state of states)state.entry.enabled=state.enabled;};
    try{for(const id of ids){const entry=promptManager.getPromptOrderEntry(promptManager.activeCharacter,id);if(!entry)continue;states.push({entry,enabled:entry.enabled});entry.enabled=false;}}
    catch(e){restore();throw e;}
    return restore;
}

// SillyTavern passes a separate model-context copy to this interceptor. Keep
// the existing latest-user persona format without exposing it to chat saves.
globalThis.oocChatGenerationInterceptor=function(coreChat,contextSize,abort){
    const job=activeSend;if(!job?.generating)return;
    try{
        job.assertCurrent();
        if(job.chat[job.messageId]!==job.message||job.message.mes!==job.storedText)throw new Error('OOC 메시지가 변경되어 생성을 중단했어.');
        // Model-context indexes are assigned after system-message filtering,
        // so they cannot identify a message in the saved chat array.
        const target=coreChat.find(item=>item.is_user&&item.extra?.ooc_chat&&item.extra.ooc_request_id===job.message.extra.ooc_request_id);
        if(!target)throw new Error('모델에 전달할 OOC 메시지를 찾을 수 없어.');
        if(job.persona.trim())target.mes=buildOocGenerationText(job.text,job.instruction,job.persona);
    }catch(e){abort(true);toast(`OOC 생성 오류: ${e.message}`,'error');}
};

async function sendOocMessage(){
    if(sending||is_send_press)return;const input=document.getElementById(INPUT_ID);if(!input)return;let text=normalizeOocInput(input.value);if(!text)return;
    const c=getContext();if(!c||!Array.isArray(c.chat)){toast('현재 채팅을 찾을 수 없어.','error');return;}
    const hasChar=c.characterId!==undefined&&c.characterId!==null,hasGroup=c.groupId!==undefined&&c.groupId!==null&&c.groupId!=='';if(!hasChar&&!hasGroup){toast('먼저 캐릭터나 그룹 채팅을 열어줘.','warning');return;}
    const instruction=getInstruction(),source=input.value,chat=c.chat,chatId=getCurrentChatId(),revision=chatRevision,editRevision=inputRevision,characterId=c.characterId,groupId=c.groupId;
    const job={controller:new AbortController(),cleanup:()=>{}};activeSend=job;
    setSendingState(true);closePromptPopover();let restorePromptStates=()=>{},storedText='',message=null,saved=false;
    function assertCurrent(checkInput=false){const current=getContext();if(job.controller.signal.aborted||revision!==chatRevision||chat!==current?.chat||chatId!==getCurrentChatId()||(!hasGroup&&characterId!==current?.characterId)||groupId!==current?.groupId||(checkInput&&(input!==document.getElementById(INPUT_ID)||input.value!==source||editRevision!==inputRevision)))throw new Error('입력이나 대화가 바뀌어 OOC 전송을 중단했어.');}
    job.cleanup=()=>{restorePromptStates();restorePromptStates=()=>{};};
    try{
        const persona=getPersonaPrompt();
        if(settings.translateInput&&KOREAN_INPUT_RE.test(text)){
            const translator=window.inputTranslator;
            if(translator?.version!==1||typeof translator.translate!=='function')throw new Error('번역 기능을 사용할 수 없어. 번역 확장을 확인하거나 설정에서 번역 확장 연동을 꺼 줘.');
            job.translating=true;
            try{text=await translator.translate(text,{signal:job.controller.signal});}finally{job.translating=false;}
            if(!settings.translateInput)throw new Error('번역 확장 연동이 꺼져 전송을 중단했어. 원문으로 다시 보내 줘.');
            if(typeof text!=='string'||!text.trim()||KOREAN_INPUT_RE.test(text)||text.trimStart().startsWith('/'))throw new Error('올바른 영문 번역을 받지 못했어. 원문을 유지했어.');
        }
        assertCurrent(true);if(is_send_press)throw new Error('다른 응답이 생성 중이어서 OOC 전송을 중단했어.');
        storedText=buildOocMessageText(text,instruction);
        message={name:c.name1,is_user:true,is_system:false,send_date:new Date().toISOString(),mes:storedText,extra:{ooc_chat:true,ooc_instruction:instruction,ooc_request_id:newOocId()}};
        chat.push(message);const messageId=chat.length-1;
        await c.saveChat();saved=true;assertCurrent(true);
        input.value='';resizeInput(input);c.scrollChatToBottom?.();
        await emitIfAvailable(c,'MESSAGE_SENT',messageId);assertCurrent();
        c.addOneMessage(message);await emitIfAvailable(c,'USER_MESSAGE_RENDERED',messageId);assertCurrent();decorateOocMessage(messageId);
        if(is_send_press||chat.at(-1)!==message)throw new Error('채팅이 변경되거나 다른 응답이 시작되어 OOC 생성을 중단했어.');
        restorePromptStates=applyPromptExclusionsForCurrentGeneration();
        Object.assign(job,{generating:true,chat,messageId,message,storedText,text,instruction,persona,assertCurrent});
        await c.executeSlashCommandsWithOptions('/trigger await=true',{handleParserErrors:true,handleExecutionErrors:true});
    }catch(e){
        if(message&&!saved){const index=chat.indexOf(message);if(index>=0)chat.splice(index,1);}
        toast(`OOC 전송 오류: ${e?.message||e}`,'error');
    }finally{
        job.cleanup();
        if(activeSend===job){activeSend=null;setSendingState(false);if(!barCollapsed&&settings.showInput&&revision===chatRevision)input.focus();}
    }
}

function buildBar(){const c=document.createElement('div');c.id=CONTAINER_ID;c.innerHTML=`<div id="${ROW_ID}" class="ooc-chat-row"><button id="${LABEL_ID}" class="ooc-chat-label" type="button" title="OOC 설정" aria-label="OOC 설정">OOC</button><textarea id="${INPUT_ID}" class="text_pole" rows="1" spellcheck="true" autocomplete="off" placeholder="OOC question..." aria-label="OOC message input"></textarea><button id="${SEND_ID}" class="menu_button" type="button" title="Send OOC message" aria-label="Send OOC message"><i class="fa-solid fa-paper-plane"></i></button></div><button id="${COLLAPSE_ID}" class="ooc-chat-collapse" type="button" title="OOC 입력창 접기" aria-label="OOC 입력창 접기" aria-expanded="true"><i class="fa-solid fa-chevron-down"></i></button>`;const input=c.querySelector(`#${INPUT_ID}`),send=c.querySelector(`#${SEND_ID}`),label=c.querySelector(`#${LABEL_ID}`),collapse=c.querySelector(`#${COLLAPSE_ID}`);input.addEventListener('input',()=>{inputRevision+=1;resizeInput(input);});input.addEventListener('keydown',e=>{if(e.isComposing||e.keyCode===229||e.repeat)return;if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendOocMessage();}});send.addEventListener('click',sendOocMessage);label.addEventListener('click',togglePromptPopover);collapse.addEventListener('click',()=>setBarCollapsed(!barCollapsed));return c;}
function findSettingsRoot(){return document.getElementById('extensions_settings2')||document.getElementById('extensions_settings');}
function injectSettingsPanel(){if(document.getElementById(SETTINGS_ID))return true;const root=findSettingsRoot();if(!root)return false;const p=document.createElement('div');p.id=SETTINGS_ID;p.className='extension_container';p.innerHTML=`<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>OOC Chat</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down interactable" tabindex="0"></div></div><div class="inline-drawer-content"><div class="ooc-chat-settings-content"><label class="checkbox_label" for="ooc-chat-show-input"><input id="ooc-chat-show-input" type="checkbox" /><span>OOC 입력창 보이기</span></label><label class="checkbox_label" for="ooc-chat-translate-input"><input id="ooc-chat-translate-input" type="checkbox" /><span>번역 확장 연동</span></label><small>체크하면 한글 OOC를 영어로 번역한 뒤 보내. 꺼두면 번역 확장 없이 원문을 그대로 보내.</small><label for="ooc-chat-instruction">OOC 뒤 고정 문구</label><textarea id="ooc-chat-instruction" class="text_pole" rows="2" placeholder="예: Answer in English."></textarea><small>모델에는 (OOC: [이 문구] [입력 내용]) 형태로 전달돼. 비워두면 (OOC: [입력 내용])만 전달돼.</small><label for="ooc-chat-color">OOC 메시지 글자색</label><div class="ooc-chat-color-row"><input id="ooc-chat-color" type="color" /><span id="ooc-chat-color-value"></span></div><small>입력창 왼쪽 OOC 버튼에서 프리셋별 제외 프롬프트와 공통 OOC 프롬프트를 설정할 수 있어.</small><button id="ooc-chat-settings-save" class="menu_button" type="button">저장</button></div></div></div>`;root.appendChild(p);const translate=p.querySelector('#ooc-chat-translate-input');translate.checked=settings.translateInput;translate.addEventListener('change',()=>setTranslationEnabled(translate.checked));const show=p.querySelector('#ooc-chat-show-input'),instruction=p.querySelector('#ooc-chat-instruction'),color=p.querySelector('#ooc-chat-color'),value=p.querySelector('#ooc-chat-color-value'),save=p.querySelector('#ooc-chat-settings-save');show.checked=settings.showInput;instruction.value=settings.instruction;color.value=settings.messageColor;value.textContent=settings.messageColor;show.addEventListener('change',()=>{settings.showInput=show.checked;applyBarVisibility();saveSettings();});color.addEventListener('input',()=>{value.textContent=color.value;document.documentElement.style.setProperty('--ooc-chat-message-color',color.value);});save.addEventListener('click',()=>{settings.showInput=show.checked;settings.instruction=instruction.value.trim();settings.messageColor=color.value;applyBarVisibility();applyMessageColor();saveSettings();scheduleVisibleDecoration();toast('설정을 저장했어.','success');});return true;}
function ensureOocBar(){let bar=document.getElementById(CONTAINER_ID);if(!bar){const form=document.getElementById('send_form');if(!form?.parentElement)return false;bar=buildBar();form.parentElement.insertBefore(bar,form);setBarCollapsed(barCollapsed);}applyBarVisibility();return true;}
function ensureUi(){ensureOocBar();injectSettingsPanel();}
function scheduleUiBootstrap(){[0,250,1000,2500,5000].forEach(d=>setTimeout(ensureUi,d));}
function bindDocumentHandlers(){if(documentHandlersBound)return;documentHandlersBound=true;document.addEventListener('pointerdown',e=>{const p=document.getElementById(POPOVER_ID);if(!p||p.hidden)return;const l=document.getElementById(LABEL_ID);if(p.contains(e.target)||l?.contains(e.target))return;closePromptPopover();},true);document.addEventListener('keydown',e=>{if(e.key==='Escape')closePromptPopover();});window.addEventListener('resize',()=>{const p=document.getElementById(POPOVER_ID);if(p&&!p.hidden)positionPromptPopover();});}
function bindEvents(){if(eventsBound)return;const c=getContext(),es=c?.eventSource,et=c?.eventTypes;if(!es||!et)return;if(et.APP_READY)es.on(et.APP_READY,()=>{ensureUi();scheduleVisibleDecoration();});if(et.CHAT_CHANGED)es.on(et.CHAT_CHANGED,()=>{chatRevision+=1;if(activeSend?.generating&&is_send_press)c.stopGeneration?.();activeSend?.controller.abort();activeSend?.cleanup();ensureOocBar();closePromptPopover();scheduleVisibleDecoration();});if(et.OAI_PRESET_CHANGED_AFTER)es.on(et.OAI_PRESET_CHANGED_AFTER,()=>{const p=document.getElementById(POPOVER_ID);if(p&&!p.hidden){renderPromptPopover();requestAnimationFrame(positionPromptPopover);}});if(et.USER_MESSAGE_RENDERED)es.on(et.USER_MESSAGE_RENDERED,id=>decorateOocMessage(id));if(et.MESSAGE_EDITED)es.on(et.MESSAGE_EDITED,id=>setTimeout(()=>decorateOocMessage(id),0));eventsBound=true;}
async function initOocChat(){if(initialized)return;initialized=true;loadSettings();bindEvents();bindDocumentHandlers();ensureUi();scheduleUiBootstrap();scheduleVisibleDecoration();console.log('[OOC Chat] v1.6.2 loaded');}
export async function init(){await initOocChat();}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initOocChat,{once:true});else initOocChat();
