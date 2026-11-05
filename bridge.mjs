export function parseRequest(hash) {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  return ['long', 'short'].map(side => {
    const readIds = (suffix, min) => {
      const values = params.getAll(`${side}${suffix}`);
      if (!values.length || values.length > 16 || values.some(x => !/^(0|[1-9]\d{0,2})$/.test(x) || Number(x) < min))
        throw Error('Некорректные данные ссылки.');
      return [...new Set(values.map(Number))];
    };
    const exchangeIds = readIds('ExchangeId', 1);
    const marketTypes = readIds('MarketType', 0);
    const tickers = params.getAll(`${side}Ticker`);
    const labels = params.getAll(`${side}Label`);
    if (!tickers.length || tickers.length > 32 || tickers.some(x => !x || x.length > 128 || /[\x00-\x1f\x7f]/.test(x)) ||
        labels.length !== 1 || !labels[0].trim() || labels[0].length > 120 || /[\x00-\x1f\x7f]/.test(labels[0]))
      throw Error('Некорректные данные ссылки.');
    return {side, exchangeIds, marketTypes, tickers, label:labels[0]};
  });
}
export function candidates(items, target) {
  return items.filter(c => c.State === 2 && target.exchangeIds.includes(c.ExchangeId) && target.marketTypes.includes(c.MarketType));
}
export function resolveTicker(items, literals) {
  const names = new Set(literals.map(x => x.toUpperCase()));
  const matches = items.filter(t => typeof t.Name === 'string' && names.has(t.Name.toUpperCase()));
  if (matches.length !== 1) throw Error(matches.length ? 'Неоднозначный тикер' : 'Тикер не найден');
  return matches[0].Name;
}
export function targetKey(item) {
  const ids = xs => [...new Set(xs)].sort((a, b) => a - b).join(',');
  return `${item.side}:${ids(item.exchangeIds)}:${ids(item.marketTypes)}`;
}
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const linked = doc => Number.isInteger(doc.linkNumber) && doc.linkNumber > 0 && doc.linkNumber !== 9999;
function panels(state) {
  return (state.windows || []).flatMap(w => (w.tabs || []).flatMap(t => (t.documents || [])
    .filter(d => typeof d.externalId === 'string' && guid.test(d.externalId))
    .map(d => ({...d, windowId:w.id, tabId:t.id, tabName:t.name}))));
}
export function documents(state) {
  return panels(state).filter(d => d.kind === 'orderBook' && linked(d));
}
export function linkedPanels(state, doc) {
  return panels(state).filter(d => d.linkNumber === doc.linkNumber && d.externalId !== doc.externalId);
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
    const possible = candidates(inventory.connections, item);
    let connection;
    if (item.connectionId) connection = possible.find(c => c.Id === item.connectionId);
    else if (possible.length === 1) connection = possible[0];
    if (!connection) throw Error(`${item.label}: выберите доступное подключение.`);
    const doc = docs.find(d => d.externalId === item.docId);
    if (!doc) throw Error('Сохранённый стакан не найден или связан. Выберите стаканы заново.');
    return {...item, connectionId:connection.Id, connection, doc};
  });
  if (chosen[0].doc.windowId !== chosen[1].doc.windowId || chosen[0].doc.tabId !== chosen[1].doc.tabId)
    throw Error('Стаканы должны находиться на одной вкладке.');
  if (chosen[0].doc.linkNumber === chosen[1].doc.linkNumber)
    throw Error('Стаканы связаны в одну группу: смена тикера одного переключит другой. Выберите стаканы из разных групп.');
  const tickerLists = await Promise.all(chosen.map(x => api(`/api/connections/${x.connectionId}/tickers`)));
  return chosen.map((item, i) => ({...item, linked:linkedPanels(state, item.doc), ticker:resolveTicker(tickerLists[i].tickers, item.tickers)}));
}
export async function applyPair(api, legs, {attempts = 8, delay = () => new Promise(r => setTimeout(r, 400))} = {}) {
  const targets = leg => [leg.doc, ...(leg.linked || [])];
  const sent = await Promise.all(legs.map(leg => Promise.allSettled(targets(leg).map(d => api(`/api/ui/documents/${d.externalId}/ticker`, {
    method:'PUT', body:JSON.stringify({ticker:leg.ticker, connectionId:leg.connectionId})
  })))));
  const results = sent.map(leg => {
    const failed = leg.filter(r => r.status === 'rejected');
    return failed.length ? {confirmed:false, error:String(failed[0].reason?.message || failed[0].reason)} : {confirmed:false};
  });
  let pollError;
  for (let i = 0; i < attempts && results.some(r => !r.error && !r.confirmed); i++) {
    await delay();
    try {
      const current = panels(await api('/api/ui/state'));
      legs.forEach((leg, n) => {
        const moved = targets(leg).every(t => {
          const d = current.find(x => x.externalId === t.externalId);
          return d?.connectionId === leg.connectionId && d.ticker === leg.ticker;
        });
        if (!results[n].error && moved) results[n].confirmed = true;
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
  legs.forEach(x => { saved.connections[targetKey(x)] = x.connectionId; });
  return saved;
}
export function savedSelections(saved, request) {
  return request.map((x, i) => ({...x, docId:saved.docs[i], connectionId:saved.connections?.[targetKey(x)]}));
}
