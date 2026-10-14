const SNAPI_DELAY_MIN = 8000;
const SNAPI_DELAY_MAX = 15000;
const SNAPI_RETRIES = 2;

const SNAPI = {
  running: false,
  stopped: false,
  activeTabId: null,
  task: null
};

const SNAPI_SESSION = {
  csrfToken: '',
  liAt: ''
};

function snapiLog() {}
function snapiWarn() {}

async function snapiReadCookies() {
  const out = {};
  try {
    const all = await chrome.cookies.getAll({ url: 'https://www.linkedin.com' });
    for (const c of all) out[c.name] = c.value;
  } catch (e) {
    snapiWarn('cookie read failed', e);
  }
  return out;
}

function snapiRefreshSession(cookies) {
  SNAPI_SESSION.csrfToken = (cookies.JSESSIONID || '').replace(/^"|"$/g, '');
  SNAPI_SESSION.liAt = cookies.liAt || '';
}

const SNAPI_MAIN_FETCH = async function (url, csrfToken, liAt) {
  const headers = {
    Accept: 'application/json; charset=UTF-8',
    'csrf-token': csrfToken,
    'x-restli-protocol-version': '2.0.0'
  };
  if (liAt) headers['x-li-at'] = liAt;
  try {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      headers
    });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    return { status: res.status, ok: res.ok, data: data, error: null };
  } catch (e) {
    return { status: 0, ok: false, data: null, error: String((e && e.message) || e) };
  }
};

function snapiPick(obj, keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  if (obj.data && typeof obj.data === 'object') {
    for (const k of keys) {
      if (obj.data[k] !== undefined && obj.data[k] !== null) return obj.data[k];
    }
  }
  return undefined;
}

function snapiDeep(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
    else return undefined;
  }
  return cur;
}

function snapiCompanyUrl(lead) {
  const positions = Array.isArray(lead.currentPositions) ? lead.currentPositions : [];
  const positionUrn = positions[0] && positions[0].companyUrn;
  if (positionUrn) {
    const id = String(positionUrn).split(':').pop();
    if (id) return 'https://www.linkedin.com/sales/company/' + id;
  }
  const direct = snapiPick(lead, ['companyUrl', 'company.url', 'company.websiteUrl']);
  if (direct) return String(direct);
  const urn = snapiPick(lead, ['companyUrn', 'companyId', 'company.hashId', 'company.entityUrn']);
  if (urn !== undefined && urn !== null) {
    const id = String(urn).split(':').pop();
    if (id) return 'https://www.linkedin.com/sales/company/' + id;
  }
  return '';
}

function snapiSalesLeadUrl(lead) {
  const urn = snapiPick(lead, ['entityUrn', 'profileUrn', 'urn']);
  if (urn === undefined || urn === null) return '';
  const s = String(urn);
  const paren = s.match(/\(([^)]+)\)/);
  if (paren) {
    const id = paren[1].split(',')[0];
    if (id) return 'https://www.linkedin.com/sales/lead/' + id;
  }
  const last = s.split(':').pop();
  if (last && !/[,()]/.test(last)) return 'https://www.linkedin.com/sales/lead/' + last;
  return '';
}

function snapiProfileUrl(lead) {
  const sales = snapiSalesLeadUrl(lead);
  if (sales) return sales;
  const pid = snapiPick(lead, ['publicIdentifier', 'public_id', 'profileId']);
  if (pid) return 'https://www.linkedin.com/in/' + encodeURIComponent(String(pid));
  const direct = snapiPick(lead, ['publicProfileUrl', 'profileUrl', 'url']);
  if (direct) return String(direct);
  return '';
}

