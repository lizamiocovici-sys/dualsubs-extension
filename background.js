// DualSubs — фоновый service worker: ретрансляция сообщений между фреймами,
// загрузка VTT и перевод слов/фраз с кэшированием.

const DEFAULT_SETTINGS = {
  enabled: true,
  showOriginal: true,
  showTranslation: true,
  hideNative: true,
  fontSize: 24,
  originalColor: '#ffffff',
  translationColor: '#ffd54f',
  bgOpacity: 0.55,
  bottomOffset: 12,
  subtitleHold: 2,
  cueLines: 2,
  transcriptOpen: false,
  wordTranslation: true,
  pauseOnHover: true,
  autoTranslate: true
};

const statusByTab = new Map();
const playerByPage = new Map();
const playerByTab = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get('dsSettings');
  if (!stored.dsSettings) {
    await chrome.storage.local.set({ dsSettings: DEFAULT_SETTINGS });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'DS_STATUS_REPORT': {
          const tabId = sender.tab && sender.tab.id;
          if (tabId != null) {
            statusByTab.set(tabId, msg.status);
            await safeSend(tabId, { type: 'DS_STATUS', status: msg.status }, 0);
          }
          sendResponse({ ok: true });
          break;
        }

        case 'DS_GET_STATUS': {
          sendResponse({ ok: true, status: statusByTab.get(msg.tabId) || null });
          break;
        }

        case 'DS_CUES': {
          if (sender.tab && sender.tab.id != null) {
            await safeSend(
              sender.tab.id,
              { type: 'DS_CUES', cues: msg.cues, title: msg.title || '' },
              0
            );
          }
          sendResponse({ ok: true });
          break;
        }

        case 'DS_TOGGLE_TRANSCRIPT': {
          const tabId = msg.tabId != null ? msg.tabId : sender.tab && sender.tab.id;
          if (tabId != null) {
            await safeSend(tabId, { type: 'DS_TOGGLE_TRANSCRIPT' }, 0);
          }
          sendResponse({ ok: true });
          break;
        }

        case 'DS_FULLSCREEN': {
          const tabId = msg.tabId != null ? msg.tabId : sender.tab && sender.tab.id;
          if (tabId != null) {
            await safeSend(tabId, { type: 'DS_FULLSCREEN', active: !!msg.active });
          }
          sendResponse({ ok: true });
          break;
        }

        case 'DS_ADJUST_OFFSET':
        case 'DS_RESET_OFFSET': {
          const tabId = msg.tabId != null ? msg.tabId : sender.tab && sender.tab.id;
          if (tabId != null) {
            await safeSend(tabId, {
              type: msg.type,
              delta: msg.delta,
              value: msg.value
            });
          }
          sendResponse({ ok: true });
          break;
        }

        case 'DS_ACTIVE': {
          if (sender.tab && sender.tab.id != null) {
            await safeSend(
              sender.tab.id,
              { type: 'DS_ACTIVE', index: msg.index },
              0
            );
          }
          sendResponse({ ok: true });
          break;
        }

        case 'DS_SEEK': {
          const tabId = msg.tabId != null ? msg.tabId : sender.tab && sender.tab.id;
          if (tabId != null) {
            // Без frameId — сообщение уходит во все фреймы; слушает только плеер.
            await safeSend(tabId, { type: 'DS_SEEK', time: msg.time });
          }
          sendResponse({ ok: true });
          break;
        }

        case 'DS_REGISTER_PLAYER': {
          const page = String(msg.url || '').split('#')[0];
          const player = String(msg.playerUrl || '');
          if (page && player) playerByPage.set(page, player);
          if (player && sender.tab && sender.tab.id != null) {
            playerByTab.set(sender.tab.id, player);
          }
          sendResponse({ ok: true });
          break;
        }

        case 'DS_SITE_TRACKS': {
          try {
            const pageUrl = String(msg.pageUrl || '');
            let rawPlayerUrl = String(msg.playerUrl || '');
            if (!rawPlayerUrl && sender.tab && sender.tab.id != null) {
              rawPlayerUrl = playerByTab.get(sender.tab.id) || '';
            }
            if (!rawPlayerUrl && pageUrl) {
              rawPlayerUrl = playerByPage.get(pageUrl.split('#')[0]) || '';
            }
            if (!rawPlayerUrl && pageUrl) {
              const html = await fetchText(pageUrl);
              const match = html.match(
                /https?:\/\/(?:www\.)?gencit\.info\/bil\/\d+[^"'<>\s]*/i
              );
              if (!match) {
                sendResponse({ ok: false, error: 'gencit iframe не найден' });
                break;
              }
              rawPlayerUrl = match[0];
            }
            if (!rawPlayerUrl) {
              sendResponse({ ok: false, error: 'нет адреса gencit-плеера' });
              break;
            }
            const player = new URL(rawPlayerUrl.replace(/&amp;/g, '&'));
            const season = String(msg.season || '');
            const episode = String(msg.episode || '');
            if (season) player.searchParams.set('season', season);
            if (episode) {
              player.searchParams.delete('episode');
              player.searchParams.append('episode', episode);
            }
            const playerUrl = player.toString();
            const playerHtml = await fetchText(playerUrl);
            const dataMatch = playerHtml.match(
              /window\.playerData\s*=\s*(\{[\s\S]*?\});/
            );
            if (!dataMatch) {
              sendResponse({ ok: false, error: 'playerData не найден' });
              break;
            }
            const playerData = JSON.parse(dataMatch[1]);
            const cc = (playerData.config && playerData.config.cc) || {};
            let en = '';
            let ru = '';
            if (cc.en) en = await fetchText(String(cc.en).replace(/\\\//g, '/'));
            if (cc.ru) ru = await fetchText(String(cc.ru).replace(/\\\//g, '/'));
            sendResponse({
              ok: !!(en || ru),
              en,
              ru,
              enUrl: cc.en || '',
              ruUrl: cc.ru || '',
              playerUrl
            });
          } catch (err) {
            sendResponse({ ok: false, error: String(err && err.message || err) });
          }
          break;
        }

        case 'DS_FETCH': {
          try {
            const res = await fetch(msg.url, { credentials: 'omit', cache: 'no-store' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            sendResponse({ ok: true, text: await res.text() });
          } catch (err) {
            sendResponse({ ok: false, error: String(err && err.message || err) });
          }
          break;
        }

        case 'DS_TRANSLATE': {
          sendResponse(await translateText(msg.text, msg.from || 'en', msg.to || 'ru'));
          break;
        }

        case 'DS_IMPORT_TRACKS': {
          const tabId = msg.tabId != null ? msg.tabId : sender.tab && sender.tab.id;
          if (tabId != null) {
            await safeSend(tabId, {
              type: 'DS_IMPORT_TRACKS',
              en: msg.en || '',
              ru: msg.ru || ''
            });
          }
          sendResponse({ ok: true });
          break;
        }

        case 'DS_SETTINGS_CHANGED': {
          const tabId = msg.tabId != null ? msg.tabId : sender.tab && sender.tab.id;
          if (tabId != null) {
            await safeSend(tabId, { type: 'DS_SETTINGS' });
          }
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ ok: false, error: 'Неизвестное сообщение: ' + msg.type });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message || err) });
    }
  })();
  return true; // асинхронный ответ
});

