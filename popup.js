// DualSubs — popup: настройки, словарь, ручная загрузка субтитров.

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

  const CHECKBOXES = [
    'showOriginal',
    'showTranslation',
    'hideNative',
    'wordTranslation',
    'pauseOnHover',
    'autoTranslate',
    'transcriptOpen'
  ];

  const RANGES = {
    fontSize: 'fontSizeOut',
    bgOpacity: 'bgOpacityOut',
    bottomOffset: 'bottomOffsetOut',
    subtitleHold: 'subtitleHoldOut',
    cueLines: 'cueLinesOut'
  };

  const COLORS = ['originalColor', 'translationColor'];

  let tabId = null;
  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let dictionary = [];

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  async function init() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tabs && tabs[0] ? tabs[0].id : null;
    } catch (_) {}

    settings = await loadSettings();
    fillSettings();
    bindTabs();
    bindSettings();
    bindButtons();
    bindOffsetButtons();
    bindDictionary();
    await refreshStatus();
    await loadDictionary();
  }

  function $(id) {
    return document.getElementById(id);
  }

  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get('dsSettings');
      return Object.assign({}, DEFAULT_SETTINGS, stored.dsSettings || {});
    } catch (_) {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  function fillSettings() {
    for (const id of CHECKBOXES) {
      const el = $(id);
      if (el) el.checked = !!settings[id];
    }
    for (const id of Object.keys(RANGES)) {
      const el = $(id);
      if (!el) continue;
      const value = id === 'bgOpacity' ? Math.round(settings[id] * 100) : settings[id];
      el.value = String(value);
      const out = $(RANGES[id]);
      if (out) out.textContent = String(value);
    }
    for (const id of COLORS) {
      const el = $(id);
      if (el) el.value = settings[id] || DEFAULT_SETTINGS[id];
    }
  }

  function bindTabs() {
    const buttons = document.querySelectorAll('.tab-btn');
    for (const button of buttons) {
      button.addEventListener('click', () => {
        for (const btn of buttons) btn.classList.remove('is-active');
        button.classList.add('is-active');
        for (const tab of document.querySelectorAll('.tab')) tab.classList.remove('is-active');
        const target = $('tab-' + button.dataset.tab);
        if (target) target.classList.add('is-active');
      });
    }
  }

  function bindSettings() {
    for (const id of CHECKBOXES) {
      const el = $(id);
      if (!el) continue;
      el.addEventListener('change', () => {
        settings[id] = el.checked;
        saveSettings();
      });
    }

    for (const id of Object.keys(RANGES)) {
      const el = $(id);
      if (!el) continue;
      el.addEventListener('input', () => {
        settings[id] = id === 'bgOpacity' ? Number(el.value) / 100 : Number(el.value);
        const out = $(RANGES[id]);
        if (out) out.textContent = el.value;
        saveSettings();
      });
    }

    for (const id of COLORS) {
      const el = $(id);
      if (!el) continue;
      el.addEventListener('input', () => {
        settings[id] = el.value;
        saveSettings();
      });
    }
  }

  async function saveSettings() {
    await chrome.storage.local.set({ dsSettings: settings });
    await send({ type: 'DS_SETTINGS_CHANGED', tabId });
  }

  function bindButtons() {
    const openTranscript = $('open-transcript');
    if (openTranscript) {
      openTranscript.addEventListener('click', async () => {
        await send({ type: 'DS_TOGGLE_TRANSCRIPT', tabId });
        window.close();
      });
    }

    const reset = $('reset-settings');
    if (reset) {
      reset.addEventListener('click', async () => {
        if (!window.confirm('Сбросить все настройки DualSubs?')) return;
        settings = Object.assign({}, DEFAULT_SETTINGS);
        await chrome.storage.local.set({ dsSettings: settings });
        fillSettings();
        await send({ type: 'DS_SETTINGS_CHANGED', tabId });
      });
    }

    const importTracks = $('import-tracks');
    if (importTracks) {
      importTracks.addEventListener('click', async () => {
        const enFile = $('file-en') && $('file-en').files[0];
        const ruFile = $('file-ru') && $('file-ru').files[0];
        const status = $('import-status');
        if (!enFile && !ruFile) {
          if (status) status.textContent = 'Выберите хотя бы один файл.';
          return;
        }
        try {
          const [en, ru] = await Promise.all([
            enFile ? enFile.text() : Promise.resolve(''),
            ruFile ? ruFile.text() : Promise.resolve('')
          ]);
          const result = await send({
            type: 'DS_IMPORT_TRACKS',
            tabId,
            en,
            ru
          });
          if (status) {
            status.textContent = result && result.ok
              ? 'Загружено. Вернитесь к видео.'
              : 'Не удалось отправить файлы в плеер.';
          }
        } catch (err) {
          if (status) status.textContent = 'Ошибка чтения файла: ' + err.message;
        }
      });
    }
  }

  function bindOffsetButtons() {
    for (const button of document.querySelectorAll('[data-offset]')) {
      button.addEventListener('click', async () => {
        await send({ type: 'DS_ADJUST_OFFSET', tabId, delta: Number(button.dataset.offset) || 0 });
        await refreshStatus();
      });
    }
    const reset = $('offset-reset');
    if (reset) {
      reset.addEventListener('click', async () => {
        await send({ type: 'DS_RESET_OFFSET', tabId });
        await refreshStatus();
      });
    }
  }

  function formatOffset(value) {
    const rounded = Math.round(Number(value || 0) * 10) / 10;
    return (rounded > 0 ? '+' : '') + rounded.toFixed(1) + ' с';
  }

  function sourceLabel(source) {
    const labels = {
      playerData: 'gencit',
      'cc-array': 'embf',
      'track-element': '<track>',
      'vtt-scan': 'VTT',
      textTracks: 'плеер',
      site: 'сайт'
    };
    return labels[source] || source || '';
  }

  async function refreshStatus() {
    const el = $('status');
    if (!el) return;
    el.className = 'status';
    try {
      const response = await send({ type: 'DS_GET_STATUS', tabId });
      const status = response && response.status;
      const offsetEl = $('offset-value');
      if (offsetEl) offsetEl.textContent = formatOffset(status && status.offset);
      if (!status || !status.found) {
        el.textContent = status && status.note ? status.note : 'Дорожки не найдены';
        el.classList.add('warn');
        el.title = status && status.note
          ? status.note
          : 'Включите английские субтитры в плеере или загрузите свои файлы.';
        return;
      }
      const source = sourceLabel(status.source);
      const offset = Number(status.offset) || 0;
      el.textContent =
        'EN ' + status.en + ' · ' +
        (status.ru ? 'RU ' + status.ru : 'перевод через API') +
        (source ? ' · ' + source : '') +
        (offset ? ' · ' + formatOffset(offset) : '');
      el.classList.add('ok');
      el.title = status.title || 'Дорожки субтитров найдены';
    } catch (_) {
      el.textContent = 'Откройте страницу с плеером';
      el.classList.add('warn');
    }
  }

  async function loadDictionary() {
    try {
      const stored = await chrome.storage.local.get('ds_dictionary');
      dictionary = Array.isArray(stored.ds_dictionary) ? stored.ds_dictionary : [];
    } catch (_) {
      dictionary = [];
    }
    renderDictionary();
  }

  async function persistDictionary() {
    await chrome.storage.local.set({ ds_dictionary: dictionary });
  }

  function renderDictionary() {
    const list = $('dict-list');
    if (!list) return;
    const query = ($('dict-search') && $('dict-search').value || '').trim().toLowerCase();
    const items = dictionary.filter((item) => {
      if (!query) return true;
      return ((item.word || '') + ' ' + (item.translation || '') + ' ' + (item.context || ''))
        .toLowerCase()
        .indexOf(query) >= 0;
    });

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'dict-empty';
      empty.textContent = dictionary.length ? 'Ничего не найдено' : 'Словарь пуст — наведите курсор на слово в субтитрах';
      list.replaceChildren(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'dict-item';

      const wordLine = document.createElement('div');
      wordLine.className = 'dict-word';
      const word = document.createElement('span');
      word.textContent = (item.kind === 'phrase' ? '«' + item.word + '»' : item.word) || '';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'dict-delete';
      del.textContent = '×';
      del.title = 'Удалить';
      del.dataset.id = item.id;
      wordLine.appendChild(word);
      wordLine.appendChild(del);

      const translation = document.createElement('div');
      translation.className = 'dict-translation';
      translation.textContent = item.translation || '—';

      row.appendChild(wordLine);
      row.appendChild(translation);

      if (item.context) {
        const context = document.createElement('div');
        context.className = 'dict-context';
        context.textContent = '«' + item.context + '»';
        row.appendChild(context);
      }

      fragment.appendChild(row);
    }
    list.replaceChildren(fragment);
  }

  function bindDictionary() {
    const add = $('dict-add-btn');
    if (add) {
      add.addEventListener('click', async () => {
        const wordInput = $('dict-word');
        const translationInput = $('dict-translation');
        const word = (wordInput && wordInput.value || '').trim();
        if (!word) return;
        dictionary.unshift({
          id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
          kind: word.indexOf(' ') >= 0 ? 'phrase' : 'word',
          word,
          translation: (translationInput && translationInput.value || '').trim(),
          context: '',
          title: '',
          time: 0,
          createdAt: new Date().toISOString()
        });
        await persistDictionary();
        if (wordInput) wordInput.value = '';
        if (translationInput) translationInput.value = '';
        renderDictionary();
      });
    }

    const search = $('dict-search');
    if (search) search.addEventListener('input', renderDictionary);

    const list = $('dict-list');
    if (list) {
      list.addEventListener('click', async (event) => {
        const button = event.target && event.target.closest ? event.target.closest('.dict-delete') : null;
        if (!button) return;
        dictionary = dictionary.filter((item) => item.id !== button.dataset.id);
        await persistDictionary();
        renderDictionary();
      });
    }

    const exportBtn = $('dict-export');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(dictionary, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'dualsubs-dictionary.json';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    }

    const importBtn = $('dict-import');
    const importFile = $('dict-import-file');
    if (importBtn && importFile) {
      importBtn.addEventListener('click', () => importFile.click());
      importFile.addEventListener('change', async () => {
        const file = importFile.files && importFile.files[0];
        if (!file) return;
        try {
          const parsed = JSON.parse(await file.text());
          if (!Array.isArray(parsed)) throw new Error('Ожидался массив');
          const known = new Set(dictionary.map((item) => item.word + '|' + item.translation));
          for (const item of parsed) {
            if (!item || !item.word) continue;
            const key = item.word + '|' + (item.translation || '');
            if (known.has(key)) continue;
            known.add(key);
            dictionary.push({
              id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
              kind: item.kind || 'word',
              word: item.word,
              translation: item.translation || '',
              context: item.context || '',
              title: item.title || '',
              time: item.time || 0,
              createdAt: item.createdAt || new Date().toISOString()
            });
          }
          await persistDictionary();
          renderDictionary();
        } catch (err) {
          window.alert('Не удалось импортировать словарь: ' + err.message);
        }
        importFile.value = '';
      });
    }

    const clear = $('dict-clear');
    if (clear) {
      clear.addEventListener('click', async () => {
        if (!window.confirm('Удалить все слова из словаря?')) return;
        dictionary = [];
        await persistDictionary();
        renderDictionary();
      });
    }
  }

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => resolve(response || {}));
      } catch (_) {
        resolve({});
      }
    });
  }
})();