function snapiParseLead(node) {
  if (!node) return null;
  const lead = snapiPick(node, ['item', 'lead', 'leadData', 'member', 'data']) || node;
  const fullName = snapiPick(lead, ['fullName', 'name', 'displayName']) || '';
  const firstName = snapiPick(lead, ['firstName', 'first_name']) || '';
  const lastName = snapiPick(lead, ['lastName', 'last_name']) || '';
  const name = fullName || [firstName, lastName].filter(Boolean).join(' ').trim();
  if (!name) return null;

  const positions = Array.isArray(lead.currentPositions) ? lead.currentPositions : [];
  const first = positions[0] || null;

  return {
    name,
    jobTitle:
      (first && first.title) || snapiPick(lead, ['headline', 'jobTitle', 'title', 'occupation']) || '',
    company:
      (first && first.companyName) ||
      snapiPick(lead, ['companyName', 'companyDisplayName', 'company.name']) ||
      '',
    companyUrl: snapiCompanyUrl(lead),
    location:
      snapiPick(lead, ['geoRegion', 'geoLocationName', 'location', 'geoLocation', 'city', 'region']) || '',
    profileUrl: snapiProfileUrl(lead),
    scrapedAt: Date.now()
  };
}

function snapiSetUrlParam(urlString, name, value) {
  const qIdx = urlString.indexOf('?');
  if (qIdx === -1) {
    return urlString + '?' + name + '=' + encodeURIComponent(String(value));
  }
  const base = urlString.slice(0, qIdx + 1);
  const qs = urlString.slice(qIdx + 1);
  const re = new RegExp('(^|&)' + name + '=[^&]*');
  if (re.test(qs)) {
    return base + qs.replace(re, '$1' + name + '=' + encodeURIComponent(String(value)));
  }
  const sep = qs === '' ? '' : '&';
  return base + qs + sep + name + '=' + encodeURIComponent(String(value));
}

function buildReplayUrl(baseUrl, start, count) {
  if (!baseUrl) return '';
  let url = snapiSetUrlParam(baseUrl, 'start', start);
  url = snapiSetUrlParam(url, 'count', count);
  return url;
}

async function snapiFetch(task, start) {
  const url = buildReplayUrl(task.baseUrl, start, task.count);
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: task.tabId },
      world: 'MAIN',
      func: SNAPI_MAIN_FETCH,
      args: [url, SNAPI_SESSION.csrfToken, SNAPI_SESSION.liAt]
    });
  } catch (e) {
    return {
      status: 0,
      ok: false,
      data: null,
      message: 'MAIN world injection failed: ' + String((e && e.message) || e)
    };
  }
  const payload = results && results[0] && results[0].result;
  if (!payload || typeof payload.status !== 'number') {
    return {
      status: 0,
      ok: false,
      data: null,
      message: 'MAIN world returned no result (tab may have navigated away)'
    };
  }
  if (payload.status === 0) {
    return { status: 0, ok: false, data: null, message: payload.error || 'Injected fetch failed' };
  }
  return {
    status: payload.status,
    ok: payload.status >= 200 && payload.status < 300,
    data: payload.data,
    message: null
  };
}

function snapiExtractElements(root) {
  const paths = ['elements', 'data.elements', 'data.data.elements', 'data.searchResults'];
  for (const p of paths) {
    const v = snapiDeep(root, p);
    if (Array.isArray(v)) return v;
  }
  const direct = root.elements || root.data;
  if (Array.isArray(direct)) return direct;
  if (direct && Array.isArray(direct.elements)) return direct.elements;
  return [];
}

function snapiExtractTotal(root) {
  const v =
    snapiDeep(root, 'totalResultCount') ||
    snapiDeep(root, 'metadata.totalResultCount') ||
    snapiDeep(root, 'data.totalResultCount') ||
    snapiDeep(root, 'data.metadata.totalResultCount') ||
    snapiDeep(root, 'paging.total') ||
    snapiDeep(root, 'totalCount');
  return v !== undefined && v !== null ? Number(v) : null;
}

function snapiHasMore(root) {
  const v =
    snapiDeep(root, 'hasMore') ||
    snapiDeep(root, 'hasNextPage') ||
    snapiDeep(root, 'data.hasMore') ||
    snapiDeep(root, 'data.hasNextPage');
  return v === true;
}

