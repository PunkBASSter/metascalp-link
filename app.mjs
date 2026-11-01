import {apiClient, candidates, discover, documents, openPair, saveSetup, savedSelections} from './bridge.mjs';
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.hash.slice(1));
const request = ['long', 'short'].map(side => ({
  side, venue:params.get(`${side}Venue`), ticker:params.get(`${side}Ticker`)
}));
const valid = request.every(x => x.venue && x.ticker && /^[A-Z0-9-]+$/.test(x.venue) && /^[A-Za-z0-9_\/-]+$/.test(x.ticker));
const status = message => $('status').textContent = message;
const storageKey = 'metascalp-setup';
window.addEventListener('hashchange', () => location.reload());
let saved;
try { saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { saved = null; }
let api;
function option(select, value, label) {
  const el = document.createElement('option');
  el.value = value;
  el.textContent = label;
  select.append(el);
}
function makeSelect(id, title, items, chosen) {
  const wrapper = document.createElement('label');
  wrapper.textContent = title;
  const select = document.createElement('select');
  select.id = id;
  option(select, '', 'Выберите…');
  items.forEach(item => option(select, item.value, item.text));
  if (items.some(item => String(item.value) === String(chosen))) select.value = chosen;
  wrapper.append(select);
  return wrapper;
}
$('request').textContent = valid
  ? request.map(x => `${x.side === 'long' ? 'Long' : 'Short'}: ${x.venue} · ${x.ticker}`).join('  |  ')
  : 'Откройте ссылку из Telegram: нужны площадки и тикеры для Long и Short.';
$('connect').disabled = !valid;
async function run(selected, persist) {
  status('Проверяем подключения, тикеры и стаканы…');
  try {
    const {legs, results} = await openPair(api, selected);
    if (persist) {
      saved = {port:Number($('instance').value), docs:legs.map(x => x.doc.externalId), connections:{...(saved?.connections || {})}};
      legs.forEach(x => { saved.connections[x.venue] = x.connectionId; });
      try { localStorage.setItem(storageKey, JSON.stringify(saved)); } catch { status('Настройка браузером не сохранена.'); }
    }
    let message = results.map((r, i) => {
      const detail = r.confirmed ? 'подтверждён' : r.error ? `ошибка отправки: ${r.error}`
        : `изменение не подтверждено${r.pollError ? `: ${r.pollError}` : ''}; проверьте MetaScalp`;
      return `${i ? 'Short' : 'Long'}: ${detail}`;
    }).join('\n');
    if (results.every(r => r.confirmed)) {
      try {
        await api(`/api/ui/tabs/${legs[0].doc.tabId}/activate`, {method:'POST'});
        message += '\nВкладка активирована.';
      } catch { message += '\nНе удалось активировать вкладку; откройте её вручную.'; }
    } else message += '\nПроверьте оба стакана перед повторной попыткой.';
    status(message);
    return true;
  } catch (e) {
    status(`Изменения не отправлены: ${e.message} Проверьте настройку ниже.`);
    return false;
  }
}
async function connect() {
  $('connect').disabled = true;
  $('setup').hidden = true;
  $('apply').hidden = true;
  status('Ищем MetaScalp…');
  const found = await discover();
  $('instance').replaceChildren();
  if (!found.length) {
    status('MetaScalp не найден. Проверьте, что он запущен и браузеру разрешён доступ к локальной сети, затем повторите.');
  } else {
    if (found.length > 1) option($('instance'), '', 'Выберите экземпляр…');
    found.forEach(x => option($('instance'), x.port, `MetaScalp · порт ${x.port}`));
    $('setup').hidden = false;
    if (found.length === 1 && saved?.port === found[0].port && saved?.docs?.length === 2) {
      api = apiClient(found[0].port);
      const selected = savedSelections(saved, request);
      await run(selected, false);
    } else status(found.length > 1 ? 'Найдено несколько экземпляров. Выберите нужный.' : 'MetaScalp найден. Настройте два стакана.');
  }
  $('connect').disabled = false;
}
$('connect').onclick = connect;
$('instance').onchange = () => {
  $('apply').hidden = true;
  $('choices').replaceChildren();
  status('Проверьте подключения выбранного экземпляра.');
};
$('load').onclick = async () => {
  $('apply').hidden = true;
  $('choices').replaceChildren();
  if (!$('instance').value) { status('Выберите экземпляр MetaScalp.'); return; }
  $('load').disabled = true;
  $('instance').disabled = true;
  api = apiClient(Number($('instance').value));
  status('Проверяем подключения и стаканы…');
  try {
    const [inventory, state] = await Promise.all([api('/api/connections'), api('/api/ui/state')]);
    const docs = documents(state);
    if (!docs.some((a, i) => docs.some((b, j) => i !== j && a.windowId === b.windowId && a.tabId === b.tabId)))
      throw Error('Создайте два отдельных несвязанных стакана на одной вкладке.');
    for (const leg of request) {
      const conns = candidates(inventory.connections, leg.venue);
      if (!conns.length) throw Error(`${leg.venue}: активное подключение не найдено.`);
      const section = document.createElement('div');
      section.className = 'leg';
      const heading = document.createElement('h2');
      heading.textContent = `${leg.side === 'long' ? 'Long' : 'Short'} · ${leg.venue} · ${leg.ticker}`;
      section.append(heading);
      const chosen = saved?.port === Number($('instance').value) ? saved.connections?.[`${leg.side}:${leg.venue}`] : null;
      section.append(makeSelect(`${leg.side}Connection`, 'Подключение', conns.map(c => ({value:c.Id, text:c.Name})), chosen || (conns.length === 1 ? conns[0].Id : '')));
      section.append(makeSelect(`${leg.side}Doc`, 'Стакан', docs.map((d, i) => ({value:d.externalId, text:`Стакан ${i + 1} · ${d.tabName || 'вкладка'} · ${d.ticker || 'без тикера'}`})), saved?.port === Number($('instance').value) ? saved.docs?.[leg.side === 'long' ? 0 : 1] : ''));
      $('choices').append(section);
    }
    $('apply').hidden = false;
    status('Выберите два разных стакана на одной вкладке. Настройка сохранится для следующих ссылок.');
  } catch (e) { status(`Не удалось проверить: ${e.message}`); }
  finally { $('load').disabled = false; $('instance').disabled = false; }
};
$('apply').onclick = async () => {
  $('apply').disabled = true;
  $('load').disabled = true;
  $('instance').disabled = true;
  $('connect').disabled = true;
  const selected = request.map(x => ({...x, connectionId:Number($(`${x.side}Connection`).value), docId:$(`${x.side}Doc`).value}));
  await run(selected, true);
  $('apply').disabled = false;
  $('load').disabled = false;
  $('instance').disabled = false;
  $('connect').disabled = false;
};
if (valid && saved?.docs?.length === 2) connect();
