import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import assert from 'node:assert/strict';
const { chromium, webkit, firefox } = await import(process.env.PW || 'file:///C:/Program%20Files/WindowsApps/OpenAI.CodexPrimaryRuntime.v26-1104-2876-0_26.1104.2876.0_x64__3k8sg7r9htsxt/dependencies/node/node_modules/playwright/index.mjs');
const root = 'C:/Users/LENOVO/Dropbox/Others/GitHub/ideasearchlab-source/dist';
const srv = createServer(async (req,res) => {if(req.url.startsWith('/simulation/')) {res.writeHead(200,{'Content-Type':'text/javascript'});res.end('');return;}let path=new URL(req.url,'http://local').pathname.replace('/lab/ideasearchlab/',''); let f=join(root,path); try { const b=await readFile(f);res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[extname(f)]||'application/octet-stream');res.end(b)}catch{res.setHeader('Content-Type','text/html');res.end(await readFile(join(root,'index.html')))}});
await new Promise(r=>srv.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${srv.address().port}/lab/ideasearchlab/`;
const results=[];
try {
for (const [name,engine,opts,context] of [
 ...(process.env.TEST_FIREFOX ? [['firefox-desktop',firefox,{}, {viewport:{width:1440,height:1000}}]] : []),
 ['edge-desktop',chromium,{channel:'msedge'}, {viewport:{width:1366,height:768}}],
 ['chrome-desktop',chromium,{channel:'chrome'},{viewport:{width:1440,height:1000}}],
 ['webkit-iphone',webkit,{executablePath:'C:/Users/LENOVO/AppData/Local/ms-playwright/webkit-2370/Playwright.exe'}, {viewport:{width:390,height:664},isMobile:true,hasTouch:true}],
 ['webkit-landscape',webkit,{executablePath:'C:/Users/LENOVO/AppData/Local/ms-playwright/webkit-2370/Playwright.exe'}, {viewport:{width:667,height:375},isMobile:true,hasTouch:true}],
]) {
 let browser;
 try {
 browser=await engine.launch({headless:true,...opts}); const p=await browser.newPage(context); const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.addInitScript(()=>{localStorage.setItem('ideasearchlab-preview-config',JSON.stringify({phaseConfig:{individualPhaseActive:false,groupPhaseActive:true,groupSize:1,groupIdeationDuration:300,groupVotingDuration:300},aiConfig:{groupAI:true}}))});
 await p.goto(base+'session/PREVIEW/welcome?preview=1&key=stouras');
 await p.getByRole('button',{name:/agree.*continue/i}).click();
 const skip=p.getByRole('button',{name:/skip/i}); if(await skip.count()) await skip.first().click();
 await p.getByRole('button',{name:/continue|submit|join/i}).last().click();
 await p.getByRole('button',{name:'Start',exact:true}).click();
 await p.getByRole('timer').waitFor();
 const timerBefore=await p.getByRole('timer').innerText();
 await p.evaluate(()=>{window.originalDateNow=Date.now;Date.now=()=>window.originalDateNow()+3600000});
 await p.waitForTimeout(1100);
 const timerAfter=await p.getByRole('timer').innerText();
 assert.ok(!timerAfter.startsWith('0:'),'Device clock skew expired timer');
 await p.evaluate(()=>{Date.now=window.originalDateNow;document.dispatchEvent(new Event('visibilitychange'))});
 for(let i=1;i<=3;i++) { await p.getByPlaceholder('Idea title').fill('Idea '+i); await p.getByPlaceholder(/^Description/).fill('Description '+i); await p.getByRole('button',{name:'Add',exact:true}).click(); }
 await p.getByRole('button',{name:'Edit',exact:true}).first().click();
 await p.getByLabel('Edit idea title').fill('Revised idea'); await p.getByLabel('Edit idea description').fill('Revised description');await p.getByRole('button',{name:'Save changes'}).click();
 await p.getByRole('heading',{name:'Revised idea',exact:true}).waitFor();
 await p.getByPlaceholder('Ask something... (Enter to send)').fill('A test prompt');await p.locator('form').filter({has:p.getByPlaceholder('Ask something... (Enter to send)')}).getByRole('button').last().click();
 await p.getByText('P1',{exact:true}).waitFor();
 await p.getByRole('button',{name:'Proceed to Voting',exact:true}).click();await p.getByRole('button',{name:'Got it',exact:true}).click();
 const headings=()=>p.locator('h4').allTextContents(); const before=await headings();
 for(let i=0;i<3;i++){await p.getByRole('button',{name:'Vote',exact:true}).first().click(); await p.waitForTimeout(100);}
 assert.deepEqual(await headings(),before,'Voting reordered cards');
 const ballot=await p.evaluate(()=>window.__islPreview.docs('sessions/PREVIEW/participants')[0].votedFor);assert.equal(ballot.length,3);
 await p.evaluate(()=>window.__islPreview.setGroup({members:['preview-user','peer'],memberLabels:{'preview-user':'p1',peer:'p2'}}));
 await p.getByRole('button',{name:'Submit Votes',exact:true}).click();
 await p.waitForTimeout(350);assert.ok(p.url().endsWith('/group'),'Partial roster prematurely advanced');
 await p.evaluate(()=>window.__islPreview.setMember('peer',{groupId:'g0',anonymousLabel:'p2',status:'group',votedFor:[],votesSubmitted:false}));
 await p.waitForTimeout(350);assert.ok(p.url().endsWith('/group'),'Unsubmitted peer prematurely advanced');
 await p.evaluate(()=>window.__islPreview.setMember('peer',{groupId:'g0',anonymousLabel:'p2',status:'group',votedFor:[],votesSubmitted:true}));
 await p.waitForURL('**/survey');await p.getByRole('heading',{name:"Your group's selected ideas"}).waitFor();assert.equal(errors.length,0,errors.join('\n'));
 await p.screenshot({path:`C:/Users/LENOVO/Dropbox/Others/GitHub/lab-ideasearchlab/outputs/${name}-fixed.png`});
 results.push({name,passed:true,checks:['partial roster and unsubmitted peer do not advance','one-hour clock skew and resume','create 3 ideas','edit and persist','anonymous AI label','dismiss mobile modal','single tap votes','stable card order','submit and result']});console.log(name,'PASS');
 }catch(e){results.push({name,passed:false,error:e.stack});console.error(name,e.message)}finally{await browser?.close()}
}
}finally{srv.close();await writeFile('C:/Users/LENOVO/Dropbox/Others/GitHub/lab-ideasearchlab/outputs/simulation-browser-results.json',JSON.stringify(results,null,2));}
if(results.some(r=>!r.passed))process.exitCode=1;