async function safeSend(tabId, message, frameId) {
  try {
    const options = frameId === undefined ? undefined : { frameId };
    await chrome.tabs.sendMessage(tabId, message, options);
  } catch (_) {
    // Фрейм мог уже закрыться или перейти на другую страницу — игнорируем.
  }
}

async function fetchText(url) {
  const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

async function translateText(text, from, to) {
  if (!text || !text.trim()) return { ok: true, text: '' };

  const cacheKey = from + '-' + to + '::' + text;
  const stored = await chrome.storage.local.get('ds_translation_cache');
  const cache = stored.ds_translation_cache || {};
  if (cache[cacheKey]) {
    return { ok: true, text: cache[cacheKey], cached: true };
  }

  let result = '';
  let firstError = '';

  // Основной провайдер — публичный endpoint Google Translate, без ключа.
  try {
    const url =
      'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' +
      encodeURIComponent(from) +
      '&tl=' +
      encodeURIComponent(to) +
      '&dt=t&q=' +
      encodeURIComponent(text);
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error('Google Translate: HTTP ' + res.status);
    const json = await res.json();
    result = ((json && json[0]) || [])
      .map((part) => (part && part[0]) || '')
      .join('')
      .trim();
    if (!result) throw new Error('Пустой ответ Google Translate');
  } catch (err) {
    firstError = String(err && err.message || err);
  }

  // Резервный провайдер — MyMemory.
  if (!result) {
    try {
      const url =
        'https://api.mymemory.translated.net/get?q=' +
        encodeURIComponent(text) +
        '&langpair=' +
        encodeURIComponent(from + '|' + to);
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) throw new Error('MyMemory: HTTP ' + res.status);
      const json = await res.json();
      result = String((json && json.responseData && json.responseData.translatedText) || '').trim();
      if (!result) throw new Error('Пустой ответ MyMemory');
    } catch (err) {
      return {
        ok: false,
        error: firstError + '; ' + String(err && err.message || err)
      };
    }
  }

  cache[cacheKey] = result;
  const keys = Object.keys(cache);
  if (keys.length > 3000) {
    for (const key of keys.slice(0, keys.length - 2000)) delete cache[key];
  }
  await chrome.storage.local.set({ ds_translation_cache: cache });

  return { ok: true, text: result };
}
