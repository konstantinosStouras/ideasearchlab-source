import {build} from 'esbuild'
import {createRequire} from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
const require=createRequire(import.meta.url)
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'group-export-'))
const output=path.join(dir,'export.cjs')
try{
 await build({stdin:{contents:"export {buildSessionSheets} from './src/utils/sessionExport.js'",resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:output,logLevel:'silent',plugins:[{name:'read-only-export',setup(builder){builder.onResolve({filter:/^(firebase\/firestore|\.\.\/firebase)$/},()=>({path:'stub',namespace:'test'}));builder.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const db=null;export function getDocs(){};export function collection(){};export function query(){};export function orderBy(){}'}));builder.onResolve({filter:/^xlsx-js-style$/},()=>({path:require.resolve('xlsx-js-style'),external:true}))}}]})
 const {buildSessionSheets}=require(output)
 for(const [sizes,targets,expected] of [[[3,2],[3,3],[2,1,1]],[[1],[1],[1,0,0]],[[2],[2],[1,0,0]],[[],[],[0,0,0]]]){
  const groups=sizes.map((size,index)=>({id:'g'+index,members:Array.from({length:size},(_,i)=>index+'-'+i),targetSize:targets[index],memberLabels:{},finalIdeas:[]}))
  const sheets=buildSessionSheets({id:'QA',phaseConfig:{groupSize:3}},{groups})
  const row=sheets.find(s=>s.name==='Conditions').rows[0]
  assert.deepEqual([row['Groups (total)'],row['Groups (triads)'],row['Incomplete groups']],expected)
  const about=new Map(sheets.find(s=>s.name==='About').aoa)
  assert.deepEqual([about.get('Groups (total)'),about.get('Groups (triads)'),about.get('Incomplete groups')],expected)
 }
 console.log('PASS group exports distinguish full trios, incomplete pairs, solo groups and configured pairs')
}finally{await fs.unlink(output).catch(()=>{});await fs.rmdir(dir)}
