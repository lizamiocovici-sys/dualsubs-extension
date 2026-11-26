// DualSubs — контент-скрипт для iframe плеера (gencit.info, cdnlbox.club, api.embf.net).
// Берём обе VTT-дорожки из конфигурации плеера, рисуем двойные субтитры,
// переводим слово при наведении, фразу — по выделению, и отправляем расшифровку
// на основную страницу.

(function () {
  'use strict';

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

  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let video = null;
  let cuesEn = [];
  let cuesRu = [];
  let overlay = null;
  let originalEl = null;
  let translationEl = null;
  let toolbar = null;
  let currentIndex = -1;
  let wordCard = null;
  let hoverCard = null;
  let hoverWord = null;
  let hoverTimer = null;
  let suppressClick = false;
  let prefetchToken = 0;
  let lastNativeDisable = 0;
  let wasPlayingBeforeHover = false;
  let pausedByHover = false;
  let toastTimer = null;
  let subtitleOffset = 0;
  let offsetKey = '';
  let trackSource = '';
  let lastSourceSignature = '';
  let pageUrl = '';
  let sitePlayerUrl = '';
  let siteTrackError = '';
  let fsPanel = null;
  let fsListEl = null;
  let fsToggle = null;
  let parentFullscreen = false;
  let sideBySideNode = null;
  let sideBySideRoot = null;
  const sideBySideOriginal = new WeakMap();
  const translationMemory = new Map();
  const pendingTranslations = new Map();

  init();

  async function init() {
    settings = await loadSettings();
    await loadOffset();
    requestPageUrl();
    await waitForPageUrl(2500);

    // Работаем только внутри страницы subtitle.love. Прямое открытие плеера,
    // GitHub и любые другие сайты должны оставаться без расширения.
    if (!isAllowedContext()) {
      reportStatus(false, 0, 0, 'DualSubs работает только на subtitle.love');
      return;
    }

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.dsSettings) {
        settings = Object.assign({}, DEFAULT_SETTINGS, changes.dsSettings.newValue || {});
        applySettings();
      }
    });

    const tracks = await findTracks(6000);
    trackSource = tracks.source || '';
    if (tracks.en) cuesEn = await loadVtt(tracks.en.url);
    if (tracks.ru) cuesRu = await loadVtt(tracks.ru.url);

    video = await waitForVideo(15000);

    // Универсальный путь: у cdnlbox и части embf ссылок на VTT в HTML нет,
    // но субтитры всё равно висят на <video> как текстовые дорожки.
    if (video && (!cuesEn.length || !cuesRu.length)) {
      const fromTracks = await waitForTextTracks(9000);
      if (!cuesEn.length && fromTracks.en.length) {
        cuesEn = fromTracks.en;
        trackSource = 'textTracks';
      }
      if (!cuesRu.length && fromTracks.ru.length) {
        cuesRu = fromTracks.ru;
        trackSource = 'textTracks';
      }
      watchTextTracks();
    }

    // Дорожки из конфигурации плеера часто остаются от первой серии,
    // поэтому при возможности берём обе из gencit для текущего эпизода.
    await waitForPageUrl(1500);
    const siteTracks = await loadSiteTracks();
    if (siteTracks) {
      if (siteTracks.en.length && siteTracks.ru.length) {
        cuesEn = siteTracks.en;
        cuesRu = siteTracks.ru;
        trackSource = 'site';
      } else {
        if (!cuesEn.length && siteTracks.en.length) {
          cuesEn = siteTracks.en;
          trackSource = 'site';
        }
        if (!cuesRu.length && siteTracks.ru.length) {
          cuesRu = siteTracks.ru;
          trackSource = 'site';
        }
      }
    }

    if (!cuesEn.length && !cuesRu.length) {
      const note = 'Дорожки не найдены' + (siteTrackError ? ': ' + siteTrackError : '');
      reportStatus(false, 0, 0, note);
      // Всё равно вешаем обработчик импорта — пользователь может загрузить свои VTT.
      chrome.runtime.onMessage.addListener(handleMessage);
      if (video) watchTextTracks();
      return;
    }

    setupOverlay();
    setupFullscreenPanel();
    applySettings();
    markNativeSubtitles();
    reportStatus(true, cuesEn.length, cuesRu.length, '');
    sendTranscript();

    chrome.runtime.onMessage.addListener(handleMessage);
    document.addEventListener('keydown', handleHotkey);
    watchEpisodeChanges();
    requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------------------
  // Поиск дорожек субтитров
  // ---------------------------------------------------------------------------

  // Конфигурация плеера иногда появляется позже document_idle — ждём её немного.
  async function findTracks(timeoutMs) {
    const started = Date.now();
    let tracks = findTracksOnce();
    while ((!tracks.en || !tracks.ru) && Date.now() - started < (timeoutMs || 0)) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      tracks = findTracksOnce();
    }
    return tracks;
  }

  function findTracksOnce() {
    const tracks = { en: null, ru: null };

    // 1. Плеер gencit / ceramet: window.playerData.config.cc = { ru, en, ua }
    try {
      const cc = window.playerData && window.playerData.config && window.playerData.config.cc;
      if (cc && typeof cc === 'object') {
        for (const key of Object.keys(cc)) {
          const url = cc[key];
          if (typeof url !== 'string') continue;
          const lower = key.toLowerCase();
          // Украинская дорожка нам не нужна: она часто стоит в плеере по умолчанию.
          if (lower === 'ua' || lower === 'uk' || /укр|українсь|ukrain/.test(lower)) continue;
          if (lower === 'ru' || /рус|russian|^\bru\b/.test(lower)) {
            tracks.ru = { url: normalizeUrl(url), name: key };
          } else if (lower === 'en' || /eng|english|original|оригинал/.test(lower)) {
            tracks.en = { url: normalizeUrl(url), name: key };
          }
        }
        if (tracks.en || tracks.ru) tracks.source = 'playerData';
      }
    } catch (_) {}

    // 2. Плеер embf /Venom: makePlayer({ playlist: { seasons: [ ... cc: [...] ] } })
    if (!tracks.en || !tracks.ru) {
      try {
        const html = document.documentElement.outerHTML;
        const re = /"cc"\s*:\s*(\[)/g;
        let match;
        while ((match = re.exec(html))) {
          const jsonText = extractBalanced(html, match.index + match[0].length - 1, '[', ']');
          if (!jsonText) continue;
          let arr;
          try {
            arr = JSON.parse(jsonText);
          } catch (_) {
            continue;
          }
          for (const item of arr) {
            if (!item || !item.url) continue;
            const name = String(item.name || '');
            if (/\bua\b|\buk\b|ukrain|укр|українсь/i.test(name + ' ' + item.url)) continue;
            const lang = classifyTrack(name, item.url);
            if (lang === 'en' && !tracks.en) {
              tracks.en = { url: normalizeUrl(item.url), name };
            } else if (
              lang === 'ru' &&
              !tracks.ru &&
              !/форсирован|forced/i.test(name)
            ) {
              tracks.ru = { url: normalizeUrl(item.url), name };
            }
          }
          if (tracks.en && tracks.ru) break;
        }
        if (tracks.en || tracks.ru) tracks.source = tracks.source || 'cc-array';
      } catch (_) {}
    }

    // 3. Нативные <track> у <video>
    if (!tracks.en || !tracks.ru) {
      const nodes = document.querySelectorAll('track');
      for (const node of nodes) {
        const lang = classifyTrack(node.label || '', node.srclang || '', node.src || '');
        if (lang === 'en' && !tracks.en) tracks.en = { url: node.src, name: node.label || 'en' };
        if (lang === 'ru' && !tracks.ru) tracks.ru = { url: node.src, name: node.label || 'ru' };
      }
      if (tracks.en || tracks.ru) tracks.source = tracks.source || 'track-element';
    }

    // 4. Эвристика по всем .vtt-ссылкам в разметке/скриптах
    if (!tracks.en || !tracks.ru) {
      try {
        const html = document.documentElement.outerHTML.replace(/\\\//g, '/');
        const re = /https?:\/\/[^\s"'<>]+\.vtt[^\s"'<>]*/gi;
        let match;
        while ((match = re.exec(html))) {
          const url = match[0].replace(/&amp;/g, '&');
          const lang = classifyTrack('', url);
          if (lang === 'en' && !tracks.en) tracks.en = { url, name: 'en' };
          if (lang === 'ru' && !tracks.ru) tracks.ru = { url, name: 'ru' };
        }
        if (tracks.en || tracks.ru) tracks.source = tracks.source || 'vtt-scan';
      } catch (_) {}
    }

    return tracks;
  }

  function normalizeUrl(url) {
    return String(url).replace(/\\\//g, '/').replace(/&amp;/g, '&');
  }

  function classifyTrack() {
    const s = Array.prototype.join.call(arguments, ' ').toLowerCase();
    // Сначала отсекаем украинский: он тоже написан кириллицей.
    if (/\bua\b|\buk\b|ukrain|укр|українсь/.test(s)) return '';
    const isRu = /[\u0400-\u04ff]|\bru\b|\brus\b|russian|\bрус/.test(s);
    const isEn =
      /\ben\b|\beng\b|english|original|оригинал/.test(s) ||
      (!isRu && /[_-]en[_-]|\/en[_-]|\ben_/.test(s));
    if (isRu) return 'ru';
    if (isEn) return 'en';
    return '';
  }

  function extractBalanced(text, start, openChar, closeChar) {
    let depth = 0;
    let inString = false;
    let quote = '';
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === quote) {
          inString = false;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = true;
        quote = ch;
      } else if (ch === openChar) {
        depth++;
      } else if (ch === closeChar) {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return '';
  }

  // ---------------------------------------------------------------------------
  // Загрузка и разбор VTT
  // ---------------------------------------------------------------------------

  async function loadVtt(url) {
    if (!url) return [];
    let raw = '';
    const response = await sendMessage({ type: 'DS_FETCH', url });
    if (response && response.ok) {
      raw = response.text;
    } else {
      try {
        const res = await fetch(url, { credentials: 'omit' });
        if (res.ok) raw = await res.text();
      } catch (_) {}
    }
    return parseVtt(raw);
  }

  // Родительская страница отдаёт свой адрес, если referrer не дошёл в iframe.
  function requestPageUrl() {
    try {
      window.addEventListener('message', (event) => {
        const data = event && event.data;
        if (data && data.type === 'DS_PAGE_URL' && data.url) {
          pageUrl = String(data.url);
          if (data.playerUrl) sitePlayerUrl = String(data.playerUrl);
        }
      });
      // Родительский скрипт может ещё не успеть повесить слушатель — повторяем.
      const ask = () => {
        if (pageUrl) return;
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'DS_REQUEST_PAGE_URL' }, '*');
        }
      };
      ask();
      const timer = setInterval(ask, 500);
      setTimeout(() => clearInterval(timer), 12000);
    } catch (_) {}
  }

  function isAllowedContext() {
    const inFrame = !!(window.parent && window.parent !== window);
    const url = String(pageUrl || document.referrer || '');
    return inFrame && /subtitle\.love/i.test(url);
  }

  async function waitForPageUrl(timeoutMs) {
    const started = Date.now();
    while (!pageUrl && Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return pageUrl;
  }

  function currentSeasonEpisode() {
    let urlSeason = '';
    let urlEpisode = '';
    try {
      const url = new URL(location.href);
      urlSeason = url.searchParams.get('season') || '';
      urlEpisode = url.searchParams.get('episode') || '';
    } catch (_) {}

    // gencit меняет серию внутри плеера, не меняя адрес: смотрим в playlist.
    try {
      const serial =
        window.playerData &&
        window.playerData.playlist &&
        window.playerData.playlist.serial &&
        window.playerData.playlist.serial.current;
      if (serial && (serial.season || serial.episode)) {
        return {
          season: String(serial.season || urlSeason || ''),
          episode: String(serial.episode || urlEpisode || '')
        };
      }
    } catch (_) {}

    try {
      const cfg = window.playerData && window.playerData.config;
      const title = String(
        cfg && (cfg.title || (cfg.playlist && cfg.playlist.current && cfg.playlist.current.title)) ||
          document.title ||
          ''
      );
      const match = title.match(
        /(?:s|season)\s*(\d{1,2})\s*(?:e|episode|series)?\s*(\d{1,2})|(\d{1,2})\s*(?:серия|эпизод)/i
      );
      if (match) {
        return {
          season: String(match[1] || urlSeason || ''),
          episode: String(match[2] || match[3] || urlEpisode || '')
        };
      }
    } catch (_) {}

    return { season: urlSeason, episode: urlEpisode };
  }

  // Если в текущем плеере нет нужного языка, берём его из gencit-iframes страницы.
  async function loadSiteTracks() {
    const url = String(pageUrl || document.referrer || '');
    // Адрес страницы нужен только для запасного разбора HTML. Основной путь —
    // уже зарегистрированный фоном адрес gencit (по вкладке или по странице).
    if (!sitePlayerUrl && (!url || !/subtitle\.love/i.test(url))) {
      siteTrackError = 'нет адреса страницы и gencit-плеера';
      return null;
    }
    const { season, episode } = currentSeasonEpisode();
    const response = await sendMessage({
      type: 'DS_SITE_TRACKS',
      pageUrl: url,
      playerUrl: sitePlayerUrl,
      season,
      episode
    });
    if (!response || !response.ok) {
      siteTrackError = String(response && response.error || 'ошибка загрузки');
      return null;
    }
    siteTrackError = '';
    return {
      en: parseVtt(response.en || ''),
      ru: parseVtt(response.ru || '')
    };
  }

  function parseVtt(raw) {
    const text = String(raw || '')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n');
    const blocks = text.split(/\n{2,}/);
    const result = [];
    const timingRe =
      /(\d{1,3}:\d{2}(?::\d{2})?[.,]\d{1,3})\s*-->\s*(\d{1,3}:\d{2}(?::\d{2})?[.,]\d{1,3})/;

    for (const block of blocks) {
      const lines = block.split('\n').filter((line) => line.trim());
      if (!lines.length) continue;
      const timeIndex = lines.findIndex((line) => timingRe.test(line));
      if (timeIndex < 0) continue;
      const match = lines[timeIndex].match(timingRe);
      if (!match) continue;
      const body = lines.slice(timeIndex + 1).join('\n');
      const cleaned = cleanVttText(body);
      if (!cleaned) continue;
      result.push({
        start: parseTime(match[1]),
        end: parseTime(match[2]),
        text: cleaned
      });
    }
    return result;
  }

  function parseTime(value) {
    const parts = value.replace(',', '.').split(':').map(Number);
    let seconds = 0;
    for (const part of parts) seconds = seconds * 60 + (part || 0);
    return seconds;
  }

  function cleanVttText(value) {
    return String(value || '')
      .replace(/<\/?c[^>]*>|<\/?v[^>]*>|<\/?[ib]>|<\/?lang[^>]*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ---------------------------------------------------------------------------
  // Наложение субтитров и синхронизация
  // ---------------------------------------------------------------------------

  function waitForVideo(timeoutMs) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const found = document.querySelector('video');
        if (found) return resolve(found);
        if (Date.now() - started > timeoutMs) return resolve(null);
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  // Плеер при смене серии часто удаляет старый <video> и создаёт новый.
  // Если не обновить ссылку, остаёмся на старых репликах и старом времени.
  function ensureVideo() {
    const found = document.querySelector('video');
    if (!found) return false;
    if (found !== video) {
      video = found;
      lastNativeDisable = 0;
      try {
        video.addEventListener('voicesubtitleschange', () => disableNativeTracks(true));
      } catch (_) {}
      disableNativeTracks(true);
      return true;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Синхронизация субтитров. Сдвиг сохраняется отдельно для каждого эпизода.
  // ---------------------------------------------------------------------------

  function computeOffsetKey() {
    try {
      const url = new URL(location.href);
      const parts = [url.hostname, url.pathname];
      for (const param of ['video_id', 'season', 'episode', 'id', 'token_movie']) {
        if (url.searchParams.has(param)) parts.push(param + '=' + url.searchParams.get(param));
      }
      const videoId = window.playerData && window.playerData.config && window.playerData.config.video_id;
      if (videoId) parts.push('v=' + videoId);
      const current = currentSeasonEpisode();
      if (current.season) parts.push('s=' + current.season);
      if (current.episode) parts.push('e=' + current.episode);
      return parts.join('|');
    } catch (_) {
      return location.href;
    }
  }

  async function loadOffset() {
    offsetKey = computeOffsetKey();
    try {
      const stored = await chrome.storage.local.get('ds_offsets');
      const map = stored.ds_offsets || {};
      const value = Number(map[offsetKey]);
      subtitleOffset = Number.isFinite(value) ? Math.max(-30, Math.min(30, value)) : 0;
    } catch (_) {
      subtitleOffset = 0;
    }
  }

  async function setOffset(value) {
    const number = Number(value);
    subtitleOffset = Number.isFinite(number)
      ? Math.max(-30, Math.min(30, Math.round(number * 10) / 10))
      : 0;
    try {
      const stored = await chrome.storage.local.get('ds_offsets');
      const map = stored.ds_offsets || {};
      if (subtitleOffset === 0) delete map[offsetKey];
      else map[offsetKey] = subtitleOffset;
      await chrome.storage.local.set({ ds_offsets: map });
    } catch (_) {}
    // Форсируем перерисовку даже если сдвиг не поменял индекс реплики.
    currentIndex = -999;
    reportStatus(!!(cuesEn.length || cuesRu.length), cuesEn.length, cuesRu.length, '');
    showToast('Сдвиг субтитров: ' + formatOffset(subtitleOffset));
  }

  function formatOffset(value) {
    const rounded = Math.round(Number(value || 0) * 10) / 10;
    return (rounded > 0 ? '+' : '') + rounded.toFixed(1) + ' с';
  }

  // Читаем реплики прямо из TextTrack / remoteTextTrack — работает во всех трёх плеерах.
  function readTextTracks() {
    const result = { en: [], ru: [] };
    if (!video) return result;

    const lists = [];
    try {
      if (video.textTracks) lists.push(video.textTracks);
    } catch (_) {}
    try {
      if (video.remoteTextTracks) lists.push(video.remoteTextTracks());
    } catch (_) {}

    for (const list of lists) {
      for (let i = 0; i < list.length; i++) {
        const track = list[i];
        if (!track) continue;
        const lang = classifyTrack(
          track.label || '',
          track.language || '',
          track.id || ''
        );
        if (!lang || result[lang].length) continue;

        let cueList = [];
        try {
          if (!track.cues || !track.cues.length) track.mode = 'hidden';
          cueList = Array.from(track.cues || []);
        } catch (_) {}

        const parsed = cueList
          .map((cue) => ({
            start: Number(cue.startTime) || 0,
            end: Number(cue.endTime) || 0,
            text: cleanVttText(cue.text || '')
          }))
          .filter((cue) => cue.text && cue.end > cue.start);

        if (parsed.length) result[lang] = parsed;
      }
    }
    return result;
  }

  async function waitForTextTracks(timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = readTextTracks();
      if (found.en.length || found.ru.length) return found;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return { en: [], ru: [] };
  }

  function watchTextTracks() {
    if (!video || !video.textTracks || watchTextTracks.watching) return;
    watchTextTracks.watching = true;

    const handler = () => {
      const found = readTextTracks();
      let changed = false;
      if (!cuesEn.length && found.en.length) {
        cuesEn = found.en;
        changed = true;
      }
      if (!cuesRu.length && found.ru.length) {
        cuesRu = found.ru;
        changed = true;
      }
      if (changed) refreshAll();
    };

    const attach = (track) => {
      try {
        if (track) track.addEventListener('load', handler);
      } catch (_) {}
    };
    const onAdd = (event) => {
      attach(event && event.track);
      handler();
    };

    try {
      Array.from(video.textTracks || []).forEach(attach);
      video.textTracks.addEventListener('addtrack', onAdd);
      video.textTracks.addEventListener('change', handler);
      if (video.remoteTextTracks) {
        const remote = video.remoteTextTracks();
        Array.from(remote || []).forEach(attach);
        remote.addEventListener('addtrack', onAdd);
      }
    } catch (_) {}
  }

  function refreshAll() {
    if (!overlay && video) {
      setupOverlay();
      markNativeSubtitles();
      requestAnimationFrame(loop);
    }
    if (!fsPanel) setupFullscreenPanel();
    applySettings();
    currentIndex = -1;
    reportStatus(true, cuesEn.length, cuesRu.length, '');
    sendTranscript();
    renderActive();
  }

  // Плеер часто меняет эпизод без перезагрузки документа (кнопка «следующая серия»).
  // Если подпись дорожек изменилась — перечитаем их и сдвиг для нового эпизода.
  function sourceSignature() {
    const cfg = window.playerData && window.playerData.config;
    const cc = (cfg && cfg.cc) || {};
    const serial =
      window.playerData &&
      window.playerData.playlist &&
      window.playerData.playlist.serial &&
      window.playerData.playlist.serial.current;
    return [
      location.href,
      String(cfg && cfg.video_id || ''),
      String(cfg && cfg.video || ''),
      String(cc.en || ''),
      String(cc.ru || ''),
      String(serial && serial.season || ''),
      String(serial && serial.episode || ''),
      String(serial && serial.voiceId || ''),
      String(video && (video.currentSrc || video.src) || ''),
      String(document.title || '')
    ].join('|');
  }

  function watchEpisodeChanges() {
    lastSourceSignature = sourceSignature();
    setInterval(async () => {
      if (!ensureVideo() || !settings.enabled) return;
      const signature = sourceSignature();
      if (signature === lastSourceSignature) return;
      lastSourceSignature = signature;

      const tracks = await findTracks(3000);
      let en = tracks.en ? await loadVtt(tracks.en.url) : [];
      let ru = tracks.ru ? await loadVtt(tracks.ru.url) : [];

      if ((!en.length || !ru.length) && video) {
        const from = await waitForTextTracks(5000);
        if (!en.length) en = from.en;
        if (!ru.length) ru = from.ru;
      }
      // При смене эпизода локальный конфиг может остаться прежним — доверяем site.
      const siteTracks = await loadSiteTracks();
      let usedSite = false;
      if (siteTracks) {
        if (siteTracks.en.length && siteTracks.ru.length) {
          en = siteTracks.en;
          ru = siteTracks.ru;
          usedSite = true;
        } else {
          if (!en.length) en = siteTracks.en;
          if (!ru.length) ru = siteTracks.ru;
          usedSite = !!(siteTracks.en.length || siteTracks.ru.length);
        }
      }
      if (!en.length && !ru.length) return;

      cuesEn = en;
      cuesRu = ru;
      trackSource = usedSite ? 'site' : (tracks.source || (en.length || ru.length ? 'textTracks' : ''));
      await loadOffset(); // сдвиг может быть другим у нового эпизода
      refreshAll();
      showToast('Субтитры обновлены для нового эпизода');
    }, 2000);
  }

  //Панель «Диалоги» внутри iframe: в полноэкранном режиме видна только она.
  function setupFullscreenPanel() {
    if (fsPanel) return;

    fsPanel = document.createElement('div');
    fsPanel.className = 'ds-fspanel';

    const header = document.createElement('div');
    header.className = 'ds-fspanel-header';
    const title = document.createElement('span');
    title.textContent = 'Диалоги';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ds-fspanel-close';
    close.textContent = '×';
    close.title = 'Закрыть';
    close.addEventListener('click', () => toggleFsPanel(false));
    header.appendChild(title);
    header.appendChild(close);

    const searchWrap = document.createElement('div');
    searchWrap.className = 'ds-fspanel-search';
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Поиск по репликам';
    search.addEventListener('input', renderFullscreenList);
    searchWrap.appendChild(search);

    fsListEl = document.createElement('div');
    fsListEl.className = 'ds-fspanel-list';
    fsListEl.addEventListener('mouseover', handleOriginalMouseOver);
    fsListEl.addEventListener('mouseleave', () => {
      hideHoverCard();
      resumeAfterHover(false);
    });
    fsListEl.addEventListener('click', (event) => {
      const word = event.target && event.target.closest
        ? event.target.closest('.ds-word')
        : null;
      if (!word) return;
      event.stopPropagation();
      handleOriginalClick(event);
    }, true);

    fsPanel.appendChild(header);
    fsPanel.appendChild(searchWrap);
    fsPanel.appendChild(fsListEl);
    uiRoot().appendChild(fsPanel);

    fsToggle = document.createElement('button');
    fsToggle.type = 'button';
    fsToggle.className = 'ds-fspanel-toggle';
    fsToggle.textContent = 'Д';
    fsToggle.title = 'Диалоги';
    fsToggle.addEventListener('click', () => toggleFsPanel());
    uiRoot().appendChild(fsToggle);

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    handleFullscreenChange();
    renderFullscreenList();
  }

  function renderFullscreenList() {
    if (!fsListEl) return;
    hideHoverCard();
    hoverWord = null;
    const input = fsPanel.querySelector('.ds-fspanel-search input');
    const query = (input && input.value || '').trim().toLowerCase();
    const base = cuesEn.length ? cuesEn : cuesRu;
    const fragment = document.createDocumentFragment();

    base.forEach((cue, index) => {
      const ru = cuesEn.length ? findRussianFor(cue) : '';
      const haystack = ((cue.text || '') + ' ' + ru).toLowerCase();
      if (query && haystack.indexOf(query) < 0) return;

      const item = document.createElement('div');
      item.className = 'ds-fspanel-item';
      item.dataset.index = String(index);

      const time = document.createElement('span');
      time.className = 'ds-fspanel-time';
      time.textContent = formatTime(cue.start);

      const body = document.createElement('div');
      body.className = 'ds-fspanel-body';

      const en = document.createElement('div');
      en.className = 'ds-fspanel-en';
      en.replaceChildren(renderWords(cue.text || ''));

      body.appendChild(en);
      if (ru) {
        const translated = document.createElement('div');
        translated.className = 'ds-fspanel-ru';
        translated.textContent = ru;
        body.appendChild(translated);
      }

      item.appendChild(time);
      item.appendChild(body);
      item.addEventListener('click', () => {
        if (video) {
          video.currentTime = Math.max(0, cue.start - subtitleOffset - 0.15);
          const attempt = video.play();
          if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {});
        }
        highlightFullscreenActive(index);
      });
      fragment.appendChild(item);
    });

    fsListEl.replaceChildren(fragment);
    highlightFullscreenActive(currentIndex);
  }

  function highlightFullscreenActive(index) {
    if (!fsListEl) return;
    const active = fsListEl.querySelector('.ds-fspanel-item[data-index="' + index + '"]');
    for (const item of fsListEl.querySelectorAll('.ds-fspanel-item')) {
      item.classList.remove('is-active');
    }
    if (!active) return;
    active.classList.add('is-active');
    try {
      active.scrollIntoView({ block: 'nearest' });
    } catch (_) {}
  }

  // В полноэкранном режиме браузер рисует только поддерево fullscreen-элемента.
  // Поэтому переносим свои слои внутрь него, иначе они просто не видны.
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement || parentFullscreen);
  }

  function uiRoot() {
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (fs && fs !== document.body && fs.tagName !== 'VIDEO') return fs;
    if (fs && fs.tagName === 'VIDEO' && fs.parentElement) return fs.parentElement;
    return document.body || document.documentElement;
  }

  // Панель слева, картинка справа — без наложения на видео.
  function applySideBySide(open) {
    if (!open) {
      if (sideBySideRoot) sideBySideRoot.classList.remove('ds-side');
      if (sideBySideNode) {
        const old = sideBySideOriginal.get(sideBySideNode);
        if (old) {
          sideBySideNode.style.marginLeft = old.marginLeft;
          sideBySideNode.style.width = old.width;
          sideBySideNode.style.maxWidth = old.maxWidth;
          sideBySideNode.style.transition = old.transition;
          sideBySideOriginal.delete(sideBySideNode);
        }
      }
      sideBySideNode = null;
      sideBySideRoot = null;
      return;
    }
    if (!isFullscreen()) return;

    const root = uiRoot();
    let node = document.querySelector('video');
    if (!node) return;
    while (node.parentElement && node.parentElement !== root) node = node.parentElement;
    if (node === root) return;

    if (!sideBySideOriginal.has(node)) {
      sideBySideOriginal.set(node, {
        marginLeft: node.style.marginLeft,
        width: node.style.width,
        maxWidth: node.style.maxWidth,
        transition: node.style.transition
      });
    }
    sideBySideRoot = root;
    sideBySideNode = node;
    root.classList.add('ds-side');
    node.style.transition = 'margin-left 0.2s ease, width 0.2s ease';
    node.style.marginLeft = '372px';
    node.style.width = 'calc(100% - 372px)';
    node.style.maxWidth = 'none';
  }

  function mountUi() {
    const root = uiRoot();
    const toast = document.querySelector('.ds-toast');
    for (const node of [overlay, fsPanel, fsToggle, hoverCard, wordCard, toast]) {
      if (node && node.parentElement !== root) root.appendChild(node);
    }
  }

  function handleFullscreenChange() {
    const active = !!(document.fullscreenElement || document.webkitFullscreenElement);
    parentFullscreen = parentFullscreen || active;
    const root = document.body || document.documentElement;
    root.classList.toggle('ds-fullscreen', active || parentFullscreen);
    mountUi();
    if (!active && !parentFullscreen && fsPanel) toggleFsPanel(false);
    if ((active || parentFullscreen) && fsPanel && settings.transcriptOpen) toggleFsPanel(true);
  }

  function toggleFsPanel(force) {
    if (!fsPanel) return;
    const open = force === undefined ? !fsPanel.classList.contains('is-open') : !!force;
    fsPanel.classList.toggle('is-open', open);
    if (fsToggle) fsToggle.classList.toggle('is-open', open);
    applySideBySide(open);
  }

  function setupOverlay() {
    // У cdnlbox родитель видео обрезает потомков — держим слой на body.
    overlay = document.createElement('div');
    overlay.className = 'ds-overlay';

    originalEl = document.createElement('div');
    originalEl.className = 'ds-original';

    translationEl = document.createElement('div');
    translationEl.className = 'ds-translation';

    toolbar = document.createElement('div');
    toolbar.className = 'ds-toolbar';
    toolbar.appendChild(makeToolButton('О', 'Оригинал (Alt+S)', () => {
      settings.showOriginal = !settings.showOriginal;
      persistSettings();
    }));
    toolbar.appendChild(makeToolButton('Р', 'Перевод (Alt+D)', () => {
      settings.showTranslation = !settings.showTranslation;
      persistSettings();
    }));
    toolbar.appendChild(makeToolButton('Ф', 'Перевести фразу целиком', () => {
      const phrase = currentCueText();
      if (phrase) openPhraseCard(phrase, toolbar);
    }));
    toolbar.appendChild(makeToolButton('Д', 'Диалоги (Alt+T)', () => {
      if (document.body.classList.contains('ds-fullscreen')) toggleFsPanel();
      sendMessage({ type: 'DS_TOGGLE_TRANSCRIPT' });
    }));

    overlay.appendChild(toolbar);
    overlay.appendChild(originalEl);
    overlay.appendChild(translationEl);
    uiRoot().appendChild(overlay);

    originalEl.addEventListener('click', handleOriginalClick);
    originalEl.addEventListener('mouseover', handleOriginalMouseOver);
    originalEl.addEventListener('mouseleave', () => {
      hideHoverCard();
      resumeAfterHover(false);
    });
    originalEl.addEventListener('mouseup', handleOriginalMouseUp);

    // Плеер может заново включить свою дорожку при смене голоса/озвучки.
    try {
      video.addEventListener('voicesubtitleschange', () => disableNativeTracks(true));
    } catch (_) {}
    disableNativeTracks(true);
  }

  function makeToolButton(label, title, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ds-tool-button';
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  function markNativeSubtitles() {
    document.documentElement.classList.add('ds-active');
    disableNativeTracks(true);
  }

  // Надёжнее, чем CSS: выключаем текстовые дорожки самого плеера (в том числе UA).
  function disableNativeTracks(force) {
    if (!settings.hideNative || !video) return;
    const now = Date.now();
    if (!force && now - lastNativeDisable < 700) return;
    lastNativeDisable = now;

    const lists = [];
    try {
      if (video.textTracks) lists.push(video.textTracks);
    } catch (_) {}
    try {
      if (video.remoteTextTracks) lists.push(video.remoteTextTracks());
    } catch (_) {}

    for (const list of lists) {
      for (let i = 0; i < list.length; i++) {
        const track = list[i];
        if (!track) continue;
        const kind = String(track.kind || '').toLowerCase();
        if (kind !== 'captions' && kind !== 'subtitles') continue;
        if (track.mode !== 'disabled') {
          try {
            track.mode = 'disabled';
          } catch (_) {}
        }
      }
    }
  }

  function applySettings() {
    document.documentElement.classList.toggle('ds-active', !!(settings.enabled && settings.hideNative));
    if (!overlay) return;
    overlay.style.display = settings.enabled ? '' : 'none';
    originalEl.style.display = settings.showOriginal ? '' : 'none';
    translationEl.style.display = settings.showTranslation ? '' : 'none';
    overlay.style.fontSize = settings.fontSize + 'px';
    overlay.style.bottom = settings.bottomOffset + 'px';
    let alpha = Number(settings.bgOpacity);
    if (!Number.isFinite(alpha)) alpha = 0.55;
    if (alpha > 1) alpha = alpha / 100;
    overlay.style.background = 'rgba(0, 0, 0, ' + Math.max(0, Math.min(1, alpha)) + ')';
    originalEl.style.color = settings.originalColor;
    translationEl.style.color = settings.translationColor;
  }

  function loop() {
    requestAnimationFrame(loop);
    if (!ensureVideo() || !overlay || !settings.enabled) return;
    disableNativeTracks(false);
    const index = findActiveIndex(video.currentTime + subtitleOffset);
    if (index !== currentIndex) {
      currentIndex = index;
      renderActive();
      sendMessage({ type: 'DS_ACTIVE', index: currentIndex });
    }
  }

  function findActiveIndex(time) {
    const list = cuesEn.length ? cuesEn : cuesRu;
    if (!list.length) return -1;
    let low = 0;
    let high = list.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (list[mid].start <= time + 0.08) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const hold = Number(settings.subtitleHold);
    const extra = Number.isFinite(hold) ? Math.max(0, Math.min(5, hold)) : 2;
    if (found >= 0 && time <= list[found].end + extra) return found;
    return -1;
  }

  function renderActive() {
    highlightFullscreenActive(currentIndex);
    if (!originalEl || !translationEl) return;
    if (currentIndex < 0) {
      originalEl.replaceChildren();
      translationEl.replaceChildren();
      return;
    }

    const list = cuesEn.length ? cuesEn : cuesRu;
    const lines = Math.max(1, Math.min(3, Number(settings.cueLines) || 1));
    const items = [];
    for (let i = currentIndex; i < list.length && items.length < lines; i++) {
      // Не показываем реплику из далёкого будущего: только идущую сразу за текущей.
      if (i > currentIndex && list[i].start - list[i - 1].end > 3) break;
      items.push({ cue: list[i], index: i });
    }

    originalEl.replaceChildren();
    translationEl.replaceChildren();
    if (!items.length) return;

    const renderedIndex = currentIndex;
    const prefetchBatch = ++prefetchToken;

    for (const item of items) {
      const enBlock = document.createElement('div');
      enBlock.className = 'ds-cue-en';
      if (!cuesEn.length) enBlock.textContent = item.cue.text;
      else enBlock.replaceChildren(renderWords(item.cue.text));
      originalEl.appendChild(enBlock);

      const ruBlock = document.createElement('div');
      ruBlock.className = 'ds-cue-ru';
      translationEl.appendChild(ruBlock);

      if (!cuesEn.length) continue;

      prefetchCue(item.cue, item.index, prefetchBatch);
      const russian = findRussianFor(item.cue);
      if (russian) {
        rememberTranslation(item.cue.text, russian);
        ruBlock.textContent = russian;
      } else if (settings.autoTranslate) {
        ruBlock.textContent = 'Перевод…';
        translateCached(item.cue.text).then((value) => {
          if (currentIndex === renderedIndex && ruBlock.parentNode === translationEl) {
            ruBlock.textContent = value || '';
          }
        });
      }
    }
  }

  function findRussianFor(cue) {
    if (!cuesRu.length) return '';
    let best = [];
    let bestScore = 0;
    for (const candidate of cuesRu) {
      const overlap = Math.min(cue.end, candidate.end) - Math.max(cue.start, candidate.start);
      if (overlap <= 0) continue;
      const score = overlap + (Math.abs(cue.start - candidate.start) < 1 ? 0.4 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = [candidate];
      } else if (Math.abs(score - bestScore) < 0.001) {
        best.push(candidate);
      }
    }
    if (!best.length) {
      let nearest = null;
      let distance = Infinity;
      for (const candidate of cuesRu) {
        const d = Math.min(
          Math.abs(candidate.start - cue.start),
          Math.abs(candidate.end - cue.end)
        );
        if (d < distance) {
          distance = d;
          nearest = candidate;
        }
      }
      if (nearest && distance < 4) best = [nearest];
    }
    best.sort((a, b) => a.start - b.start);
    return best.map((item) => item.text).join(' / ');
  }

  // ---------------------------------------------------------------------------
  // Кликабельные слова, карточка слова и словарь
  // ---------------------------------------------------------------------------

  function renderWords(text) {
    const fragment = document.createDocumentFragment();
    const tokenRe = /[\p{L}\p{N}’'-]+|\s+|[^\s\p{L}\p{N}’'-]+/gu;
    let match;
    while ((match = tokenRe.exec(text))) {
      const token = match[0];
      if (/^\s+$/.test(token)) {
        fragment.appendChild(document.createTextNode(token));
        continue;
      }
      if (/^[\p{L}\p{N}’'-]+$/u.test(token)) {
        const span = document.createElement('span');
        span.className = 'ds-word';
        span.textContent = token;
        fragment.appendChild(span);
      } else {
        fragment.appendChild(document.createTextNode(token));
      }
    }
    return fragment;
  }

  function normalizeWord(token) {
    return String(token || '')
      .replace(/^[^\p{L}\p{N}']+/u, '')
      .replace(/[^\p{L}\p{N}']+$/u, '')
      .trim();
  }

  function rememberTranslation(text, value) {
    if (!text || !value) return;
    translationMemory.set(text.toLowerCase(), value);
  }

  function translateCached(text) {
    if (!text) return Promise.resolve('');
    const key = text.toLowerCase();
    if (translationMemory.has(key)) return Promise.resolve(translationMemory.get(key));
    if (pendingTranslations.has(key)) return pendingTranslations.get(key);

    const promise = sendMessage({
      type: 'DS_TRANSLATE',
      text,
      from: 'en',
      to: 'ru'
    }).then((response) => {
      const value = response && response.ok ? response.text : '';
      if (value) rememberTranslation(key, value);
      return value;
    }).then(
      (value) => {
        pendingTranslations.delete(key);
        return value;
      },
      () => {
        pendingTranslations.delete(key);
        return '';
      }
    );
    pendingTranslations.set(key, promise);
    return promise;
  }

  // Предзагружаем перевод слов текущей реплики, чтобы при наведении он был уже готов.
  function prefetchCue(cue, index, tokenArg) {
    if (!settings.wordTranslation || !cue || !cue.text) return;
    const token = tokenArg || ++prefetchToken;
    const words = [];
    const tokenRe = /[\p{L}\p{N}’'-]+/gu;
    let match;
    while ((match = tokenRe.exec(cue.text))) {
      const word = normalizeWord(match[0]);
      if (word && word.length > 2 && words.indexOf(word) < 0) words.push(word);
      if (words.length >= 25) break;
    }

    const russian = findRussianFor(cue);
    rememberTranslation(cue.text, russian);

    (async () => {
      for (const word of words) {
        if (token !== prefetchToken) return;
        const key = word.toLowerCase();
        if (translationMemory.has(key) || pendingTranslations.has(key)) continue;
        await translateCached(word);
        if (token !== prefetchToken) return;
        if (hoverWord && key === hoverWord.toLowerCase() && hoverCard) {
          updateHoverTranslation(hoverCard, word);
        }
      }
      if (
        token === prefetchToken &&
        !translationMemory.has(cue.text.toLowerCase()) &&
        !pendingTranslations.has(cue.text.toLowerCase())
      ) {
        await translateCached(cue.text);
      }
    })();
  }

  // Пауза на время чтения подсказки. Возобновляем только если до наведения шло воспроизведение.
  function pauseForHover() {
    if (!settings.pauseOnHover || !video || pausedByHover) return;
    wasPlayingBeforeHover = !video.paused && !video.ended;
    if (wasPlayingBeforeHover) {
      try {
        video.pause();
      } catch (_) {}
    }
    pausedByHover = true;
  }

  function resumeAfterHover(force) {
    if (!pausedByHover) return;
    if (!force && wordCard) return; // пока открыта карточка — держим паузу
    pausedByHover = false;
    if (wasPlayingBeforeHover && !wordCard) {
      try {
        const attempt = video.play();
        if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {});
      } catch (_) {}
    }
    wasPlayingBeforeHover = false;
  }

  // 1-й приоритет — перевод слова при наведении.
  function handleOriginalMouseOver(event) {
    if (!settings.wordTranslation) return;
    const target = event.target && event.target.closest ? event.target.closest('.ds-word') : null;
    if (!target || target === hoverWord) return;
    hoverWord = target;
    pauseForHover();
    hideHoverCard(false);
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (hoverWord !== target) return;
      const word = normalizeWord(target.textContent);
      if (word) showHoverCard(word, target);
    }, 80);
  }

  function showHoverCard(word, anchor) {
    if (wordCard) return;
    closeHoverCard();
    const card = document.createElement('div');
    card.className = 'ds-hovercard';

    const title = document.createElement('div');
    title.className = 'ds-hovercard-word';
    title.textContent = word;

    const body = document.createElement('div');
    body.className = 'ds-hovercard-translation';
    body.textContent = translationMemory.get(word.toLowerCase()) || 'Перевод…';

    card.appendChild(title);
    card.appendChild(body);
    uiRoot().appendChild(card);
    hoverCard = card;

    positionCard(card, anchor, 210);
    updateHoverTranslation(card, word);
  }

  function updateHoverTranslation(card, text) {
    const body = card && card.querySelector('.ds-hovercard-translation');
    if (!body) return;
    const key = text.toLowerCase();
    const cached = translationMemory.get(key);
    if (cached) {
      body.textContent = cached;
      return;
    }
    translateCached(text).then((value) => {
      if (hoverCard === card) body.textContent = value || 'Перевод недоступен';
    });
  }

  function closeHoverCard() {
    if (hoverCard && hoverCard.parentNode) hoverCard.parentNode.removeChild(hoverCard);
    hoverCard = null;
  }

  function hideHoverCard(resetWord) {
    clearTimeout(hoverTimer);
    closeHoverCard();
    if (resetWord !== false) hoverWord = null;
  }

  // Клик по слову открывает подробную карточку (озвучка + словарь).
  function handleOriginalClick(event) {
    if (!settings.wordTranslation) return;
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const target = event.target && event.target.closest ? event.target.closest('.ds-word') : null;
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    hideHoverCard();
    const word = normalizeWord(target.textContent);
    if (word) openWordCard(word, target);
  }

  // 2-й приоритет — перевод целой фразы по выделению.
  function handleOriginalMouseUp(event) {
    if (!settings.wordTranslation) return;
    const selection = window.getSelection ? String(window.getSelection()).trim() : '';
    if (!selection || selection.length < 2) return;
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode || !sel.focusNode) return;
    if (!originalEl.contains(sel.anchorNode) || !originalEl.contains(sel.focusNode)) return;

    suppressClick = true;
    setTimeout(() => {
      suppressClick = false;
    }, 300);
    hideHoverCard();

    let anchor = originalEl;
    try {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (rect.width || rect.height) {
        anchor = { getBoundingClientRect: () => rect };
      }
    } catch (_) {}

    openPhraseCard(selection, anchor);
  }

  function openWordCard(word, anchor) {
    openTranslationCard({
      kind: 'word',
      text: word,
      anchor,
      context: currentCueText(),
      showPhraseButton: true
    });
  }

  function openPhraseCard(phrase, anchor) {
    openTranslationCard({
      kind: 'phrase',
      text: phrase,
      anchor,
      context: currentCueText(),
      showPhraseButton: false
    });
  }

  function openTranslationCard(options) {
    pauseForHover();
    closeWordCard();
    const text = options.text;
    const kind = options.kind;
    const card = document.createElement('div');
    card.className = 'ds-wordcard';

    const title = document.createElement('div');
    title.className = 'ds-wordcard-title';
    title.textContent = kind === 'phrase' ? '«' + text + '»' : text;

    const translation = document.createElement('div');
    translation.className = 'ds-wordcard-translation';
    const cached = translationMemory.get(text.toLowerCase());
    translation.textContent = cached || 'Перевод…';

    const buttons = document.createElement('div');
    buttons.className = 'ds-wordcard-buttons';

    const speak = document.createElement('button');
    speak.type = 'button';
    speak.textContent = '🔊';
    speak.title = 'Прослушать';
    speak.addEventListener('click', () => speakText(text));

    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = kind === 'phrase' ? '＋ В словарь' : '＋ Слово';
    save.addEventListener('click', () => {
      saveDictionaryEntry(kind, text, translation.textContent, options.context);
      closeWordCard(true);
    });

    if (options.showPhraseButton) {
      const wholePhrase = document.createElement('button');
      wholePhrase.type = 'button';
      wholePhrase.textContent = 'Фраза целиком';
      wholePhrase.title = 'Перевести всю текущую реплику';
      wholePhrase.addEventListener('click', () => {
        const cueText = currentCueText();
        if (cueText) openPhraseCard(cueText, options.anchor);
      });
      buttons.appendChild(wholePhrase);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ds-wordcard-close';
    close.textContent = '×';
    close.addEventListener('click', () => closeWordCard(true));

    buttons.appendChild(speak);
    buttons.appendChild(save);
    buttons.appendChild(close);
    card.appendChild(title);
    card.appendChild(translation);
    card.appendChild(buttons);
    uiRoot().appendChild(card);
    wordCard = card;

    positionCard(card, options.anchor, 300);

    translateCached(text).then((value) => {
      if (wordCard === card) {
        translation.textContent = value || 'Перевод недоступен (проверьте интернет)';
      }
    });

    setTimeout(() => {
      document.addEventListener('mousedown', outsideClickHandler, { once: true });
    }, 0);
  }

  function outsideClickHandler(event) {
    if (wordCard && !wordCard.contains(event.target)) closeWordCard(true);
  }

  function closeWordCard(resume) {
    if (wordCard && wordCard.parentNode) wordCard.parentNode.removeChild(wordCard);
    wordCard = null;
    hideHoverCard();
    if (resume) resumeAfterHover(true);
  }

  function positionCard(card, anchor, width) {
    const rect = anchor && anchor.getBoundingClientRect
      ? anchor.getBoundingClientRect()
      : { left: window.innerWidth / 2, top: window.innerHeight / 2 };
    const cardWidth = width || 260;
    const left = Math.max(8, Math.min(window.innerWidth - cardWidth - 8, rect.left - 30));
    const offset = card.classList.contains('ds-hovercard') ? 74 : 120;
    const top = Math.min(window.innerHeight - 150, Math.max(8, rect.top - offset));
    card.style.left = left + 'px';
    card.style.top = top + 'px';
  }

  function speakText(text) {
    if (!('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en-US';
      utterance.rate = 0.9;
      window.speechSynthesis.speak(utterance);
    } catch (_) {}
  }

  async function saveDictionaryEntry(kind, word, translation, context) {
    if (!word) return;
    const stored = await chrome.storage.local.get('ds_dictionary');
    const list = stored.ds_dictionary || [];
    list.unshift({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      kind,
      word,
      translation: translation || '',
      context: context || '',
      title: document.title || '',
      time: video ? video.currentTime : 0,
      createdAt: new Date().toISOString()
    });
    await chrome.storage.local.set({ ds_dictionary: list });
    showToast('Добавлено в словарь');
  }

  function currentCueText() {
    if (currentIndex < 0) return '';
    const list = cuesEn.length ? cuesEn : cuesRu;
    return list[currentIndex] ? list[currentIndex].text : '';
  }

  function showToast(message) {
    let toast = document.querySelector('.ds-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'ds-toast';
      uiRoot().appendChild(toast);
    }
    toast.textContent = message;
    toast.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.style.opacity = '0';
    }, 1800);
  }

  // ---------------------------------------------------------------------------
  // Расшифровка и обмен сообщениями
  // ---------------------------------------------------------------------------

  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(total / 60);
    const secs = total % 60;
    return String(minutes).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
  }

  function sendTranscript() {
    const base = cuesEn.length ? cuesEn : cuesRu;
    const transcript = base.map((cue, index) => ({
      index,
      start: cue.start,
      end: cue.end,
      en: cuesEn.length ? cue.text : '',
      ru: cuesEn.length ? findRussianFor(cue) : cue.text,
      time: formatTime(cue.start)
    }));
    sendMessage({
      type: 'DS_CUES',
      cues: transcript,
      title: document.title || ''
    });
    renderFullscreenList();
  }

  async function reportStatus(found, enCount, ruCount, note) {
    await sendMessage({
      type: 'DS_STATUS_REPORT',
      status: {
        found,
        en: enCount,
        ru: ruCount,
        translated: !!enCount && !ruCount,
        note,
        offset: subtitleOffset,
        source: trackSource,
        title: document.title || '',
        url: location.href
      }
    });
  }

  function handleMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'DS_SETTINGS') {
      loadSettings().then((next) => {
        settings = next;
        applySettings();
      });
      return;
    }

    if (msg.type === 'DS_SEEK') {
      if (video && Number.isFinite(msg.time)) {
        video.currentTime = Math.max(0, msg.time - subtitleOffset - 0.15);
        const attempt = video.play();
        if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {});
      }
      return;
    }

    if (msg.type === 'DS_FULLSCREEN') {
      parentFullscreen = !!msg.active;
      const root = document.body || document.documentElement;
      root.classList.toggle('ds-fullscreen', parentFullscreen);
      mountUi();
      if (!parentFullscreen && fsPanel) toggleFsPanel(false);
      if (parentFullscreen && fsPanel && settings.transcriptOpen) toggleFsPanel(true);
      return;
    }

    if (msg.type === 'DS_ADJUST_OFFSET') {
      if (msg.value !== undefined && Number.isFinite(Number(msg.value))) {
        setOffset(Number(msg.value));
      } else {
        setOffset(subtitleOffset + Number(msg.delta || 0));
      }
      return;
    }

    if (msg.type === 'DS_RESET_OFFSET') {
      setOffset(0);
      return;
    }

    if (msg.type === 'DS_IMPORT_TRACKS') {
      cuesEn = parseVtt(msg.en || '');
      cuesRu = parseVtt(msg.ru || '');
      currentIndex = -1;
      if (!overlay && video) {
        setupOverlay();
        setupFullscreenPanel();
        applySettings();
        markNativeSubtitles();
        requestAnimationFrame(loop);
      }
      applySettings();
      reportStatus(true, cuesEn.length, cuesRu.length, 'Загружены свои файлы субтитров');
      sendTranscript();
      renderActive();
      return;
    }

    if (msg.type === 'DS_TOGGLE') {
      if (msg.field === 'showOriginal' || msg.field === 'showTranslation') {
        settings[msg.field] = !settings[msg.field];
        persistSettings();
      }
    }
  }

  function handleHotkey(event) {
    if (!event.altKey) return;
    const key = String(event.key || '').toLowerCase();
    if (key === 's') {
      settings.showOriginal = !settings.showOriginal;
      persistSettings();
    } else if (key === 'd') {
      settings.showTranslation = !settings.showTranslation;
      persistSettings();
    } else if (key === 't') {
      if (document.body.classList.contains('ds-fullscreen')) toggleFsPanel();
      sendMessage({ type: 'DS_TOGGLE_TRANSCRIPT' });
    } else if (key === 'arrowleft' || key === 'arrowright') {
      const delta = (key === 'arrowright' ? 0.5 : -0.5) * (event.shiftKey ? 4 : 1);
      setOffset(subtitleOffset + delta);
    } else if (key === 'arrowup' || key === 'arrowdown') {
      settings.fontSize = Math.max(14, Math.min(48, settings.fontSize + (key === 'arrowup' ? 2 : -2)));
      persistSettings();
    } else if (key === 'h') {
      settings.hideNative = !settings.hideNative;
      persistSettings();
    } else {
      return;
    }
    event.preventDefault();
  }

  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get('dsSettings');
      return Object.assign({}, DEFAULT_SETTINGS, stored.dsSettings || {});
    } catch (_) {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  function persistSettings() {
    chrome.storage.local.set({ dsSettings: settings });
    applySettings();
    sendMessage({ type: 'DS_SETTINGS_CHANGED' });
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => resolve(response || {}));
      } catch (_) {
        resolve({});
      }
    });
  }
})();
