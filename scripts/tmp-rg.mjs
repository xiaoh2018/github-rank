import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const port=9800+Math.floor(Math.random()*150), ud=path.join(os.tmpdir(),'cr-rg-'+Date.now());
const proc=spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--remote-debugging-port='+port,'--user-data-dir='+ud,'--no-first-run','--window-size=1300,900','about:blank'],{stdio:'ignore'});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
async function target(){for(let i=0;i<40;i++){try{const j=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();const p=j.find(t=>t.type==='page');if(p)return p;}catch(e){}await sleep(250);}throw new Error('no target');}
const page=await target();const ws=new WebSocket(page.webSocketDebuggerUrl);let id=0;const w=new Map();
ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id);}});
await new Promise(r=>ws.addEventListener('open',r));
const send=(method,params={})=>{const mid=++id;return new Promise((res,rej)=>{w.set(mid,m=>m.error?rej(new Error(JSON.stringify(m.error))):res(m.result));ws.send(JSON.stringify({id:mid,method,params}));});};
const js=async e=>(await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true})).result?.value;
await send('Runtime.enable');await send('Page.enable');
await send('Page.navigate',{url:'http://127.0.0.1:8123/?range=week'});await sleep(3000);
console.log('week first =>', await js(`(function(){var a=document.querySelector('#list .item b, #list .item .name');return a?a.textContent.trim():'none';})()`));
console.log('week count =>', await js(`document.querySelectorAll('#list .item').length`));
await js(`(function(){var b=document.querySelector('#ranges .btn[data-range="total"]');b.click();return 1;})()`);
await sleep(3500);
console.log('total first =>', await js(`(function(){var a=document.querySelector('#list .item b, #list .item .name');return a?a.textContent.trim():'none';})()`));
console.log('total count =>', await js(`document.querySelectorAll('#list .item').length`));
console.log('state =>', await js(`(function(){var s=document.querySelector('#pageInfo');return (s?s.textContent:'')+' | '+location.search;})()`));
console.log('status =>', await js(`document.getElementById('status').textContent`));
console.log('rangeKeys =>', await js(`Object.keys(window.__GHRANK_RANGES__||{})`));
try{await send('Browser.close');}catch(e){}
proc.kill();
