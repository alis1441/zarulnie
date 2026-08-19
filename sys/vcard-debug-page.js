(() => {
  'use strict';

  const manifestNode = document.getElementById('vcard-debug-manifest');
  const table = document.getElementById('vcard-debug-resources');
  const build = document.getElementById('vcard-debug-build');
  const summary = document.getElementById('vcard-debug-summary');
  const status = document.getElementById('vcard-debug-status');
  const session = document.getElementById('vcard-debug-session');
  const checkButton = document.getElementById('vcard-debug-check');
  const snapshotButton = document.getElementById('vcard-debug-snapshot');
  const SNAPSHOT_KEY = 'vcard-debug-media-cache-snapshot-v1';
  const SESSION_REPORT_KEY = 'vcard-media-cache-session-v1';
  const CACHE_NAME = 'vcard-media-v1';
  const MAX_CONCURRENT_CHECKS = 6;

  if (!manifestNode || !table || !checkButton || !snapshotButton) return;

  let manifest;
  try {
    manifest = JSON.parse(manifestNode.textContent || '{}');
  } catch (_error) {
    status.textContent = 'Не удалось прочитать манифест медиа.';
    return;
  }

  const resources = Array.isArray(manifest.resources) ? manifest.resources : [];
  const previousSnapshot = (() => {
    try {
      const value = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || 'null');
      return value && value.states ? value : null;
    } catch (_error) {
      return null;
    }
  })();
  const states = new Map(resources.map((resource) => [resource.url, 'unchecked']));
  let isChecking = false;

  const sessionReport = (() => {
    try {
      const value = JSON.parse(localStorage.getItem(SESSION_REPORT_KEY) || 'null');
      return value && Array.isArray(value.resources) ? value : null;
    } catch (_error) {
      return null;
    }
  })();

  const renderSessionSources = () => {
    if (!session) return;
    if (!sessionReport) {
      session.textContent = 'Список источников последней страницы пока не записан.';
      return;
    }
    const loaded = sessionReport.resources.filter((resource) => resource.source !== 'cached');
    if (!loaded.length) {
      session.textContent = 'Последняя страница получила все медиа из кэша VCard.';
      return;
    }
    const paths = loaded.map((resource) => {
      try {
        return new URL(resource.url).pathname.replace(/^\//, '');
      } catch (_error) {
        return resource.url;
      }
    });
    session.textContent = `Не из кэша VCard при открытии последней страницы: ${paths.join(', ')}.`;
  };

  const formatBytes = (value) => {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let amount = bytes / 1024;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) {
      amount /= 1024;
      unit += 1;
    }
    return `${amount.toFixed(amount >= 100 ? 0 : 1)} ${units[unit]}`;
  };

  const labelForState = (state) => ({
    cached: 'в кэше',
    missing: 'нет полного ответа',
    unknown: 'не определено',
    unchecked: 'не проверено',
  }[state] || 'не определено');

  const labelForScope = (scope) => scope === 'song' ? 'песня' : 'встроенный';

  const render = () => {
    const fragment = document.createDocumentFragment();
    let cachedCount = 0;
    let cachedBytes = 0;
    let missingCount = 0;
    let checkedCount = 0;

    resources.forEach((resource) => {
      const current = states.get(resource.url) || 'unchecked';
      const previous = previousSnapshot?.states?.[resource.url] || 'unchecked';
      const row = document.createElement('tr');
      const cells = [labelForScope(resource.scope), resource.kind, resource.path, formatBytes(resource.size)];
      cells.forEach((value, index) => {
        const cell = document.createElement('td');
        cell.textContent = value;
        if (index === 2) cell.className = 'vcard-cache-debug__path';
        row.appendChild(cell);
      });

      const currentCell = document.createElement('td');
      currentCell.textContent = labelForState(current);
      currentCell.className = `vcard-cache-debug__state--${current}`;
      row.appendChild(currentCell);

      const previousCell = document.createElement('td');
      previousCell.textContent = labelForState(previous);
      previousCell.className = `vcard-cache-debug__state--${previous}`;
      if (previous === 'cached' && current === 'missing') {
        previousCell.textContent = 'был в кэше → исчез';
        previousCell.className = 'vcard-cache-debug__state--lost';
      }
      row.appendChild(previousCell);
      fragment.appendChild(row);

      if (current !== 'unchecked') checkedCount += 1;
      if (current === 'cached') {
        cachedCount += 1;
        cachedBytes += Number(resource.size) || 0;
      }
      if (current === 'missing') missingCount += 1;
    });
    table.replaceChildren(fragment);
    summary.replaceChildren(
      summaryItem('Всего', `${resources.length} / ${formatBytes(resources.reduce((sum, resource) => sum + (Number(resource.size) || 0), 0))}`),
      summaryItem('Проверено', `${checkedCount}/${resources.length}`),
      summaryItem('В кэше', `${cachedCount} / ${formatBytes(cachedBytes)}`),
      summaryItem('Нет полного ответа', String(missingCount)),
      summaryItem('Прошлый снимок', previousSnapshot ? new Date(previousSnapshot.savedAt).toLocaleString('ru-RU') : 'нет')
    );
    snapshotButton.disabled = checkedCount !== resources.length || isChecking;
  };

  const summaryItem = (name, value) => {
    const wrapper = document.createElement('div');
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = name;
    description.textContent = value;
    wrapper.append(term, description);
    return wrapper;
  };

  const cacheState = async (resource) => {
    if (!('caches' in window)) return 'unknown';
    try {
      const cache = await caches.open(CACHE_NAME);
      const request = new Request(new URL(resource.url, document.baseURI).href);
      return await cache.match(request) ? 'cached' : 'missing';
    } catch (_error) {
      return 'unknown';
    }
  };

  const inspectCache = async () => {
    if (isChecking) return;
    isChecking = true;
    checkButton.disabled = true;
    checkButton.textContent = 'Проверяем…';
    status.textContent = 'Проверка управляемого кэша VCard: сеть не используется.';
    render();

    let cursor = 0;
    const worker = async () => {
      while (cursor < resources.length) {
        const resource = resources[cursor];
        cursor += 1;
        states.set(resource.url, await cacheState(resource));
        status.textContent = `Проверка кэша VCard: ${cursor}/${resources.length}.`;
        render();
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_CHECKS, resources.length) }, worker));
    isChecking = false;
    checkButton.disabled = false;
    checkButton.textContent = 'Проверить локальный кэш';
    status.textContent = 'Проверка завершена. Сеть не использовалась.';
    render();
  };

  snapshotButton.addEventListener('click', () => {
    const snapshot = {
      savedAt: new Date().toISOString(),
      generatedAt: manifest.generatedAt || '',
      states: Object.fromEntries(states),
    };
    try {
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
      status.textContent = 'Снимок сохранён локально в браузере.';
    } catch (_error) {
      status.textContent = 'Не удалось сохранить снимок в localStorage.';
    }
  });

  checkButton.addEventListener('click', inspectCache);
  build.textContent = `Сборка: ${manifest.generatedAt || 'неизвестно'} · медиа: ${resources.length}`;
  renderSessionSources();
  render();
  inspectCache();
})();
