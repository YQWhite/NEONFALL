import assert from 'node:assert/strict';
import { App } from '../src/ui/app.ts';
import { ServerApi } from '../src/api/client.ts';
import { ScoreSync } from '../src/api/score-sync.ts';
import { serverVersionMismatch } from '../src/ui/server-notice.ts';
import { setLanguage } from '../src/ui/i18n.ts';

class Element {
  children=[]; handlers=new Map(); attrs={}; style={}; isConnected=false;
  constructor(tag){this.tagName=tag;}
  append(...children){for(const child of children)this.appendChild(child);}
  appendChild(child){this.children.push(child);child.parent=this;child.isConnected=true;return child;}
  remove(){this.isConnected=false;if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
  setAttribute(name,value){this.attrs[name]=value;}
  addEventListener(name,fn){this.handlers.set(name,fn);}
  focus(){document.activeElement=this;}
  set innerHTML(value){throw Error('Server text must never be parsed as HTML');}
  dispatch(name,event){this.handlers.get(name)?.(event);}
}
globalThis.document={createElement:tag=>new Element(tag),body:new Element('body'),documentElement:{},activeElement:null};
globalThis.location=new URL('https://fixture.example.invalid');
setLanguage('zh-CN');
const api=new ServerApi('');api.serverVersion='0.2.8';api.metadataLoaded=true;
api.announcement={title:'<img src=x onerror=alert(1)>',body:'第一行\n<script>unsafe()</script>'};
const app=Object.create(App.prototype);
Object.assign(app,{server:api,serverOnline:true,version:'0.2.9',store:{settings:{}},screen:{name:'menu'},pointer:{down:true},ui:{cancelPointer(){}}});
const prior=new Element('input');document.body.appendChild(prior);prior.focus();
assert.equal(serverVersionMismatch('v0.2.9','0.2.9'),false);
assert.equal(serverVersionMismatch('','0.2.9'),false);
app.connectionEstablished(api);app.flushServerNotice();
const dialog=document.body.children.find(el=>el.attrs.role==='dialog');
assert.ok(dialog,'startup automatic connection shows an announcement dialog');
const panel=dialog.children[0], strings=panel.children.map(el=>el.textContent);
assert.ok(strings.includes(api.announcement.title));assert.ok(strings.includes(api.announcement.body));
assert.ok(strings.some(value=>value?.includes('0.2.8')&&value.includes('0.2.9')));
assert.ok(strings.some(value=>value?.includes('连接保持正常')),'different version warns without disconnecting');
assert.equal(app.serverOnline,true);assert.equal(app.pointer.down,false);
const button=panel.children.at(-1);assert.equal(document.activeElement,button);
let stopped=0,prevented=0;
dialog.dispatch('keydown',{key:'Tab',code:'Tab',stopPropagation(){stopped++;},preventDefault(){prevented++;}});
assert.equal(document.activeElement,button);assert.equal(prevented,1);
for(const event of ['pointerdown','pointermove','pointerup','pointercancel','click','wheel','keyup']) dialog.dispatch(event,{stopPropagation(){stopped++;}});
assert.equal(stopped,8,'announcement gestures never reach gameplay/menu listeners');
dialog.dispatch('keydown',{key:'Escape',code:'Escape',stopPropagation(){},preventDefault(){}});
assert.equal(dialog.isConnected,false);assert.equal(document.activeElement,prior);
app.connectionEstablished(api);app.flushServerNotice();
assert.equal(document.body.children.length,1,'repeated background connection checks do not repeat announcement');
app.connectionEstablished(api,true);app.flushServerNotice();
assert.equal(document.body.children.length,2,'explicit reconnect displays announcement again');
app.dismissServerNotice();assert.equal(document.body.children.length,1);
const second=new ServerApi('https://other.example.invalid');second.serverVersion='0.2.9';second.metadataLoaded=true;
app.server=second;app.screen={name:'play'};app.connectionEstablished(second);app.flushServerNotice();
assert.equal(document.body.children.length,1,'connection notification cannot interrupt active gameplay');
app.screen={name:'menu'};app.flushServerNotice();assert.equal(document.body.children.length,2);
app.dismissServerNotice();app.connectionEstablished(api,true);app.flushServerNotice();
assert.equal(document.body.children.length,1,'stale connection cannot announce old host');
app.store.settings.serverDisconnected=true;app.connectionEstablished(second,true);app.flushServerNotice();
assert.equal(document.body.children.length,1,'explicit disconnect remains silent');
// Recovering /me is not enough to consume an announcement after the first ping failed.
const storage=new Map();
globalThis.localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)};
const recovered=new ServerApi('https://recovered.example.invalid');
let pingAvailable=false,pingCalls=0,meCalls=0;
const originalFetch=globalThis.fetch;
globalThis.fetch=async url=>{
  if(String(url).endsWith('/api/me')) { meCalls++; return Response.json({username:'fixture',nickname:'Fixture',rating:0}); }
  assert.ok(String(url).endsWith('/api/ping'));
  pingCalls++;
  if(!pingAvailable) throw new TypeError('Fixture offline');
  return Response.json({ok:true,name:'neonfall-server',version:'0.2.9',announcement:{title:'Recovered announcement',body:'Actual public notice'}});
};
app.server=recovered;app.store={settings:{serverUrl:recovered.base},getToken:()=> 'fixture-token',getProfile:()=>null};
app.account={server:false,user:null};app.screen={name:'menu'};
try {
  assert.equal(await app.pingServer(),false);
  const sync=new ScoreSync(app);
  await sync.sync();app.flushServerNotice();
  assert.equal(app.serverOnline,true,'successful account recovery remains online even if ping is temporarily unavailable');
  assert.equal(document.body.children.length,1,'missing metadata cannot consume announcement opportunity');
  pingAvailable=true;
  await sync.sync();app.flushServerNotice();
  const recoveredPanel=document.body.children.at(-1).children[0];
  assert.ok(recoveredPanel.children.some(el=>el.textContent==='Actual public notice'));
  assert.ok(recoveredPanel.children.some(el=>el.textContent?.includes('0.2.9')));
  app.dismissServerNotice();await sync.sync();app.flushServerNotice();
  assert.equal(document.body.children.length,1,'recovered announcement displays exactly once');
  assert.equal(pingCalls,3);assert.equal(meCalls,3);
  // Changing server while the metadata request is pending must not announce the old server.
  const stale=new ServerApi('https://stale.example.invalid');app.server=stale;
  let releasePing;
  globalThis.fetch=async url=>String(url).endsWith('/api/me')
    ? Response.json({username:'fixture',nickname:'Fixture',rating:0})
    : new Promise(resolve=>{releasePing=()=>resolve(Response.json({ok:true,name:'neonfall-server',version:'0.2.9'}));});
  const flight=new ScoreSync(app).sync();
  while(!releasePing) await new Promise(resolve=>setTimeout(resolve,0));
  app.server=recovered;releasePing();await flight;app.flushServerNotice();
  assert.equal(document.body.children.length,1,'late metadata from a previous connection stays silent');
} finally {globalThis.fetch=originalFetch;}
console.log('PASS startup/reconnect announcements, version compatibility, literal public text, focus/gesture isolation and stale-connection suppression');