async function snapiCommit(task) {
  task.updatedAt = Date.now();
  const state = {
    status: task.finished === 'stopped' ? 'stopped' : task.finished ? 'complete' : 'running',
    scrapedCount: task.scrapedCount,
    targetCount: task.targetCount,
    maxPages: task.maxPages,
    pages: task.iteration,
    pageUrl: task.baseUrl,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    updatedAt: task.updatedAt,
    error: task.lastError || null
  };
  await chrome.storage.local.set({
    ['sn_task_' + task.tabId]: task,
    ['sn_state_' + task.tabId]: state,
    ['sn_leads_' + task.tabId]: task.leads
  });
  chrome.runtime.sendMessage({ type: 'SCRAPE_PROGRESS', state }).catch(() => {});
}

function snapiSleep() {
  const ms = SNAPI_DELAY_MIN + Math.floor(Math.random() * (SNAPI_DELAY_MAX - SNAPI_DELAY_MIN + 1));
  if (Math.random() < 0.1) {
    const extra = Math.floor(Math.random() * 5000);
    return new Promise((r) => setTimeout(r, ms + extra));
  }
  return new Promise((r) => setTimeout(r, ms));
}

async function snapiRun(task) {
  SNAPI.running = true;
  SNAPI.stopped = false;
  SNAPI.activeTabId = task.tabId;
  SNAPI.task = task;

  const seen = new Set();
  for (const lead of task.leads) {
    seen.add(lead.profileUrl || lead.name);
  }

  let start = Number(task.start) || 0;
  let iteration = Number(task.iteration) || 0;
  let retries = SNAPI_RETRIES;

  while (true) {
    if (SNAPI.stopped) {
      task.finished = 'stopped';
      break;
    }
    if (task.scrapedCount >= task.targetCount) {
      task.finished = 'complete';
      break;
    }
    if (task.maxPages && iteration >= task.maxPages) {
      task.finished = 'complete';
      break;
    }

    const cookies = await snapiReadCookies();
    snapiRefreshSession(cookies);
    if (!SNAPI_SESSION.csrfToken) {
      task.finished = 'error';
      task.lastError = 'JSESSIONID cookie not found. Log in to Sales Navigator and try again.';
      break;
    }

    let res;
    try {
      res = await snapiFetch(task, start);
    } catch (e) {
      task.lastError = 'Network failure: ' + (e && e.message ? e.message : String(e));
      if (retries > 0) {
        retries -= 1;
        await snapiSleep();
        continue;
      }
      task.finished = 'error';
      break;
    }

    if (res.status === 0) {
      task.lastError = res.message || 'Fetch failed without a status';
      task.finished = 'error';
      break;
    }

    if (res.status === 401 || res.status === 403 || res.status === 429) {
      const msg = res.message || snapiDeep(res.data, 'message') || snapiDeep(res.data, 'serviceErrorCode');
      task.lastError = 'HTTP ' + res.status + (msg ? ': ' + msg : '');
      if (res.status === 429 && retries > 0) {
        retries -= 1;
        await snapiSleep();
        continue;
      }
      task.finished = 'error';
      break;
    }

    if (!res.ok) {
      task.lastError = res.message || 'HTTP ' + res.status + ': LinkedIn returned a non-JSON error';
      task.finished = 'error';
      break;
    }

    const root = res.data || {};
    const elements = snapiExtractElements(root);
    const total = snapiExtractTotal(root);
    const hasMore = snapiHasMore(root);

    if (elements.length > 0) {
      let added = 0;
      for (const el of elements) {
        if (task.leads.length >= task.targetCount) break;
        const lead = snapiParseLead(el);
        if (!lead) continue;
        const key = lead.profileUrl || lead.name;
        if (seen.has(key)) continue;
        seen.add(key);
        task.leads.push(lead);
        added += 1;
      }
      task.scrapedCount = task.leads.length;
      if (added > 0) {
        snapiLog('page ' + (Math.floor(start / task.count) + 1) + ': +' + added + ' leads (total ' + task.scrapedCount + '/' + task.targetCount + ')');
      }
    } else {
      snapiLog('page ' + (Math.floor(start / task.count) + 1) + ': no elements returned');
    }

    start += task.count;
    iteration += 1;
    task.start = start;
    task.iteration = iteration;
    task.total = total;
    await snapiCommit(task);

    if (task.scrapedCount >= task.targetCount) {
      task.finished = 'complete';
      break;
    }
    if (task.maxPages && iteration >= task.maxPages) {
      task.finished = 'complete';
      break;
    }
    if (total !== null && start >= total) {
      task.finished = 'complete';
      break;
    }
    if (!hasMore && elements.length === 0) {
      task.finished = 'complete';
      break;
    }

    await snapiSleep();
  }

  if (task.finished === 'complete' || task.finished === 'stopped' || task.finished === 'error') {
    task.completedAt = Date.now();
  }
  await snapiCommit(task);
  snapiLog('finished:', task.finished, 'total leads', task.scrapedCount, 'error:', task.lastError || 'none');
  SNAPI.running = false;
  SNAPI.task = null;
}

