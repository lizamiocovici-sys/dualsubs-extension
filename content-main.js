// DualSubs — контент-скрипт на странице subtitle.love.
// Рисует боковую панель «Диалоги» и пересылает команды в iframe плеера.

(function () {
  'use strict';

  const DEFAULT_SETTINGS = {
    transcriptOpen: false,
    fontSize: 24,
    pauseOnHover: true
  };

  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let panel = null;
  let listEl = null;
  let countEl = null;
  let searchInput = null;
  let toggleButton = null;
  let cues = [];
  let activeIndex = -1;
  let mainHoverCard = null;
  let mainHoverTimer = null;
  let mainHoverWord = null;

  init();

  async function init() {
    settings = await loadSettings();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.dsSettings) {
        settings = Object.assign({}, DEFAULT_SETTINGS, changes.dsSettings.newValue || {});
        applySettings();
      }
    });

    buildPanel();
    applySettings();

    const gencitUrl = findGencitUrl();
    if (gencitUrl) {
      sendMessage({
        type: 'DS_REGISTER_PLAYER',
        url: location.href,
        playerUrl: gencitUrl
      });
    }

    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'DS_CUES') {
        cues = Array.isArray(msg.cues) ? msg.cues : [];
        activeIndex = -1;
        renderList();
        if (settings.transcriptOpen) openPanel();
      } else if (msg.type === 'DS_ACTIVE') {
        activeIndex = Number(msg.index) || 0;
        highlightActive();
      } else if (msg.type === 'DS_TOGGLE_TRANSCRIPT') {
        togglePanel();
      }
    });

    window.addEventListener('message', (event) => {
      const data = event && event.data;
      if (!data || data.type !== 'DS_REQUEST_PAGE_URL') return;
      try {
        if (event.source && typeof event.source.postMessage === 'function') {
          event.source.postMessage({
            type: 'DS_PAGE_URL',
            url: location.href,
            playerUrl: findGencitUrl()
          }, '*');
        }
      } catch (_) {}
    });

    document.addEventListener('keydown', (event) => {
      if (!event.altKey) return;
      if (String(event.key || '').toLowerCase() === 't') {
        event.preventDefault();
        togglePanel();
      }
    });

    // Если сайт разворачивает сам iframe на весь экран, плеер должен показать свою панель слева.
    const notifyFullscreen = () => {
      sendMessage({ type: 'DS_FULLSCREEN', active: !!document.fullscreenElement });
    };
    document.addEventListener('fullscreenchange', notifyFullscreen);
    document.addEventListener('webkitfullscreenchange', notifyFullscreen);
  }

  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get('dsSettings');
      return Object.assign({}, DEFAULT_SETTINGS, stored.dsSettings || {});
    } catch (_) {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  function applySettings() {
    if (!panel) return;
    if (settings.transcriptOpen) openPanel();
    else closePanel();
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.className = 'ds-panel';

    const header = document.createElement('div');
    header.className = 'ds-panel-header';

    const title = document.createElement('span');
    title.textContent = 'Диалоги';

    countEl = document.createElement('small');
    countEl.className = 'ds-panel-count';
    title.appendChild(countEl);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ds-panel-close';
    close.textContent = '×';
    close.title = 'Закрыть (Alt+T)';
    close.addEventListener('click', closePanel);

    header.appendChild(title);
    header.appendChild(close);

    const searchWrap = document.createElement('div');
    searchWrap.className = 'ds-panel-search';
    searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Поиск по репликам';
    searchInput.addEventListener('input', renderList);
    searchWrap.appendChild(searchInput);

    listEl = document.createElement('div');
    listEl.className = 'ds-panel-list';
    listEl.addEventListener('mouseover', handlePanelMouseOver);
    listEl.addEventListener('mouseleave', hideMainHoverCard);
    listEl.addEventListener('click', (event) => {
      if (event.target && event.target.closest && event.target.closest('.ds-word')) {
        event.stopPropagation();
      }
    }, true);

    panel.appendChild(header);
    panel.appendChild(searchWrap);
    panel.appendChild(listEl);
    document.body.appendChild(panel);

    toggleButton = document.createElement('button');
    toggleButton.type = 'button';
    toggleButton.className = 'ds-panel-toggle';
    toggleButton.textContent = 'Д';
    toggleButton.title = 'Диалоги (Alt+T)';
    toggleButton.addEventListener('click', togglePanel);
    document.body.appendChild(toggleButton);
  }

  function renderList() {
    if (!listEl) return;
    hideMainHoverCard();
    const query = (searchInput && searchInput.value || '').trim().toLowerCase();
    const fragment = document.createDocumentFragment();

    let shown = 0;
    cues.forEach((cue, index) => {
      const haystack = ((cue.en || '') + ' ' + (cue.ru || '')).toLowerCase();
      if (query && haystack.indexOf(query) < 0) return;
      shown++;

      const item = document.createElement('div');
      item.className = 'ds-panel-item';
      item.dataset.index = String(index);

      const time = document.createElement('span');
      time.className = 'ds-panel-time';
      time.textContent = cue.time || '';

      const body = document.createElement('div');
      body.className = 'ds-panel-body';

      const en = document.createElement('div');
      en.className = 'ds-panel-en';
      en.replaceChildren(renderDialogWords(cue.en || ''));

      const ru = document.createElement('div');
      ru.className = 'ds-panel-ru';
      ru.textContent = cue.ru || '';

      body.appendChild(en);
      if (cue.ru) body.appendChild(ru);
      item.appendChild(time);
      item.appendChild(body);

      item.addEventListener('click', () => {
        sendMessage({ type: 'DS_SEEK', time: cue.start });
        activeIndex = index;
        highlightActive();
      });

      fragment.appendChild(item);
    });

    listEl.replaceChildren(fragment);
    if (countEl) countEl.textContent = ' · ' + shown + '/' + cues.length;
    highlightActive();
  }

  function highlightActive() {
    if (!listEl) return;
    const items = listEl.querySelectorAll('.ds-panel-item');
    const active = listEl.querySelector('.ds-panel-item[data-index="' + activeIndex + '"]');
    for (const item of items) item.classList.remove('is-active');
    if (!active) return;
    active.classList.add('is-active');
    const panelRect = listEl.getBoundingClientRect();
    const itemRect = active.getBoundingClientRect();
    if (itemRect.top < panelRect.top || itemRect.bottom > panelRect.bottom) {
      listEl.scrollTop += itemRect.top - panelRect.top - panelRect.height / 3;
    }
  }

  function openPanel() {
    if (panel) panel.classList.add('is-open');
    if (toggleButton) toggleButton.classList.add('is-open');
  }

  function closePanel() {
    if (panel) panel.classList.remove('is-open');
    if (toggleButton) toggleButton.classList.remove('is-open');
  }

  function togglePanel() {
    if (panel && panel.classList.contains('is-open')) closePanel();
    else openPanel();
  }

  function renderDialogWords(text) {
    const fragment = document.createDocumentFragment();
    const tokenRe = /[\p{L}\p{N}’'-]+|\s+|[^\s\p{L}\p{N}’'-]+/gu;
    let match;
    while ((match = tokenRe.exec(String(text || '')))) {
      const token = match[0];
      if (/^\s+$/.test(token)) {
        fragment.appendChild(document.createTextNode(token));
      } else if (/^[\p{L}\p{N}’'-]+$/u.test(token)) {
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

  function handlePanelMouseOver(event) {
    const target = event.target && event.target.closest ? event.target.closest('.ds-word') : null;
    if (!target || target === mainHoverWord) return;
    mainHoverWord = target;
    hideMainHoverCard(false);
    clearTimeout(mainHoverTimer);
    const word = String(target.textContent || '').replace(/^[^\p{L}\p{N}']+/u, '')
      .replace(/[^\p{L}\p{N}']+$/u, '').trim();
    if (!word) return;
    mainHoverTimer = setTimeout(() => showMainHoverCard(word, target), 80);
  }

  function showMainHoverCard(word, anchor) {
    hideMainHoverCard(false);
    const card = document.createElement('div');
    card.className = 'ds-hovercard';
    const title = document.createElement('div');
    title.className = 'ds-hovercard-word';
    title.textContent = word;
    const body = document.createElement('div');
    body.className = 'ds-hovercard-translation';
    body.textContent = 'Перевод…';
    card.appendChild(title);
    card.appendChild(body);
    document.body.appendChild(card);
    mainHoverCard = card;

    const rect = anchor.getBoundingClientRect();
    const width = 210;
    const left = Math.min(
      Math.max(8, rect.left + rect.width / 2 - width / 2),
      Math.max(8, window.innerWidth - width - 8)
    );
    const above = rect.top - 64;
    card.style.left = left + 'px';
    card.style.top = (above > 8 ? above : Math.min(rect.bottom + 8, window.innerHeight - 70)) + 'px';

    chrome.runtime.sendMessage(
      { type: 'DS_TRANSLATE', text: word, from: 'en', to: 'ru' },
      (response) => {
        if (mainHoverCard === card && response && response.ok) {
          body.textContent = response.text || 'Перевод недоступен';
        }
      }
    );
  }

  function hideMainHoverCard(resetWord) {
    clearTimeout(mainHoverTimer);
    if (mainHoverCard && mainHoverCard.parentNode) mainHoverCard.parentNode.removeChild(mainHoverCard);
    mainHoverCard = null;
    if (resetWord !== false) mainHoverWord = null;
  }

  function findGencitUrl() {
    const nodes = document.querySelectorAll('iframe[data-src], iframe[src]');
    for (const node of nodes) {
      const raw = String(node.getAttribute('data-src') || node.getAttribute('src') || '');
      if (/gencit\.info\/bil\//i.test(raw)) return raw.replace(/&amp;/g, '&');
    }
    return '';
  }

  function sendMessage(message) {
    try {
      chrome.runtime.sendMessage(message, () => {});
    } catch (_) {}
  }
})();
