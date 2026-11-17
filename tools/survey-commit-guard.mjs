/** Actual Survey React component against a controllable Firestore transport.
 * PW may point at installed Playwright. --source PATH tests captured old source.
 * --report PATH writes evidence. No production access or new dependencies.
 */
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const arg=k=>process.argv.includes(k)?process.argv[process.argv.indexOf(k)+1]:null;
const source=resolve(arg('--source')||resolve(root,'src/pages/Survey.jsx'));
const {chromium}=await import(process.env.PW||'/opt/node22/lib/node_modules/playwright/index.mjs');
const stub=`import React from 'react';
const q=window.qa={callbacks:[],navigations:[],writes:[],platformCompletions:0,record:{status:'survey',groupId:'g0',timing:{surveyOpenedAt:1}}};
window.simpMarkCompleted=()=>q.platformCompletions++;
q.emit=(record,pending=false,metadataOnly=false)=>{q.record=record;for(const l of q.callbacks){if(!metadataOnly||l.options.includeMetadataChanges)l.cb({exists:()=>true,data:()=>record,metadata:{hasPendingWrites:pending,fromCache:false}})}};
q.reject=()=>{q.emit({status:'survey',groupId:'g0',timing:{surveyOpenedAt:1}});q.deferred.reject(Error('synthetic offline write rejection'))};
q.resolve=()=>{q.persisted=q.writes.at(-1);q.deferred.resolve()};
export const db={};export const doc=(...x)=>x;export const serverTimestamp=()=>({seconds:1});
export const onSnapshot=(ref,...args)=>{const options=typeof args[0]==='object'?args.shift():{};const cb=args[0];const l={cb,options};q.callbacks.push(l);queueMicrotask(()=>cb({exists:()=>true,data:()=>q.record,metadata:{hasPendingWrites:false,fromCache:false}}));return()=>{q.callbacks=q.callbacks.filter(x=>x!==l)}};
export const updateDoc=(ref,data)=>{if(!data.surveyAnswers)return Promise.resolve();q.writes.push(data);return new Promise((resolve,reject)=>{q.deferred={resolve,reject};q.emit({...q.record,...data},true)})};
const user={uid:'qa-student'};const session={phaseConfig:{groupPhaseActive:false},aiConfig:{}};
export const useAuth=()=>({user});export const useSession=()=>({session});export const useSessionEnded=()=>false;
const navigate=path=>q.navigations.push(path);export const useNavigate=()=>navigate;export const useParams=()=>({sessionId:'QA'});
export const getContent=()=>({survey:{body:'QA survey'},done:{body:'QA confirmed completion'}});
export const getSurveyQuestions=()=>[{id:'qa_answer',type:'freetext',label:'QA answer',text:'QA answer',required:true}];
export const isPreview=()=>false;
export default function Stub({html}){return html?React.createElement('span',null,html):null};`;
const result=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Survey from './src/pages/Survey.jsx';window.mountSurvey=()=>{window.root?.unmount();window.root=createRoot(document.getElementById('app'));window.root.render(<Survey/>)};window.mountSurvey();`,resolveDir:root,loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',plugins:[{name:'controlled-transport',setup(b){b.onLoad({filter:/[\\/]src[\\/]pages[\\/]Survey\.jsx$/},async()=>({contents:await readFile(source,'utf8'),loader:'jsx',resolveDir:resolve(root,'src/pages')}));b.onResolve({filter:/^(react-router-dom|\.\.\/(utils\/(db|preview)|context\/(AuthContext|SessionContext)|data\/(defaultContent|formDefaults)|components\/(GroupResults|RichText|HeaderControls)))$/},a=>({path:'shared-qa',namespace:'qa'}));b.onLoad({filter:/.*/,namespace:'qa'},()=>({contents:stub,loader:'jsx',resolveDir:root}));b.onLoad({filter:/\.css$/},()=>({contents:'export default new Proxy({}, {get:(_,key)=>String(key)})',loader:'js'}))}}]});
// All stub imports must share one transport/module state.
let js=result.outputFiles[0].text;
const srv=createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?js:'<html><body><div id="app"></div><script src="/app.js"></script></body></html>')});await new Promise(r=>srv.listen(0,'127.0.0.1',r));
const browser=await chromium.launch(process.env.CHROMIUM?{executablePath:process.env.CHROMIUM}:{channel:'chrome'});
const checks=[];const check=(name,pass,detail)=>{checks.push({name,pass,detail});console.log(pass?'PASS':'FAIL',name)};
const base=`http://127.0.0.1:${srv.address().port}`;
let page;
try{
 page=await browser.newPage();await page.goto(base);await page.locator('textarea').fill('Synthetic answer retained across failed submission');await page.getByRole('button',{name:'Submit',exact:true}).click();await page.waitForTimeout(60);
 let state=await page.evaluate(()=>({nav:qa.navigations.length,platform:qa.platformCompletions,hasForm:!!document.querySelector('form'),writes:qa.writes.length}));
 check('Local pending done cannot navigate or render completion',state.nav===0&&state.platform===0&&state.hasForm&&state.writes===1,state);
 check('Unacknowledged submission remains disabled',await page.getByRole('button',{name:'Submitting...',exact:true}).isDisabled());
 await page.evaluate(()=>qa.reject());await page.getByText(/Your answers could not be saved/).waitFor();
 check('Rejected write retains answer, retry and draft',await page.locator('textarea').inputValue()==='Synthetic answer retained across failed submission'&&await page.getByRole('button',{name:'Submit',exact:true}).isEnabled()&&await page.evaluate(()=>JSON.parse(sessionStorage.getItem('ideationSurvey:QA:qa-student')).qa_answer)==='Synthetic answer retained across failed submission');
 await page.getByRole('button',{name:'Submit',exact:true}).click();await page.evaluate(()=>qa.resolve());await page.getByText('QA confirmed completion').waitFor();
 check('Acknowledged write completes and clears draft',await page.evaluate(()=>qa.persisted.surveyAnswers.qa_answer==='Synthetic answer retained across failed submission'&&!sessionStorage.getItem('ideationSurvey:QA:qa-student')&&qa.platformCompletions===1&&qa.navigations.at(-1)==='/session/QA/done'));
 await page.close();page=await browser.newPage();await page.goto(base);await page.locator('textarea').waitFor();await page.evaluate(()=>{qa.record={status:'done',groupId:'g0',timing:{surveyOpenedAt:1},surveyAnswers:{qa_answer:'already persisted'}};window.mountSurvey()});await page.waitForTimeout(60);
 check('Existing committed done restores completion',await page.evaluate(()=>qa.navigations.at(-1)==='/session/QA/done'));
 await page.close();page=await browser.newPage();await page.goto(base);await page.locator('textarea').waitFor();await page.evaluate(()=>qa.emit({...qa.record,status:'done'},true));await page.waitForTimeout(30);check('External pending done ignored',await page.evaluate(()=>qa.navigations.length===0));
}catch(e){check('Guard execution',false,e.stack)}finally{await browser.close();await new Promise(r=>srv.close(r))}
const report={source,at:new Date().toISOString(),passed:checks.every(c=>c.pass),checks};if(arg('--report'))await writeFile(resolve(arg('--report')),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:checks.length}));if(!report.passed)process.exitCode=1;