async function snapiStart(init) {
  if (!init.baseUrl) {
    return { ok: false, error: 'No captured search URL. Run a Sales Navigator search first to capture search criteria.' };
  }
  const cookies = await snapiReadCookies();
  snapiRefreshSession(cookies);
  if (!SNAPI_SESSION.csrfToken) {
    return { ok: false, error: 'JSESSIONID cookie not found. Log in to Sales Navigator first.' };
  }
  const fresh = {
    tabId: init.tabId,
    baseUrl: init.baseUrl,
    targetCount: init.targetCount,
    maxPages: init.maxPages,
    count: 25,
    start: 0,
    iteration: 0,
    leads: [],
    scrapedCount: 0,
    total: null,
    finished: null,
    lastError: null,
    startedAt: Date.now(),
    completedAt: null,
    updatedAt: Date.now()
  };
  await snapiCommit(fresh);
  snapiRun(fresh).catch((e) => {
    snapiWarn('driver crashed', e);
    fresh.finished = 'error';
    fresh.lastError = 'Driver crash: ' + (e && e.message ? e.message : String(e));
    snapiCommit(fresh).catch(() => {});
  });
  return { ok: true };
}

async function snapiStop(tabId) {
  const task = SNAPI.task;
  if (task && task.tabId === tabId) {
    SNAPI.stopped = true;
    return;
  }
  if (SNAPI.running) return;
  const res = await chrome.storage.local.get('sn_task_' + tabId);
  const t = res['sn_task_' + tabId];
  if (t && t.finished !== true) {
    t.finished = 'stopped';
    await snapiCommit(t);
  }
}

function snapiStopAll() {
  if (SNAPI.running && SNAPI.task) {
    SNAPI.stopped = true;
  }
}

async function snapiResumeAll() {
  if (SNAPI.running) return;
  const all = await chrome.storage.local.get(null);
  for (const key of Object.keys(all)) {
    if (key.startsWith('sn_task_')) {
      const task = all[key];
      if (task && task.tabId != null && !task.finished && SNAPI.running === false) {
        snapiLog('resuming scrape for task', task.tabId);
        task.leads = Array.isArray(task.leads) ? task.leads : [];
        snapiRun(task).catch((e) => snapiWarn('resumed driver crashed', e));
        return;
      }
    }
  }
}

// === BACKGROUND LOGIC ===
const STATE_PREFIX = 'sn_state_';
const LEADS_PREFIX = 'sn_leads_';
const TASK_PREFIX = 'sn_task_';
const ALARM_NAME = 'sn_heartbeat';
const ACTIVE_SEARCH_URLS = {};

