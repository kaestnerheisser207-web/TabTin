import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, type Server } from 'node:http'
import {
  DshApiClient, DshRuntimeDriver, DshProcessService, DshModelGateway, DshCapabilityBridge,
} from '@muse/agent-host/runtime/dsh'
import sharp from 'sharp'
import type { QueryParams, ToolResult, Message } from '@muse/agent-runtime'

const enabled = process.env.MUSE_DSH_INTEGRATION === '1'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function listen(server:Server):Promise<number> {
  await new Promise<void>((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  const address=server.address();if(!address||typeof address==='string')throw new Error('No port');return address.port
}
function reply(response:import('node:http').ServerResponse, tool?:{name:string;args:Record<string,unknown>},text='MUSE_DSH_OK') {
  response.writeHead(200,{'content-type':'text/event-stream'})
  const delta=tool?{role:'assistant',tool_calls:[{index:0,id:`call-${tool.name}`,type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]}:{role:'assistant',content:text}
  response.write(`data: ${JSON.stringify({id:'muse-test',object:'chat.completion.chunk',created:1,model:'deepseek-v4-flash',choices:[{index:0,delta,finish_reason:null}]})}\n\n`)
  response.write(`data: ${JSON.stringify({id:'muse-test',object:'chat.completion.chunk',created:1,model:'deepseek-v4-flash',choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:30,completion_tokens:5,total_tokens:35}})}\n\n`)
  response.end('data: [DONE]\n\n')
}

describe.skipIf(!enabled)('Muse DSH capability plugin with real pinned DSH',()=>{
  it('loads the managed plugin, seeds history, composes host prompt, invokes a skill and audits a native file read',async()=>{
    const root=await mkdtemp(join(tmpdir(),'muse-dsh-parity-'));cleanup.push(()=>rm(root,{recursive:true,force:true}))
    await writeFile(join(root,'proof.txt'),'NATIVE_FILE_PROOF')
    const png=await sharp({create:{width:2,height:2,channels:3,background:{r:255,g:0,b:0}}}).png().toBuffer()
    let active:QueryParams|undefined
    const invokes:Array<Record<string,unknown>>=[]
    const nativeBefore:Array<Record<string,unknown>>=[]
    const nativeAfter:Array<Record<string,unknown>>=[]
    const capabilities={
      async beginRun(params:QueryParams){active=params},async endRun(){active=undefined},async dispose(){},
      async snapshot(){await active?.waitIfPaused?.(active.signal??new AbortController().signal);return {model:{id:'muse-selected-model',contextWindowTokens:32000,maxOutputTokens:4096,supportsVision:true},runId:active?.hostRunId??'',systemPrompt:'MUSE_SYSTEM_SENTINEL. Only use the supplied canonical tools.',context:'MUSE_CONTEXT_SENTINEL',tools:[{
        name:'skill_invoke',description:'Load a Muse skill',inputSchema:{type:'object',properties:{name:{type:'string'}},required:['name'],additionalProperties:false},
      },{name:'run_terminal_command',description:'Managed terminal including background commands',inputSchema:{type:'object',properties:{command:{type:'string'}},required:['command']}}]}},
      async invoke(input:Record<string,unknown>):Promise<ToolResult>{invokes.push(input);return {content:[{type:'text',text:'Skill loaded'},{type:'image',source:{type:'base64',media_type:'image/png',data:png.toString('base64')}}],newMessages:[{role:'user',content:'MUSE_SKILL_INSTRUCTIONS_SENTINEL'}]}},
      async beforeNative(input:Record<string,unknown>){nativeBefore.push(input);return {allowed:input.name==='read_file'}},
      async afterNative(input:Record<string,unknown>){nativeAfter.push(input)},
    } as unknown as ConstructorParameters<typeof DshCapabilityBridge>[0]
    let bridge=new DshCapabilityBridge(capabilities);await bridge.start();cleanup.push(()=>bridge.stop())
    const requests:Record<string,unknown>[]=[]
    const errors:string[]=[]
    let enteredBlockedModel!:()=>void
    let closedBlockedModel!:()=>void
    const blockedModelEntered=new Promise<void>(resolve=>{enteredBlockedModel=resolve})
    const blockedModelClosed=new Promise<void>(resolve=>{closedBlockedModel=resolve})
    const upstream=createServer(async(request,response)=>{
      let body='';for await(const chunk of request)body+=chunk.toString()
      const parsed=JSON.parse(body) as Record<string,unknown>;requests.push(parsed)
      try {
        expect(request.headers['x-tabtin-organization-id']).toBe('muse-org')
        expect(parsed.model).toBe('muse-selected-model')
        const all=JSON.stringify(parsed.messages)
        if (requests.length !== 6) expect(all).toContain('MUSE_SYSTEM_SENTINEL')
        if (requests.length <= 4) expect(all).toContain('MUSE_HISTORY_SENTINEL')
        if(requests.length !== 6) {
          const tools=parsed.tools as Array<{function:{name:string}}>
          expect(tools.some(tool=>tool.function.name==='skill_invoke')).toBe(true)
          expect(tools.some(tool=>tool.function.name==='read')).toBe(true)
          expect(tools.some(tool=>tool.function.name==='todo')).toBe(false)
          expect(tools.some(tool=>tool.function.name==='agent')).toBe(false)
          expect(tools.some(tool=>tool.function.name==='skill')).toBe(false)
          expect(all).not.toContain('<available_skills>')
        }
        if(requests.length===1)reply(response,{name:'skill_invoke',args:{name:'parity-skill'}})
        else if(requests.length===2){expect(all).toContain('MUSE_SKILL_INSTRUCTIONS_SENTINEL');expect(all).toContain('image_url');reply(response,{name:'read',args:{file_path:join(root,'proof.txt')}})}
        else if(requests.length===3){expect(all).toContain('NATIVE_FILE_PROOF');reply(response)}
        else if(requests.length===4){expect(all).toContain('image_url');reply(response,undefined,'IMAGE_OK')}
        else if(requests.length===5){expect(all).toContain('MUSE_REWRITTEN_HISTORY');expect(all).toContain('PAST_RESULT');expect(all).not.toContain('MUSE_HISTORY_SENTINEL');reply(response,undefined,'GENERATION_OK')}
        else if(requests.length===6){expect(all).toContain('POLICY_FOCUS_SENTINEL');reply(response,undefined,'POLICY_FOCUS_SENTINEL summarized')}
        else if(requests.length===9){
          expect(all).toContain('BLOCK_UNTIL_CANCEL_SENTINEL')
          response.once('close',()=>closedBlockedModel())
          enteredBlockedModel() // A real DSH model request is now waiting for bytes.
        }
        else if(requests.length===10){expect(all).toContain('AFTER_CONFIRMED_CANCEL_SENTINEL');reply(response,undefined,'AFTER_CANCEL_OK')}
        else {expect(all).not.toContain('Summarization focus requested by the user:');reply(response,undefined,'AFTER_COMPACT_OK')}
      }catch(error){errors.push(String(error)+' (controlled model request '+requests.length+')');reply(response,undefined,'TEST_ASSERTION_FAILED')}
    });const upstreamPort=await listen(upstream);cleanup.push(()=>new Promise<void>(resolve=>{upstream.closeAllConnections();upstream.close(()=>resolve())}))
    const gateway=new DshModelGateway({serverUrl:`http://127.0.0.1:${upstreamPort}`,organizationId:'muse-org',credential:'test-credential',token:'test-model-token',port:0,modelId:'muse-selected-model',sessionId:'muse-thread',beforeRequest:async()=>({modelId:'muse-selected-model',summaryFocus:bridge.compactionFocus})})
    await gateway.start();cleanup.push(()=>gateway.stop())
    const probe=createServer();const apiPort=await listen(probe);await new Promise<void>(resolve=>probe.close(()=>resolve()))
    const apiUrl=`http://127.0.0.1:${apiPort}`
    const processService=new DshProcessService({workspaceRoot:root,dshHome:join(root,'dsh-home'),apiUrl,modelGatewayUrl:`http://127.0.0.1:${gateway.port}/v1`,modelGatewayToken:'test-model-token',
      capabilityBridgeUrl:bridge.url,capabilityBridgeToken:bridge.token,pluginPath:resolve('../../packages/dsh-muse-plugin/dist/index.js'),
      executable:process.env.MUSE_DSH_TEST_EXECUTABLE??join(process.cwd(),'node_modules','.bin','dsh'),logger:{info(){},warn(message){errors.push(message)}}})
    cleanup.push(()=>processService.stop());await processService.start(AbortSignal.timeout(30000))
    const driver=new DshRuntimeDriver(new DshApiClient(apiUrl),undefined,'muse-selected-model',bridge,{bindingPath:join(root,'binding.json')})
    const {runtime}=await driver.create({threadId:'muse-thread',workspaceId:'muse-workspace',workspaceRoot:root,owner:{userId:'muse-user',organizationId:'muse-org'}})
    const events=[]
    for await(const event of runtime.query({prompt:'Use the skill, then read the proof file.',initialMessages:[{role:'user',content:'MUSE_HISTORY_SENTINEL'},{role:'assistant',content:'History received.'},{role:'user',content:'Use the skill, then read the proof file.'}],hostRunId:'muse-run-1',signal:AbortSignal.timeout(45000)}))events.push(event)
    expect(errors).toEqual([])
    expect(invokes).toHaveLength(1)
    expect(nativeBefore).toHaveLength(1)
    expect(nativeBefore[0]).toMatchObject({name:'read_file',arguments:{path:join(root,'proof.txt')}})
    expect(nativeAfter).toHaveLength(1)
    expect(JSON.stringify(nativeAfter[0])).toContain('NATIVE_FILE_PROOF')
    expect(requests).toHaveLength(3)
    expect(events.find(event=>event.type==='agent.stream.done')?.payload).toMatchObject({error:false,content:'MUSE_DSH_OK'})
    const paired=events.filter(event=>event.type==='agent.stream.persist_message' && event.payload.message_kind==='llm')
      .find(event=>JSON.stringify(event.payload.blocks_json).includes('tool_result'))
    expect(paired).toBeDefined()
    const collect=async(params:QueryParams)=>{const result=[];for await(const event of runtime.query(params))result.push(event);return result}
    const prior:Message[]=[{role:'user',content:'MUSE_HISTORY_SENTINEL'},{role:'assistant',content:'History received.'},{role:'user',content:'Use the skill, then read the proof file.'},{role:'assistant',content:'MUSE_DSH_OK'}]
    let resume:()=>void=()=>{throw new Error('pause not initialized')}
    let entered:()=>void=()=>{throw new Error('pause not initialized')}
    const paused=new Promise<void>(resolve=>{resume=resolve})
    const pauseEntered=new Promise<void>(resolve=>{entered=resolve})
    const second=collect({prompt:'Inspect image',initialMessages:[...prior,{role:'user',content:[{type:'text',text:'Inspect image'},{type:'image',source:{type:'base64',media_type:'image/png',data:png.toString('base64')}}]}],hostRunId:'muse-run-2',signal:AbortSignal.timeout(45000),waitIfPaused:async()=>{entered();await paused}})
    await pauseEntered
    expect(requests).toHaveLength(3)
    resume()
    expect((await second).find(event=>event.type==='agent.stream.done')?.payload).toMatchObject({content:'IMAGE_OK'})
    const rewritten:Message[]=[{role:'user',content:'MUSE_REWRITTEN_HISTORY '+ 'Historical detail retained for a meaningful compaction test. '.repeat(150)},{role:'assistant',content:[{type:'tool_use',id:'historical-read',name:'read_file',input:{path:join(root,'proof.txt')}},{type:'tool_result',tool_use_id:'historical-read',content:'PAST_RESULT'}]},{role:'user',content:'Continue after the rewritten history'}]
    expect((await collect({prompt:'Continue',initialMessages:rewritten,hostRunId:'muse-run-3',signal:AbortSignal.timeout(45000)})).find(event=>event.type==='agent.stream.done')?.payload).toMatchObject({content:'GENERATION_OK'})
    const compact=await runtime.compactCheckpoint?.({messages:rewritten,keepLastN:1,summaryFocus:'POLICY_FOCUS_SENTINEL'})
    expect(errors).toEqual([])
    expect(compact?.summary).toContain('POLICY_FOCUS_SENTINEL')
    expect((await collect({prompt:'After compact',initialMessages:[{role:'user',content:compact?.summary??''},{role:'user',content:'After compact'}],hostRunId:'muse-run-4',signal:AbortSignal.timeout(45000)})).find(event=>event.type==='agent.stream.done')?.payload).toMatchObject({content:'AFTER_COMPACT_OK'})
    expect(errors).toEqual([])
    expect(requests).toHaveLength(7)
    const bindingBefore=JSON.parse(await readFile(join(root,'binding.json'),'utf8'))
    expect(bindingBefore.lastCompleted).toBe(true)
    expect(bindingBefore.historyPrefix.every((value: string)=>/^[a-f0-9]{64}$/.test(value))).toBe(true)
    expect((await stat(join(root,'binding.json'))).mode & 0o777).toBe(0o600)
    await runtime.dispose?.()
    await processService.stop()
    await bridge.stop()
    bridge=new DshCapabilityBridge({...capabilities});await bridge.start();cleanup.push(()=>bridge.stop())
    const restarted=new DshProcessService({workspaceRoot:root,dshHome:join(root,'dsh-home'),apiUrl,modelGatewayUrl:`http://127.0.0.1:${gateway.port}/v1`,modelGatewayToken:'test-model-token',
      capabilityBridgeUrl:bridge.url,capabilityBridgeToken:bridge.token,pluginPath:resolve('../../packages/dsh-muse-plugin/dist/index.js'),
      executable:process.env.MUSE_DSH_TEST_EXECUTABLE??join(process.cwd(),'node_modules','.bin','dsh'),logger:{info(){},warn(message){errors.push(message)}}})
    cleanup.push(()=>restarted.stop());await restarted.start(AbortSignal.timeout(30000))
    const coldDriver=new DshRuntimeDriver(new DshApiClient(apiUrl),undefined,'muse-selected-model',bridge,{bindingPath:join(root,'binding.json')})
    const cold=await coldDriver.create({threadId:'muse-thread',workspaceId:'muse-workspace',workspaceRoot:root,owner:{userId:'muse-user',organizationId:'muse-org'}})
    for await(const _event of cold.runtime.query({prompt:'Continue from durable resume',initialMessages:[{role:'user',content:compact?.summary??''},{role:'user',content:'After compact'},{role:'assistant',content:'AFTER_COMPACT_OK'},{role:'user',content:'Continue from durable resume'}],hostRunId:'muse-run-cold',signal:AbortSignal.timeout(45000)})){/* drain */}
    const bindingAfter=JSON.parse(await readFile(join(root,'binding.json'),'utf8'))
    expect(bindingAfter.sessionId).toBe(bindingBefore.sessionId)
    expect(bindingAfter.generation).toBe(bindingBefore.generation)
    expect(requests).toHaveLength(8)
    expect(errors).toEqual([])
    const controlSpy=vi.spyOn(bridge,'control') // Observe the real WebSocket control path, no stub.
    const cancelController=new AbortController()
    const cancelled=(async()=>{const result=[];for await(const event of cold.runtime.query({
      prompt:'BLOCK_UNTIL_CANCEL_SENTINEL',initialMessages:[{role:'user',content:'BLOCK_UNTIL_CANCEL_SENTINEL'}],
      hostRunId:'muse-run-cancel-real',signal:cancelController.signal,
    }))result.push(event);return result})()
    await blockedModelEntered
    expect(requests).toHaveLength(9)
    cancelController.abort(new Error('Integration test cancellation after model request admission'))
    const cancelledEvents=await cancelled
    expect(cancelledEvents.find(event=>event.type==='agent.stream.done')?.payload).toMatchObject({
      error:false,error_class:'ABORT',metadata:{host_confirmed:true},
    })
    const confirmationIndex=controlSpy.mock.calls.findIndex(([method])=>method==='cancelAndWait')
    expect(confirmationIndex).toBeGreaterThanOrEqual(0)
    expect(await controlSpy.mock.results[confirmationIndex]!.value).toEqual({stopped:true})
    await blockedModelClosed
    controlSpy.mockRestore()
    const afterCancel=[]
    for await(const event of cold.runtime.query({prompt:'AFTER_CONFIRMED_CANCEL_SENTINEL',
      initialMessages:[{role:'user',content:'AFTER_CONFIRMED_CANCEL_SENTINEL'}],hostRunId:'muse-run-after-cancel',signal:AbortSignal.timeout(45000),
    }))afterCancel.push(event)
    expect(afterCancel.find(event=>event.type==='agent.stream.done')?.payload).toMatchObject({error:false,content:'AFTER_CANCEL_OK'})
    expect(requests).toHaveLength(10)
    expect(invokes).toHaveLength(1)
    expect(nativeBefore).toHaveLength(1)
    expect(errors).toEqual([])
    await cold.runtime.dispose?.()
  },70000)
})
