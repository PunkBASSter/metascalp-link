import {test} from 'node:test';
import {strict as assert} from 'node:assert';

test('page saves separate Long and Short connection selections', async () => {
  const elements = new Map();
  class Element {
    constructor() { this.children = []; this.value = ''; this.hidden = false; }
    set id(value) { elements.set(value, this); }
    append(child) { this.children.push(child); }
    replaceChildren() { this.children = []; this.value = ''; }
    set textContent(value) { this.text = value; }
  }
  for (const id of ['request','connect','status','setup','instance','load','choices','apply']) elements.set(id, new Element());
  globalThis.document = {getElementById:id => elements.get(id), createElement:() => new Element()};
  globalThis.window = {addEventListener(){}};
  globalThis.location = {hash:'#longVenue=BYBIT-LINEAR&longTicker=BTCUSDT&shortVenue=BYBIT-LINEAR&shortTicker=BTCUSDT', reload(){}};
  let stored;
  globalThis.localStorage = {getItem:() => null, setItem:(key,value) => {stored = JSON.parse(value);}};
  const ids = ['11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222'];
  const docs = ids.map(externalId => ({externalId,kind:'orderBook',linkNumber:9999,ticker:'OLD'}));
  const connections = [4,6].map(Id => ({Id,Name:`connection ${Id}`,ExchangeId:4,MarketType:2,State:2}));
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/ping') return {ok:true,json:async()=>({app:parsed.port === '17845' ? 'MetaScalp' : 'other'})};
    if (parsed.pathname === '/api/connections') return {ok:true,json:async()=>({connections})};
    if (parsed.pathname === '/api/ui/state') return {ok:true,json:async()=>({windows:[{id:1,tabs:[{id:2,documents:docs}]}]})};
    if (parsed.pathname.endsWith('/tickers')) return {ok:true,json:async()=>({tickers:[{Name:'BTCUSDT'}]})};
    if (options.method === 'PUT') {
      const doc = docs.find(x => parsed.pathname.includes(x.externalId));
      Object.assign(doc, JSON.parse(options.body));
      return {ok:true,json:async()=>({status:'ok'})};
    }
    return {ok:true,json:async()=>({status:'ok'})};
  };
  await import('./app.mjs');
  await elements.get('connect').onclick();
  elements.get('instance').value = '17845';
  await elements.get('load').onclick();
  elements.get('longConnection').value = '4';
  elements.get('shortConnection').value = '6';
  elements.get('longDoc').value = ids[0];
  elements.get('shortDoc').value = ids[1];
  await elements.get('apply').onclick();
  assert.equal(stored.connections['long:BYBIT-LINEAR'],4);
  assert.equal(stored.connections['short:BYBIT-LINEAR'],6);
});
