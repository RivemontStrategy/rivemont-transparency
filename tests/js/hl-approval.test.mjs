// Exercise the real approve() flow; malformed prepare replies must never reach a wallet or submit endpoint.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../web/wallet/hl-wallet-flows.js', import.meta.url), 'utf8');
const start = source.indexOf('/*<approve>*/'), end = source.indexOf('/*</approve>*/');
assert.ok(start >= 0 && end > start, 'the real approval flow must be present');
const code = source.slice(start, end);
const own = '0x'+'1'.repeat(40), agent = '0x'+'2'.repeat(40), builder = '0x'+'3'.repeat(40), other = '0x'+'4'.repeat(40);
const now = 1791417600000;
const schemas = {
  approveAgent: [{name:'hyperliquidChain',type:'string'},{name:'agentAddress',type:'address'},{name:'agentName',type:'string'},{name:'nonce',type:'uint64'}],
  approveBuilderFee: [{name:'hyperliquidChain',type:'string'},{name:'maxFeeRate',type:'string'},{name:'builder',type:'address'},{name:'nonce',type:'uint64'}]
};
const domainFields = [{name:'name',type:'string'},{name:'version',type:'string'},{name:'chainId',type:'uint256'},{name:'verifyingContract',type:'address'}];
function prepared(kind, mode='live') {
  const action={type:kind,signatureChainId:'0xa4b1',hyperliquidChain:mode==='live'?'Mainnet':'Testnet',nonce:now,
    ...(kind==='approveAgent'?{agentAddress:agent,agentName:'rivemont'}:{maxFeeRate:'0.1%',builder})};
  const primary='HyperliquidTransaction:'+(kind==='approveAgent'?'ApproveAgent':'ApproveBuilderFee');
  return {action,typed_data:{domain:{name:'HyperliquidSignTransaction',version:'1',chainId:42161,verifyingContract:'0x'+'0'.repeat(40)},
    primaryType:primary,types:{[primary]:structuredClone(schemas[kind]),EIP712Domain:structuredClone(domainFields)},
    message:Object.fromEntries(schemas[kind].map(f=>[f.name,action[f.name]]))}};
}
async function run(kind, p, options={}) {
  const calls=[], signatures=[], messages=[], button={disabled:false};
  const ctx=vm.createContext({
    me:{address:own,agent_address:options.freshAgent?null:agent},info:{mode:options.mode||'live',builder,max_fee_rate:options.rate||'0.1%'},key:'test-only',
    Date:class extends Date {static now(){return now;}},
    _t:s=>s,say:(...v)=>messages.push(v),toast:()=>{},load:async()=>{},render:()=>{},
    WALLET:{connect:async()=>[options.wallet||own],chainId:async()=>'0xa4b1',signTypedData:async(...a)=>{signatures.push(a);return 'test-signature';}},
    api:async(path,body)=>{calls.push(path);if(path.endsWith('/prepare'))return structuredClone(p);return {address:own,agent_address:agent};}
  });
  vm.runInContext(code+'\nthis.approveHL=approve;',ctx);
  await ctx.approveHL(kind,button);
  return {calls,signatures,messages,button};
}
let scenarios=0;
for(const kind of ['approveAgent','approveBuilderFee']) {
  for(const options of [{},{mode:'testnet'},...(kind==='approveAgent'?[{freshAgent:true},{wallet:other}]:[])]) {
    const c=await run(kind,prepared(kind,options.mode),options);
    assert.equal(c.signatures.length,1);assert.ok(c.calls.includes('/api/auto/submit'));scenarios++;
  }
  const common=[
    p=>{p.action.type='withdraw3';},p=>{p.action.signatureChainId='0x1';},p=>{p.action.hyperliquidChain='Testnet';},
    p=>{p.action.nonce=now-600001;p.typed_data.message.nonce=p.action.nonce;},
    p=>{p.action.nonce=now+600001;p.typed_data.message.nonce=p.action.nonce;},
    p=>{p.action.nonce=String(now);p.typed_data.message.nonce=p.action.nonce;},
    p=>{p.action.extra='unsafe';},p=>{p.typed_data.primaryType='HyperliquidTransaction:Withdraw';},
    p=>{p.typed_data.domain.name='other';},p=>{p.typed_data.domain.version='2';},
    p=>{p.typed_data.domain.chainId=1;},p=>{p.typed_data.domain.verifyingContract=other;},
    p=>{p.typed_data.message.nonce++;},p=>{p.typed_data.message.extra='unsafe';},
    p=>{p.typed_data.types[p.typed_data.primaryType][0].type='address';},
    p=>{p.typed_data.types.EIP712Domain[2].type='string';},
    p=>{p.typed_data.types.Unexpected=[];},p=>{p.typed_data=null;},p=>{p.action=null;}
  ];
  const special=kind==='approveAgent'?[
    p=>{p.action.agentAddress=other;p.typed_data.message.agentAddress=other;},
    p=>{p.action.agentName='unrelated';p.typed_data.message.agentName='unrelated';},
    p=>{p.typed_data.message.agentAddress=other;}
  ]:[
    p=>{p.action.builder=other;p.typed_data.message.builder=other;},
    p=>{p.action.maxFeeRate='1%';p.typed_data.message.maxFeeRate='1%';},
    p=>{p.action.maxFeeRate='0.05%';p.typed_data.message.maxFeeRate='0.05%';},
    p=>{p.typed_data.message.builder=other;}
  ];
  for(const mutate of [...common,...special]) {
    const p=prepared(kind);mutate(p);const c=await run(kind,p);
    assert.equal(c.signatures.length,0);assert.ok(!c.calls.includes('/api/auto/submit'));
    assert.equal(c.button.disabled,false);assert.match(c.messages.at(-1)[1],/Nothing was signed/);scenarios++;
  }
}
const wrongWallet=await run('approveBuilderFee',prepared('approveBuilderFee'),{wallet:other});
assert.equal(wrongWallet.signatures.length,0);scenarios++;
const over=prepared('approveBuilderFee');over.action.maxFeeRate=over.typed_data.message.maxFeeRate='0.2%';
assert.equal((await run('approveBuilderFee',over,{rate:'0.2%'})).signatures.length,0);scenarios++;
const lower=prepared('approveBuilderFee');lower.action.maxFeeRate=lower.typed_data.message.maxFeeRate='0.05%';
assert.equal((await run('approveBuilderFee',lower,{rate:'0.05%'})).signatures.length,1);scenarios++;
console.log(`HL approval: ${scenarios} scenarios passed; all wallet requests and exchange submissions mocked`);
