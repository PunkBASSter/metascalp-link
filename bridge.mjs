const venues = {
  'BINANCE-SPOT': [[2], [0]], 'BINANCE-FUTURES': [[2], [2]],
  'BYBIT-SPOT': [[4, 6], [0]], 'BYBIT-LINEAR': [[4, 6], [2, 5]],
  'OKX-SPOT': [[10], [0]], 'OKX-SWAP': [[10], [2, 5]],
  'BITGET-LINEAR': [[7], [2, 5]], 'GATEIO-SPOT': [[3], [0]],
  'GATEIO-FUTURES': [[3], [2, 5]], 'KUCOIN-SPOT': [[5], [0]],
  'KUCOIN-LINEAR': [[5], [2, 5]]
};
export function candidates(items, venue) {
  const entry = venues[venue];
  if (!entry) throw Error(`Неподдерживаемая площадка: ${venue}`);
  return items.filter(c => c.State === 2 && entry[0].includes(c.ExchangeId) && entry[1].includes(c.MarketType));
}
const normalized = value => value.toUpperCase().replace(/[-_/]/g, '');
function tickerKey(value, venue) {
  let key = normalized(value);
  if (venue === 'OKX-SWAP') key = key.replace(/SWAP$/, '');
  if (venue === 'KUCOIN-LINEAR') {
    key = key.replace(/USDTM$/, 'USDT');
    if (key === 'XBTUSDT') key = 'BTCUSDT';
  }
  return key;
}
export function resolveTicker(items, wanted, venue = '') {
  const exact = items.filter(t => typeof t.Name === 'string' && t.Name.toUpperCase() === wanted.toUpperCase());
  const matches = exact.length ? exact : items.filter(t => typeof t.Name === 'string' && tickerKey(t.Name, venue) === tickerKey(wanted, venue));
  if (matches.length !== 1) throw Error(matches.length ? `Неоднозначный тикер ${wanted}` : `Тикер ${wanted} не найден`);
  return matches[0].Name;
}
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function documents(state) {
  return (state.windows || []).flatMap(w => (w.tabs || []).flatMap(t => (t.documents || [])
    .filter(d => d.kind === 'orderBook' && [null, 0, 9999].includes(d.linkNumber) && guid.test(d.externalId))
    .map(d => ({...d, windowId:w.id, tabId:t.id, tabName:t.name}))));
}
export function apiClient(port, fetcher = fetch) {
  if (!Number.isInteger(port) || port < 17845 || port > 17855) throw Error('Недопустимый порт');
  return async (path, options = {}) => {
    const response = await fetcher(`http://127.0.0.1:${port}${path}`, {
      ...options, credentials:'omit', targetAddressSpace:'loopback', signal:AbortSignal.timeout(3000),
      headers: options.body ? {'Content-Type':'application/json'} : {}
    });
    if (!response.ok) throw Error(`MetaScalp: HTTP ${response.status}`);
    return response.json();
  };
}
export async function discover(fetcher = fetch) {
  const results = await Promise.all(Array.from({length:11}, async (_, i) => {
    const port = 17845 + i;
    try {
      const ping = await apiClient(port, fetcher)('/ping');
      return ping.app === 'MetaScalp' ? {port, version:ping.version} : null;
    } catch { return null; }
  }));
  return results.filter(Boolean);
}
export async function preparePair(api, selected) {
  if (selected.length !== 2 || !selected[0].docId || !selected[1].docId || selected[0].docId === selected[1].docId)
    throw Error('Выберите два разных стакана.');
  const [inventory, state] = await Promise.all([api('/api/connections'), api('/api/ui/state')]);
  const docs = documents(state);
  const chosen = selected.map(item => {
    const possible = candidates(inventory.connections, item.venue);
    let connection;
    if (item.connectionId) connection = possible.find(c => c.Id === item.connectionId);
    else if (possible.length === 1) connection = possible[0];
    if (!connection) throw Error(`${item.venue}: выберите доступное подключение.`);
    const doc = docs.find(d => d.externalId === item.docId);
    if (!doc) throw Error('Сохранённый стакан не найден или связан. Выберите стаканы заново.');
    return {...item, connectionId:connection.Id, doc};
  });
  if (chosen[0].doc.windowId !== chosen[1].doc.windowId || chosen[0].doc.tabId !== chosen[1].doc.tabId)
    throw Error('Стаканы должны находиться на одной вкладке.');
  const tickerLists = await Promise.all(chosen.map(x => api(`/api/connections/${x.connectionId}/tickers`)));
  return chosen.map((item, i) => ({...item, ticker:resolveTicker(tickerLists[i].tickers, item.ticker, item.venue)}));
}
export async function applyPair(api, legs, {attempts = 8, delay = () => new Promise(r => setTimeout(r, 400))} = {}) {
  const sent = await Promise.allSettled(legs.map(leg => api(`/api/ui/documents/${leg.doc.externalId}/ticker`, {
    method:'PUT', body:JSON.stringify({ticker:leg.ticker, connectionId:leg.connectionId})
  })));
  const results = sent.map(r => r.status === 'fulfilled' ? {confirmed:false} : {confirmed:false, error:String(r.reason?.message || r.reason)});
  let pollError;
  for (let i = 0; i < attempts && results.some(r => !r.error && !r.confirmed); i++) {
    await delay();
    try {
      const current = documents(await api('/api/ui/state'));
      legs.forEach((leg, n) => {
        const d = current.find(x => x.externalId === leg.doc.externalId);
        if (!results[n].error && d?.connectionId === leg.connectionId && d.ticker === leg.ticker) results[n].confirmed = true;
      });
    } catch (e) { pollError = e.message; }
  }
  results.forEach(r => { if (!r.error && !r.confirmed && pollError) r.pollError = pollError; });
  return results;
}
export async function openPair(api, selected, options) {
  const legs = await preparePair(api, selected);
  return {legs, results:await applyPair(api, legs, options)};
}

export function saveSetup(port, legs, connections = {}) {
  const saved = {port, docs:legs.map(x => x.doc.externalId), connections:{...connections}};
  legs.forEach(x => { saved.connections[`${x.side}:${x.venue}`] = x.connectionId; });
  return saved;
}
export function savedSelections(saved, request) {
  return request.map((x, i) => ({...x, docId:saved.docs[i], connectionId:saved.connections?.[`${x.side}:${x.venue}`]}));
}
