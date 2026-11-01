import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { preparePair, openPair } from './bridge.mjs';

const ids = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'];
const request = [
  {venue:'GATEIO-FUTURES', ticker:'POWR_USDT', docId:ids[0]},
  {venue:'BINANCE-FUTURES', ticker:'POWRUSDT', docId:ids[1]}
];
function fixture() {
  const docs = ids.map(externalId => ({externalId, kind:'orderBook', linkNumber:9999, connectionId:0, ticker:'OLD'}));
  const state = {windows:[{id:1, tabs:[{id:3, documents:docs}]}]};
  const connections = [{Id:1, ExchangeId:3, MarketType:2, State:2}, {Id:2, ExchangeId:2, MarketType:2, State:2}];
  const writes = [];
  let polls = 0;
  const api = async (path, options) => {
    if (options?.method === 'PUT') { writes.push([path, JSON.parse(options.body)]); return {status:'ok'}; }
    if (path === '/api/connections') return {connections};
    if (path === '/api/ui/state') {
      polls++;
      if (writes.length === 2 && polls > 2) {
        docs[0].ticker = 'POWR_USDT'; docs[0].connectionId = 1;
        docs[1].ticker = 'POWRUSDT'; docs[1].connectionId = 2;
      }
      return state;
    }
    if (path.endsWith('/tickers')) return {tickers:[{Name:path.includes('/1/') ? 'POWR_USDT' : 'POWRUSDT'}]};
    throw Error(path);
  };
  return {api, docs, state, connections, writes};
}
test('preflight and exact writes confirm delayed state', async () => {
  const f = fixture();
  const {results} = await openPair(f.api, request, {attempts:3, delay:()=>Promise.resolve()});
  assert.deepEqual(results.map(r => r.confirmed), [true,true]);
  assert.deepEqual(f.writes.map(x=>x[1]), [{ticker:'POWR_USDT',connectionId:1},{ticker:'POWRUSDT',connectionId:2}]);
});
test('ambiguous connections and stale, linked, duplicate or separate documents refuse before writes', async () => {
  for (const mode of ['ambiguous','stale','linked','duplicate','separate','missing']) {
    const f = fixture();
    let legs = structuredClone(request);
    if (mode === 'ambiguous') f.connections.push({Id:4,ExchangeId:3,MarketType:5,State:2});
    if (mode === 'stale') legs[0].docId = '33333333-3333-3333-3333-333333333333';
    if (mode === 'linked') f.docs[0].linkNumber = 3;
    if (mode === 'duplicate') legs[1].docId = legs[0].docId;
    if (mode === 'separate') f.state.windows[0].tabs.push({id:4,documents:[f.state.windows[0].tabs[0].documents.pop()]});
    if (mode === 'missing') legs[0].ticker = 'MISSING';
    await assert.rejects(() => openPair(f.api, legs));
    assert.equal(f.writes.length,0,mode);
  }
});
test('a previously chosen ambiguous connection must remain eligible', async () => {
  const f = fixture();
  f.connections.push({Id:4,ExchangeId:3,MarketType:5,State:2});
  await assert.rejects(() => preparePair(f.api, [{...request[0],connectionId:9},request[1]]));
  const legs = await preparePair(f.api, [{...request[0],connectionId:1},request[1]]);
  assert.equal(legs[0].connectionId,1);
});
test('only known venue ticker aliases are accepted', async () => {
  const {resolveTicker} = await import('./bridge.mjs');
  assert.equal(resolveTicker([{Name:'POWR-USDT-SWAP'}], 'POWR_USDT', 'OKX-SWAP'), 'POWR-USDT-SWAP');
  assert.equal(resolveTicker([{Name:'XBTUSDTM'}], 'BTCUSDT', 'KUCOIN-LINEAR'), 'XBTUSDTM');
  assert.throws(() => resolveTicker([{Name:'BTCUSDTM'}], 'BTCUSDT', 'BINANCE-FUTURES'));
  assert.throws(() => resolveTicker([{Name:'BTCUSDTM'}, {Name:'XBTUSDTM'}], 'BTCUSDT', 'KUCOIN-LINEAR'));
});
test('polling failures remain visible in unconfirmed results', async () => {
  const {applyPair} = await import('./bridge.mjs');
  const f = fixture();
  const legs = await preparePair(f.api, request);
  const results = await applyPair(async (path, options) => {
    if (options?.method === 'PUT') return {};
    throw Error('offline');
  }, legs, {attempts:2, delay:()=>Promise.resolve()});
  assert.deepEqual(results.map(r => r.pollError), ['offline', 'offline']);
});

test('saved choices remain separate for two sides of the same venue', async () => {
  const {saveSetup, savedSelections} = await import('./bridge.mjs');
  const legs = [
    {side:'long', venue:'BYBIT-LINEAR', connectionId:4, doc:{externalId:ids[0]}},
    {side:'short', venue:'BYBIT-LINEAR', connectionId:6, doc:{externalId:ids[1]}}
  ];
  const saved = saveSetup(17845, legs, {});
  const selections = savedSelections(saved, legs.map(({side, venue}) => ({side, venue, ticker:'BTCUSDT'})));
  assert.deepEqual(selections.map(x => x.connectionId), [4, 6]);
  assert.deepEqual(selections.map(x => x.docId), ids);
});
