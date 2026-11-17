/** Real React phase pages and PhaseTimer in Chrome, with delayed Firestore snapshots.
 * No production access. Normal 780/120-second timers use overdue local fixture timestamps.
 * --individual-source / --group-source can point at captured pre-fix pages.
 * Set PW to the installed Playwright index.mjs; --report writes JSON evidence.
 */
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const arg = key => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : null;
const paths = {
  IndividualPhase: resolve(arg('--individual-source') || resolve(root, 'src/pages/IndividualPhase.jsx')),
  GroupPhase: resolve(arg('--group-source') || resolve(root, 'src/pages/GroupPhase.jsx')),
};
const { chromium } = await import(process.env.PW || '/opt/node22/lib/node_modules/playwright/index.mjs');
const stub = `import React from 'react';
const scenario=new URLSearchParams(location.search).get('scenario');
const group=scenario.includes('voting');
const selection=scenario.includes('selection');
const empty=scenario.startsWith('empty');
const stale=scenario==='cache_selection';
const at=age=>{const ms=Date.now()-age;return {seconds:Math.floor(ms/1000),nanoseconds:(ms%1000)*1e6,toMillis:()=>ms}};
const q=window.qa={scenario,writes:[],batches:[],callbacks:[],navigations:[],ideasReleased:false};
q.ideas=empty?[]:Array.from({length:3},(_,i)=>({id:'i'+i,authorId:'qa-student',phase:group?'group':'individual',groupId:group?'g0':null,title:'Idea '+i,description:'Saved idea '+i,text:'Idea '+i,selected:!group&&(!stale||i===0),selectedBy:!group&&(!stale||i===0)?'participant':null,createdAt:at(1800000)}));
q.record={status:group?'group':'individual',groupId:'g0',individualStartedAt:at(900000),individualStage:selection?'selection':'generation',...(selection?{individualSelectionStartedAt:at(121000)}:{}),...(group?{groupStartedAt:at(900000),groupVotingStartedAt:at(121000),groupStage:'voting',votedFor:empty?[]:['i0','i1','i2']}:{}),timing:{individualOpenedAt:at(1000000),groupOpenedAt:at(1000000)}};
q.members=[{id:'qa-student',anonymousLabel:'p1',...q.record},{id:'peer',anonymousLabel:'p2',status:group?'group':'individual',groupId:'g0',votesSubmitted:false,individualComplete:false,votedFor:[]}];
const snapshot=(ref,fromCache=false)=>ref.path.endsWith('/ideas')?{docs:q.ideas.map(i=>({id:i.id,data:()=>({...i})})),metadata:{fromCache,hasPendingWrites:false}}:ref.path.endsWith('/messages')?{docs:[],metadata:{fromCache:false,hasPendingWrites:false}}:{exists:()=>true,data:()=>ref.path.endsWith('/groups/g0')?{members:['qa-student','peer'],memberLabels:{'qa-student':'p1',peer:'p2'},finalIdeas:[]}:({...q.record}),metadata:{fromCache:false,hasPendingWrites:false}};
const fire=(l,fromCache=false,metadataOnly=false)=>{if(metadataOnly&&!l.options.includeMetadataChanges)return;l.cb(snapshot(l.ref,fromCache))};
q.emitIdeas=(fromCache=false,metadataOnly=false)=>{for(const l of q.callbacks)if(l.ref.path.endsWith('/ideas'))fire(l,fromCache,metadataOnly)};
q.releaseIdeas=(metadataOnly=false)=>{q.ideasReleased=true;q.emitIdeas(false,metadataOnly)};
q.notify=()=>{for(const l of q.callbacks)if(!l.ref.path.endsWith('/ideas')||q.ideasReleased)fire(l)};
export const db={};export const doc=(_, ...parts)=>({path:parts.join('/')});export const collection=doc;export const query=(ref,...constraints)=>({...ref,constraints});export const where=(...args)=>args;export const orderBy=(...args)=>args;
export const onSnapshot=(ref,...args)=>{const options=typeof args[0]==='object'?args.shift():{};const l={ref,options,cb:args[0]};q.callbacks.push(l);queueMicrotask(()=>{if(!ref.path.endsWith('/ideas')||q.ideasReleased)fire(l)});return()=>{q.callbacks=q.callbacks.filter(x=>x!==l)}};
const apply=(ref,patch)=>{q.writes.push({path:ref.path,patch});if(ref.path.includes('/ideas/'))Object.assign(q.ideas.find(i=>ref.path.endsWith('/'+i.id)),patch);else if(ref.path.includes('/participants/'))Object.assign(q.record,patch)};
export const updateDoc=async(ref,patch)=>{apply(ref,patch);queueMicrotask(q.notify)};
export const writeBatch=()=>{const ops=[];return {update:(ref,patch)=>ops.push([ref,patch]),commit:async()=>{q.batches.push(ops.map(([ref,patch])=>({path:ref.path,patch})));ops.forEach(([ref,patch])=>apply(ref,patch));queueMicrotask(q.notify)}}};
export const serverTimestamp=()=>at(0);export const addDoc=async()=>{};export const deleteDoc=async()=>{};export const arrayUnion=(...x)=>x;export const arrayRemove=(...x)=>x;
const user={uid:'qa-student'};const session={phaseConfig:{individualPhaseActive:true,groupPhaseActive:true,phaseOrder:'individual_first',groupSize:3,maxIdeasIndividual:5,ideasCarriedToGroup:3,individualGenerationDuration:780,individualSelectionDuration:120,groupIdeationDuration:780,groupVotingDuration:120},aiConfig:{}};
export const useAuth=()=>({user});export const useSession=()=>({session});export const useSessionEnded=()=>false;export const useAIModelLabel=()=> 'QA';export const useGroupRoster=()=>q.members;
const navigate=path=>q.navigations.push(path);export const useNavigate=()=>navigate;export const useParams=()=>({sessionId:'QA'});
export const getContent=()=>({individual:{instructions:'QA instructions',brief:'QA brief'},group:{instructions:'QA instructions',brief:'QA brief'}});
export const serverNow=()=>Date.now();export const syncServerClock=async()=>{};
export const Done=()=>null;
export const ensureGroupProgress=async()=>{};
export default function Stub({children,leftPanel,rightPanel,html}){return React.createElement(React.Fragment,null,children,leftPanel,rightPanel,html||null)};
`;
const result=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import IndividualPhase from './src/pages/IndividualPhase.jsx';import GroupPhase from './src/pages/GroupPhase.jsx';const Page=new URLSearchParams(location.search).get('scenario').includes('voting')?GroupPhase:IndividualPhase;createRoot(document.getElementById('app')).render(<Page/>);`,resolveDir:root,loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',plugins:[{name:'controlled-timer-transport',setup(b){
  b.onLoad({filter:/[\\/]src[\\/]pages[\\/](IndividualPhase|GroupPhase)\.jsx$/},async a=>{const name=/(IndividualPhase|GroupPhase)\.jsx$/.exec(a.path)[1];return {contents:await readFile(paths[name],'utf8'),loader:'jsx',resolveDir:resolve(root,'src/pages')}});
  b.onResolve({filter:/^(react-router-dom|\.\.\/(utils\/(db|useGroupRoster|serverClock|ensureGroupProgress)|context\/(AuthContext|SessionContext)|data\/defaultContent|components\/(SplitLayout|ResizeDivider|AIChat|NudgeBanner|HeaderControls|RichText))|\.\/Survey)$/},()=>({path:'timer-qa',namespace:'qa'}));
  b.onLoad({filter:/.*/,namespace:'qa'},()=>({contents:stub,loader:'jsx',resolveDir:root}));
  b.onLoad({filter:/\.css$/},()=>({contents:'export default new Proxy({}, {get:(_,key)=>String(key)})',loader:'js'}));
}}]});
const js=result.outputFiles[0].text;
const previewResult=await build({stdin:{contents:`import {PREVIEW_DB, collection, doc, onSnapshot, setDoc, updateDoc} from './src/utils/previewDb.js';
const result=window.qaPreview={old:[],options:[],doc:[],errors:[]};
const rows=snap=>({values:snap.docs.map(d=>d.data().value),metadata:snap.metadata});
const coll=collection(PREVIEW_DB,'timer-test');const ref=doc(PREVIEW_DB,'timer-test','one');
const oldStop=onSnapshot(coll,snap=>result.old.push(rows(snap)),err=>result.errors.push(err.message));
const optionsStop=onSnapshot(coll,{includeMetadataChanges:true},snap=>result.options.push(rows(snap)),err=>result.errors.push(err.message));
onSnapshot(ref,{includeMetadataChanges:true},snap=>result.doc.push({exists:snap.exists(),metadata:snap.metadata}),err=>result.errors.push(err.message));
(async()=>{await setDoc(ref,{value:1});oldStop();await updateDoc(ref,{value:2});optionsStop();result.done=true})();`,resolveDir:root,loader:'js'},bundle:true,write:false,format:'iife',define:{'import.meta.env.BASE_URL':JSON.stringify('/')}});
const previewJs=previewResult.outputFiles[0].text;
const srv=createServer((req,res)=>{const script=req.url==='/app.js'||req.url==='/preview.js';res.setHeader('content-type',script?'text/javascript':'text/html');res.end(req.url==='/app.js'?js:req.url==='/preview.js'?previewJs:`<html><body><div id="app"></div><script src="${req.url.includes('scenario=preview')?'/preview.js':'/app.js'}"></script></body></html>`)});
await new Promise(r=>srv.listen(0,'127.0.0.1',r));
const browser=await chromium.launch(process.env.CHROMIUM?{executablePath:process.env.CHROMIUM}:{channel:'chrome'});
const checks=[];const check=(name,pass,detail)=>{checks.push({name,pass,detail});console.log(pass?'PASS':'FAIL',name)};
const base=`http://127.0.0.1:${srv.address().port}`;
const submitted=p=>p.evaluate(()=>qa.writes.filter(w=>w.patch.individualComplete||w.patch.votesSubmitted));
try {
 for(const scenario of ['generation','selection','cache_selection','voting','empty_generation','empty_voting']) {
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try {
   await page.goto(base+'/?scenario='+scenario);await page.waitForTimeout(1250);
   check(scenario+': expired reload waits for first idea snapshot',(await submitted(page)).length===0,await submitted(page));
   await page.evaluate(()=>qa.emitIdeas(true));await page.waitForTimeout(1150);
   if(!scenario.startsWith('empty')) {
    const name=scenario==='generation'?'Proceed to Selection':scenario.includes('selection')?'Finish & Submit':'Submit Votes';
    const button=page.getByRole('button',{name,exact:true});
    check(scenario+': stale cached ideas cannot enable manual completion',await button.count()===1&&await button.isDisabled());
   }
   check(scenario+': cached snapshot cannot decide final submission',(await submitted(page)).length===0,await submitted(page));
   await page.evaluate(()=>{if(qa.scenario==='cache_selection')qa.ideas.forEach(i=>{i.selected=i.id==='i1';i.selectedBy=i.selected?'participant':null});qa.releaseIdeas(qa.scenario!=='cache_selection')});await page.waitForTimeout(1150);
   const state=await page.evaluate(()=>({record:qa.record,ideas:qa.ideas,writes:qa.writes,batches:qa.batches,navigations:qa.navigations,metadataListeners:qa.callbacks.filter(l=>l.ref.path.endsWith('/ideas')).map(l=>l.options.includeMetadataChanges)}));
   if(scenario==='generation') check('generation: server ideas open selection without losing stage',state.record.individualStage==='selection'&&!state.record.individualComplete&&!!state.record.individualSelectionStartedAt,state);
   else if(scenario==='selection') check('selection: timeout preserves three hand-picked ideas before completing',state.record.individualComplete===true&&state.ideas.length===3&&state.ideas.every(i=>i.selected&&i.selectedBy==='participant')&&state.batches.some(b=>b.length===3),state);
   else if(scenario==='cache_selection') check('selection: authoritative server picks replace stale cached picks before expiry',state.record.individualComplete===true&&state.ideas.filter(i=>i.selectedBy==='participant').map(i=>i.id).join(',')==='i1'&&state.ideas.filter(i=>i.selectedBy==='computer').length===2,state);
   else if(scenario==='voting') check('voting: timeout records three required votes and keeps ballot',state.record.votesSubmitted===true&&state.record.votesRequired===3&&state.record.votedFor.join(',')==='i0,i1,i2',state);
   else if(scenario==='empty_generation') check('empty generation: server-confirmed empty snapshot still completes',state.record.individualComplete===true,state);
   else check('empty voting: server-confirmed empty snapshot still locks ballot',state.record.votesSubmitted===true&&state.record.votesRequired===1&&state.record.votedFor.length===0,state);
   check(scenario+': no Chrome page errors',errors.length===0,errors);
  } catch(e) { check(scenario+': execution',false,e.stack); }
  finally { await page.close(); }
 }
 const page=await browser.newPage();
 await page.goto(base+'/?scenario=preview');await page.waitForFunction(()=>window.qaPreview?.done);
 const preview=await page.evaluate(()=>window.qaPreview);
 check('preview: old and metadata-options listeners receive initial and written snapshots',preview.errors.length===0&&preview.old.length===2&&preview.options.length===3&&preview.options[0].values.length===0&&preview.options[2].values[0]===2,preview);
 check('preview: document and query snapshots are current and committed',preview.doc.length===3&&preview.doc[0].exists===false&&preview.doc[2].exists===true&&[...preview.doc,...preview.old,...preview.options].every(s=>s.metadata?.fromCache===false&&s.metadata?.hasPendingWrites===false),preview);
 await page.close();
} finally { await browser.close();await new Promise(r=>srv.close(r)); }
const report={at:new Date().toISOString(),paths,passed:checks.every(c=>c.pass),checks};
if(arg('--report'))await writeFile(resolve(arg('--report')),JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:report.passed,checks:checks.length}));if(!report.passed)process.exitCode=1;

