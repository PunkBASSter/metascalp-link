import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { candidates, resolveTicker, documents, applyPair } from './bridge.mjs';
const connections = [{Id:1,ExchangeId:3,MarketType:2,State:2},{Id:2,ExchangeId:2,MarketType:2,State:2},{Id:3,ExchangeId:2,MarketType:3,State:2}];
const state = {windows:[{id:1,tabs:[{id:10,name:'Main',documents:[{externalId:'11111111-1111-1111-1111-111111111111',kind:'orderBook',linkNumber:null,connectionId:1,ticker:'OLD'},{externalId:'22222222-2222-2222-2222-222222222222',kind:'orderBook',linkNumber:0,connectionId:2,ticker:'OLD'}]}]}]};
test('native IDs filter connected exact exchange and market', () => {
  assert.deepEqual(candidates(connections, {exchangeIds:[3], marketTypes:[2]}).map(x=>x.Id), [1]);
  assert.deepEqual(candidates(connections, {exchangeIds:[2], marketTypes:[2]}).map(x=>x.Id), [2]);
  assert.deepEqual(candidates(connections, {exchangeIds:[10], marketTypes:[5]}), []);
});
test('literal ticker alternatives match rows exactly and refuse ambiguity', () => {
  assert.equal(resolveTicker([{Name:'POWR-USDT'}], ['POWR_USDT','powr-usdt','POWR-USDT']), 'POWR-USDT');
  assert.throws(() => resolveTicker([{Name:'POWR-USDT'}, {Name:'POWR_USDT'}], ['POWR-USDT','POWR_USDT']));
  assert.throws(() => resolveTicker([{Name:'POWR-USDT'}], ['POWR_USDT']));
});
test('native fragment validates IDs and required repeated parameters', async () => {
  const {parseRequest} = await import('./bridge.mjs');
  const hash = '#longExchangeId=4&longExchangeId=6&longMarketType=0&longTicker=BTCUSDT&longLabel=Bybit&shortExchangeId=2&shortMarketType=2&shortTicker=BTCUSDT&shortLabel=Binance';
  assert.deepEqual(parseRequest(hash)[0].exchangeIds, [4,6]);
  assert.equal(parseRequest(hash)[0].marketTypes[0], 0);
  assert.throws(() => parseRequest(hash.replace('longExchangeId=4', 'longExchangeId=-1')));
  assert.throws(() => parseRequest(hash.replace('shortTicker=BTCUSDT', 'shortTicker=')));
});
test('only unlinked orderbooks are eligible',()=>{assert.equal(documents(state).length,2);assert.equal(documents({windows:[{tabs:[{documents:[{kind:'orderBook',linkNumber:3}]}]}]}).length,0)});
test('partial PUT result and bounded confirmation are reported',async()=>{let polls=0;const api=async(path,options)=>{if(options?.method==='PUT'){if(path.includes('2222'))throw Error('refused');return {status:'ok'}} if(path==='/api/ui/state'){polls++; return state} throw Error(path)}; const legs=[{doc:documents(state)[0],connectionId:1,ticker:'POWR_USDT'},{doc:documents(state)[1],connectionId:2,ticker:'POWRUSDT'}];const result=await applyPair(api,legs,{attempts:3,delay:()=>Promise.resolve()});assert.equal(polls,3);assert.equal(result[0].confirmed,false);assert.match(result[1].error,/refused/)});
test('discovery accepts only MetaScalp and uses loopback fetch options',async()=>{const {discover}=await import('./bridge.mjs');const calls=[];const found=await discover(async(url,options)=>{calls.push([url,options]);return {ok:true,json:async()=>({app:url.includes(':17846/')?'MetaScalp':'other'})}});assert.deepEqual(found.map(x=>x.port),[17846]);assert.equal(calls.length,11);assert.ok(calls.every(([url,o])=>url.startsWith('http://127.0.0.1:')&&o.credentials==='omit'&&o.targetAddressSpace==='loopback'))});
test('confirmation requires both ticker and connection on each document',async()=>{const docs=documents(state);const legs=[{doc:docs[0],connectionId:1,ticker:'NEW'},{doc:docs[1],connectionId:2,ticker:'NEW'}];let calls=0;const api=async(path,options)=>{if(options?.method==='PUT')return {status:'ok'};calls++;return {windows:[{id:1,tabs:[{id:10,documents:[{...docs[0],ticker:'NEW',connectionId:1},{...docs[1],ticker:'NEW',connectionId:9}]}]}]}};const result=await applyPair(api,legs,{attempts:2,delay:()=>Promise.resolve()});assert.deepEqual(result.map(x=>x.confirmed),[true,false]);assert.equal(calls,2)});