const stateKey = (tabId) => STATE_PREFIX + tabId;
const leadsKey = (tabId) => LEADS_PREFIX + tabId;
const taskKey = (tabId) => TASK_PREFIX + tabId;

function isSalesNavUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.hostname !== 'linkedin.com' && !u.hostname.endsWith('.linkedin.com')) return false;
    return u.pathname.startsWith('/sales/');
  } catch {
    return false;
  }
}

async function storageGet(key) {
  const res = await chrome.storage.local.get(key);
  return res[key];
}

async function storageSet(obj) {
  await chrome.storage.local.set(obj);
}

async function storageRemove(key) {
  await chrome.storage.local.remove(key);
}

async function handleMessage(msg, sender) {
  if (!msg || !msg.type) return { ok: false, error: 'Unknown message' };

  if (msg.type === 'GET_STATUS') {
    const tabId = msg.tabId;
    const state = await storageGet(stateKey(tabId));
    const leads = await storageGet(leadsKey(tabId));
    const task = await storageGet(taskKey(tabId));
    let merged = state || null;
    if (task && task.updatedAt && (!merged || task.updatedAt >= (merged.updatedAt || 0))) {
      merged = Object.assign({}, merged || {}, {
        status: task.finished === 'stopped' ? 'stopped' : task.finished ? 'complete' : 'running',
        scrapedCount: task.scrapedCount || 0,
        targetCount: task.targetCount || 0,
        maxPages: task.maxPages || 0,
        pages: task.iteration || 0,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        updatedAt: task.updatedAt,
        error: task.lastError || null
      });
    }
    return {
      ok: true,
      state: merged,
      count: leads ? leads.length : 0,
      isSalesNav: msg.url ? isSalesNavUrl(msg.url) : null
    };
  }

  if (msg.type === 'START_SCRAPE') {
    if (typeof msg.tabId !== 'number') return { ok: false, error: 'Missing tab' };
    const tabId = msg.tabId;
    const baseUrl = ACTIVE_SEARCH_URLS[tabId] || (await storageGet('sn_url_' + tabId));
    if (!baseUrl) {
      const errMsg = 'Please refresh or perform a search on Sales Navigator first to capture search criteria.';
      await storageSet({
        [stateKey(tabId)]: {
          status: 'error',
          scrapedCount: 0,
          targetCount: Math.max(1, Math.min(5000, Number(msg.targetCount) || 50)),
          error: errMsg,
          updatedAt: Date.now()
        }
      }).catch(() => {});
      return {
        ok: false,
        error: errMsg
      };
    }
    const targetCount = Math.max(1, Math.min(5000, Number(msg.targetCount) || 50));
    const maxPages = Math.max(0, Number(msg.maxPages) || 0);

    await storageRemove(leadsKey(tabId)).catch(() => {});
    await storageRemove(taskKey(tabId)).catch(() => {});
    await storageRemove(stateKey(tabId)).catch(() => {});
    snapiStopAll();

    const result = await snapiStart({ tabId, baseUrl, targetCount, maxPages });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true };
  }

  if (msg.type === 'STOP_SCRAPE') {
    await snapiStop(msg.tabId);
    return { ok: true, acknowledged: true };
  }

  return { ok: false, error: 'Unknown message type: ' + msg.type };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
  return true;
});

chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) snapiResumeAll().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  snapiResumeAll().catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  snapiResumeAll().catch(() => {});
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.method !== 'GET' || details.tabId === -1) return;
    ACTIVE_SEARCH_URLS[details.tabId] = details.url;
    chrome.storage.local.set({ ['sn_url_' + details.tabId]: details.url }).catch(() => {});
  },
  { urls: ['*://www.linkedin.com/sales-api/salesApiLeadSearch*', '*://linkedin.com/sales-api/salesApiLeadSearch*'] },
  []
);

chrome.tabs.onRemoved.addListener((tabId) => {
  delete ACTIVE_SEARCH_URLS[tabId];
  chrome.storage.local.remove('sn_url_' + tabId).catch(() => {});
});