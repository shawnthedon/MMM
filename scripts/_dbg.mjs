import { Window } from 'happy-dom';
const win = new Window({ url: 'http://localhost:5173/#/files' });
for (const k of ['document','navigator','location','localStorage','history','HTMLElement','Event','CustomEvent','KeyboardEvent','MouseEvent','PointerEvent','Node','Blob','requestAnimationFrame','cancelAnimationFrame']) {
  const v = win[k] ?? win; try { Object.defineProperty(globalThis,k,{value:v,configurable:true,writable:true}); } catch { try{globalThis[k]=v;}catch{} }
}
globalThis.window=win; globalThis.document=win.document; globalThis.localStorage=win.localStorage;
globalThis.CSS = win.CSS || { escape:(s)=>String(s) };
globalThis.requestAnimationFrame=(fn)=>setTimeout(fn,0);
globalThis.matchMedia=()=>({matches:false,addEventListener(){}}); win.matchMedia=globalThis.matchMedia;
win.document.body.innerHTML='<div id="app"><div id="view"></div><div id="sheet-root"></div><div id="toast-root"></div></div>';
const locations=[{id:'loc-a',label:'Artifacts',kind:'artifacts',rootPath:'/x',purpose:'uploads',granted:true}];
globalThis.fetch = async (url)=>{ const u=new URL(String(url),'http://x');
  const j=(b)=>({ok:true,status:200,text:async()=>JSON.stringify(b),headers:new win.Headers({'content-type':'application/json'})});
  if(u.pathname==='/api/v1/auth/session') return j({principal:{id:'u',name:'Owner',role:'Owner',type:'user'},permissions:['file:read','file:write'],csrfToken:'c'});
  if(u.pathname==='/api/v1/files/locations') return j({locations});
  if(u.pathname==='/api/v1/files/list') return j({location:'loc-a',path:u.searchParams.get('path')||'',parent:null,entries:[{name:'a.txt',path:'a.txt',type:'file',size:10,modifiedAt:Date.now(),extension:'txt'}]});
  if(u.pathname==='/api/v1/files/usage') return j({usage:[]});
  if(u.pathname==='/api/v1/files/downloads') return j({downloads:[]});
  return j({});
};
await import('../src/main.js');
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
await sleep(150);
const api=await import('../src/api.js'); const auth=await import('../src/auth.js'); const main=await import('../src/main.js');
api.setGatewayUrl('http://gw.test'); await auth.refreshSession({silent:true});
main.navigate('files'); await sleep(300);
const view=win.document.getElementById('view');
const row=view.querySelector('.fm-row[data-type="file"]');
console.log('row found:', !!row);
row.dispatchEvent(new win.PointerEvent('pointerdown',{bubbles:true}));
await sleep(700);
const sheet=win.document.querySelector('.sheet');
console.log('sheet:', !!sheet, sheet? [...sheet.querySelectorAll('[data-act]')].map(e=>e.dataset.act): null);
