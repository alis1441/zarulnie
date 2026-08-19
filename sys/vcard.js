const email0 = 'ali';
const vcardFileMode = location.protocol === 'file:';
const vcardAnimationPlaybackRate = 1;
const vcardBackgroundPlaybackRate = 1;
const vcardMagicTimeSeconds = (() => {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--vc-magictime')
    .trim();
  const match = value.match(/^(\d*\.?\d+)(ms|s)$/i);
  if (!match) return 2;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return 2;
  return match[2].toLowerCase() === 'ms' ? amount / 1000 : amount;
})();
const vcardMagicTimeMilliseconds = vcardMagicTimeSeconds * 1000;
// The portal frame crossfade stays short; the full overlay hold is separate.
const vcardMagicShortTimeSeconds = vcardMagicTimeSeconds / 2;
const vcardMagicHoldTimeSeconds = vcardMagicTimeSeconds;
const vcardPortalStaticHoldMilliseconds = 5000;

const playVCardAnimation = (video, playbackRate = vcardAnimationPlaybackRate) => {
  video.playbackRate = playbackRate;
  video.play().catch(() => { });
};

const freezeVCardVideo = (video) => {
  if (!video) return;
  video.pause();
  const showFirstFrame = () => {
    try { video.currentTime = 0; } catch (_error) { }
  };
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) showFirstFrame();
  else video.addEventListener('loadedmetadata', showFirstFrame, { once: true });
};

const isVCardHotkey = (event) => {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return false;
  const target = event.target;
  return !(target && target.closest && target.closest('input, textarea, select, [contenteditable="true"]'));
};

const vcardCssDefault = (name, fallback = '') => {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(`--def-${name}`)
    .trim();
  return value || fallback;
};

const vcardStoredSetting = (storageKey, defaultName, fallback) => {
  const stored = localStorage.getItem(storageKey);
  return stored === null ? vcardCssDefault(defaultName, fallback) : stored;
};

const vcardMediaCache = (() => {
  const CACHE_NAME = 'vcard-media-v1';
  const MEDIA_PATH = /\/usr\//i;
  const MEDIA_EXT = /\.(?:aac|aiff?|avif|flac|gif|jpe?g|m4a|m4v|mov|mp3|mp4|oga|ogg|ogv|opus|png|svg|wav|webm|webp)$/i;
  const AUDIO_EXT = /\.(?:aac|aiff?|flac|m4a|mp3|oga|ogg|opus|wav)$/i;
  const SESSION_REPORT_KEY = 'vcard-media-cache-session-v1';
  const sessionResources = new Map();
  let scheduleNonAudioCache = null;
  let cacheGeneration = 0;

  const saveSessionReport = () => {
    try {
      localStorage.setItem(SESSION_REPORT_KEY, JSON.stringify({
        savedAt: new Date().toISOString(),
        resources: [...sessionResources].map(([url, item]) => ({
          url,
          source: item.source,
          bytes: item.bytes,
        })),
      }));
    } catch (_error) { }
  };

  const recordSessionResource = (value, source = 'loaded', bytes = 0, replaceBytes = false) => {
    if (!isMediaUrl(value)) return;
    const url = new URL(value, document.baseURI).href;
    const previous = sessionResources.get(url);
    if (!previous) {
      sessionResources.set(url, { source, bytes: Math.max(0, Number(bytes) || 0) });
      saveSessionReport();
      return;
    }
    const nextBytes = Math.max(0, Number(bytes) || 0);
    previous.bytes = replaceBytes
      ? Math.max(previous.bytes, nextBytes)
      : previous.bytes + nextBytes;
    // A service-worker answer is authoritative.  A performance entry seen
    // earlier is only a fallback and must not turn a real cache hit into a load.
    if (source === 'cached') previous.source = 'cached';
    saveSessionReport();
  };

  saveSessionReport();

  const isMediaUrl = (value) => {
    try {
      const url = new URL(value, document.baseURI);
      return url.origin === location.origin && MEDIA_PATH.test(url.pathname) && MEDIA_EXT.test(url.pathname);
    } catch (_error) {
      return false;
    }
  };

  const isAudioUrl = (value) => {
    try {
      return AUDIO_EXT.test(new URL(value, document.baseURI).pathname);
    } catch (_error) {
      return false;
    }
  };

  const mediaManifestResources = () => {
    const resources = window.VCardMediaManifest?.resources;
    if (!Array.isArray(resources)) return [];
    const seen = new Set();
    return resources.filter((item) => {
      if (!item || !isMediaUrl(item.url)) return false;
      const url = new URL(item.url, document.baseURI).href;
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    });
  };

  const manifestStats = () => mediaManifestResources().reduce((result, item) => {
    result.files += 1;
    result.bytes += Math.max(0, Number(item.size) || 0);
    return result;
  }, { files: 0, bytes: 0 });

  const observe = (entry) => {
    if (!isMediaUrl(entry.name)) return;
    // transferSize=0 means only that the browser did not transfer bytes.  It
    // can be the browser HTTP cache, not necessarily the VCard Cache Storage.
    // Service-worker messages below replace this fallback with the real source.
    recordSessionResource(entry.name, 'loaded', entry.transferSize);
    if (!isAudioUrl(entry.name)) scheduleNonAudioCache?.();
  };

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const detail = event.data;
      if (!detail || detail.type !== 'vcard-media-source') return;
      recordSessionResource(detail.url, detail.source === 'cache' ? 'cached' : 'loaded');
    });
  }

  performance.getEntriesByType('resource').forEach(observe);
  if ('PerformanceObserver' in window) {
    try {
      new PerformanceObserver((list) => list.getEntries().forEach(observe))
        .observe({ type: 'resource', buffered: true });
    } catch (_error) { }
  }

  const getStats = async () => {
    const session = [...sessionResources.values()].reduce((result, item) => {
      result.files += 1;
      result.bytes += item.bytes;
      if (item.source === 'cached') result.cached += 1;
      else result.downloaded += 1;
      return result;
    }, { files: 0, cached: 0, downloaded: 0, bytes: 0 });
    if (!('caches' in window)) return { cache: { files: 0, bytes: 0 }, session, persistent: false };
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    let bytes = 0;
    await Promise.all(keys.map(async (key) => {
      const response = await cache.match(key);
      bytes += Math.max(0, Number(response?.headers.get('Content-Length')) || 0);
    }));
    const persistent = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
    return { cache: { files: keys.length, bytes }, session, persistent };
  };

  const discardObsoleteVersions = async (cache, currentRequest) => {
    const currentUrl = new URL(currentRequest.url);
    if (!currentUrl.searchParams.has('v')) return;
    const keys = await cache.keys();
    await Promise.all(keys
      .filter((key) => {
        const candidate = new URL(key.url);
        return candidate.origin === currentUrl.origin
          && candidate.pathname === currentUrl.pathname
          && candidate.searchParams.has('v')
          && candidate.href !== currentUrl.href;
      })
      .map((key) => cache.delete(key)));
  };

  const cacheUrls = async (urls, onProgress = null) => {
    if (!('caches' in window)) return;
    const generation = cacheGeneration;
    if (navigator.storage?.persist) {
      try { await navigator.storage.persist(); } catch (_error) { }
    }
    const cache = await caches.open(CACHE_NAME);
    if (generation !== cacheGeneration) return;
    const unique = [...new Map((urls || [])
      .filter((item) => isMediaUrl(typeof item === 'string' ? item : item?.url))
      .map((item) => {
        const url = new URL(typeof item === 'string' ? item : item.url, document.baseURI).href;
        return [url, typeof item === 'string' ? { url, size: 0 } : { ...item, url }];
      })).values()];
    const progress = { total: unique.length, completed: 0, cached: 0, loaded: 0, failed: 0, bytes: 0 };
    const reportProgress = () => onProgress?.({ ...progress });
    reportProgress();
    let cursor = 0;
    const cacheOne = async () => {
      while (cursor < unique.length && generation === cacheGeneration) {
        const item = unique[cursor++];
        const request = new Request(item.url);
        let source = 'cached';
        let response = await cache.match(request);
        try {
          if (!response) {
            source = 'loaded';
            response = await fetch(request, { cache: 'force-cache', credentials: 'same-origin' });
            if (!response.ok || generation !== cacheGeneration) throw new Error('Media response is unavailable');
            await cache.put(request, response.clone());
            if (generation !== cacheGeneration) return;
            await discardObsoleteVersions(cache, request);
          }
          const bytes = Math.max(
            0,
            Number(item.size) || Number(response?.headers.get('Content-Length')) || 0
          );
          recordSessionResource(item.url, source, bytes, true);
          progress[source] += 1;
          progress.bytes += bytes;
        } catch (_error) {
          progress.failed += 1;
        } finally {
          progress.completed += 1;
          reportProgress();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, unique.length) }, cacheOne));
    if (generation === cacheGeneration) {
      document.dispatchEvent(new CustomEvent('vcard:media-cache-change'));
    }
    return progress;
  };

  const cacheLoadedMedia = () => cacheUrls([...sessionResources.keys()]);
  const cacheLoadedNonAudioMedia = () => cacheUrls(
    [...sessionResources.keys()].filter((url) => !isAudioUrl(url))
  );
  let nonAudioCacheTimer = 0;
  scheduleNonAudioCache = () => {
    if (nonAudioCacheTimer) return;
    nonAudioCacheTimer = window.setTimeout(() => {
      nonAudioCacheTimer = 0;
      cacheLoadedNonAudioMedia().catch(() => {});
    }, 1200);
  };
  if (document.readyState === 'complete') scheduleNonAudioCache();
  else window.addEventListener('load', scheduleNonAudioCache, { once: true });
  let preloadAllPromise = null;
  const preloadAll = () => {
    if (preloadAllPromise) return preloadAllPromise;
    const resources = mediaManifestResources();
    preloadAllPromise = cacheUrls(resources, (detail) => {
      document.dispatchEvent(new CustomEvent('vcard:media-cache-progress', { detail }));
    }).finally(() => {
      preloadAllPromise = null;
    });
    return preloadAllPromise;
  };
  const clear = async () => {
    if (!('caches' in window)) return false;
    cacheGeneration += 1;
    sessionResources.clear();
    saveSessionReport();
    if (nonAudioCacheTimer) {
      window.clearTimeout(nonAudioCacheTimer);
      nonAudioCacheTimer = 0;
    }
    try { performance.clearResourceTimings(); } catch (_error) { }
    const cleared = await caches.delete(CACHE_NAME);
    document.dispatchEvent(new CustomEvent('vcard:media-cache-change'));
    return cleared;
  };
  return {
    CACHE_NAME,
    cacheLoadedMedia,
    cacheLoadedNonAudioMedia,
    cacheUrls,
    clear,
    getStats,
    manifestStats,
    preloadAll,
  };
})();

window.vcardMediaCache = vcardMediaCache;

const vcardSettingEnabled = (storageKey, defaultName, fallback = 'on') => (
  vcardStoredSetting(storageKey, defaultName, fallback).toLowerCase() !== 'off'
);

const vcardHorizontalWaveBounds = () => {
  const viewportHeight = window.innerHeight;
  const portalSpaceMinimum = 0.5;
  const portal = document.querySelector(
    '.song__preview.is-visible .song-portal-stage:not([hidden])'
  );
  const rect = portal && portal.getBoundingClientRect();
  if (
    rect
    && rect.height > 0
    && rect.bottom > 0
    && rect.top < viewportHeight
  ) {
    const top = Math.max(0, Math.min(viewportHeight, rect.bottom));
    const spaceBelow = viewportHeight - top;
    if (spaceBelow > 1 && spaceBelow >= viewportHeight * portalSpaceMinimum) {
      return { top, bottom: viewportHeight, height: spaceBelow };
    }
  }
  return { top: 0, bottom: viewportHeight, height: viewportHeight };
};

const vcardUiConfig = window.VCardUI || {};
const vcardHints = vcardUiConfig.hints || {};

const playerText = {
  play: 'Play',
  pause: 'Pause',
  mute: 'Mute',
  unmute: 'Unmute',
  volume: 'Volume',
  seek: 'Seek',
  seekLabel: '{seek}: {currentTime} из {duration}',
  close: 'ЗАКРЫТЬ',
  previousTrack: 'Previous track',
  nextTrack: 'Next track',
  ...(vcardUiConfig.player || {}),
};

const ensurePlyrIconSprite = () => {
  if (document.getElementById('vcard-plyr-icons')) return;
  const sprite = document.createElement('div');
  sprite.id = 'vcard-plyr-icons';
  sprite.hidden = true;
  sprite.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <symbol id="plyr-play" viewBox="0 0 18 18"><path d="M15.562 8.1 3.87.225c-.818-.562-1.87 0-1.87.9v15.75c0 .9 1.052 1.462 1.87.9L15.563 9.9c.584-.45.584-1.35 0-1.8"/></symbol>
      <symbol id="plyr-pause" viewBox="0 0 18 18"><path d="M6 1H3c-.6 0-1 .4-1 1v14c0 .6.4 1 1 1h3c.6 0 1-.4 1-1V2c0-.6-.4-1-1-1m6 0c-.6 0-1 .4-1 1v14c0 .6.4 1 1 1h3c.6 0 1-.4 1-1V2c0-.6-.4-1-1-1z"/></symbol>
      <symbol id="plyr-volume" viewBox="0 0 18 18"><path d="M15.6 3.3c-.4-.4-1-.4-1.4 0s-.4 1 0 1.4C15.4 5.9 16 7.4 16 9s-.6 3.1-1.8 4.3c-.4.4-.4 1 0 1.4.2.2.5.3.7.3.3 0 .5-.1.7-.3C17.1 13.2 18 11.2 18 9s-.9-4.2-2.4-5.7"/><path d="M11.282 5.282a.91.91 0 0 0 0 1.316c.735.735.995 1.458.995 2.402 0 .936-.425 1.917-.995 2.487a.91.91 0 0 0 0 1.316c.145.145.636.262 1.018.156a.7.7 0 0 0 .298-.156C13.773 11.733 14.13 10.16 14.13 9q.001-.255-.011-.51c-.053-.992-.319-2.005-1.522-3.208a.91.91 0 0 0-1.316 0m-7.495.726H.714C.286 6.008 0 6.31 0 6.76v4.512c0 .452.286.752.714.752h3.072l4.071 3.858c.5.3 1.143 0 1.143-.602V2.752c0-.601-.643-.977-1.143-.601z"/></symbol>
      <symbol id="plyr-muted" viewBox="0 0 18 18"><path d="m12.4 12.5 2.1-2.1 2.1 2.1 1.4-1.4L15.9 9 18 6.9l-1.4-1.4-2.1 2.1-2.1-2.1L11 6.9 13.1 9 11 11.1zM3.786 6.008H.714C.286 6.008 0 6.31 0 6.76v4.512c0 .452.286.752.714.752h3.072l4.071 3.858c.5.3 1.143 0 1.143-.602V2.752c0-.601-.643-.977-1.143-.601z"/></symbol>
      <symbol id="plyr-previous-track" viewBox="0 0 18 18"><path d="M2 3h2v12H2zM16 3 6 9l10 6z"/></symbol>
      <symbol id="plyr-next-track" viewBox="0 0 18 18"><path d="m2 3 10 6-10 6zM14 3h2v12h-2z"/></symbol>
    </svg>`;
  document.body.prepend(sprite);
};

const ensurePageSideFade = () => {
  let layer = document.querySelector('.vc-page-side-fade');
  if (layer) return layer;
  layer = document.createElement('div');
  layer.className = 'vc-page-side-fade';
  layer.setAttribute('aria-hidden', 'true');
  document.body.prepend(layer);
  return layer;
};

ensurePageSideFade();

const publishPlayerMp3Info = (preview) => {
  document.dispatchEvent(new CustomEvent('vcard:mp3-info-change', {
    detail: {
      text: preview
        ? (preview.dataset.downloadTitle || preview.dataset.downloadName || '')
        : ''
    }
  }));
};

const sharedSongAudio = (() => {
  const firstHost = document.querySelector('[ids="audio"][data-audio-src]');
  const audio = document.createElement('audio');
  audio.className = 'song__audio block-full';
  audio.controls = true;
  audio.preload = 'none';
  audio.dataset.sharedPlayer = 'true';
  (firstHost || document.body).append(audio);
  return audio;
})();

// A completed song commits the media already used by this VCard session into
// the managed cache. Subsequent visits are served by sw.js without another download.
sharedSongAudio?.addEventListener('ended', () => {
  vcardMediaCache.cacheLoadedMedia();
});

/*
 * Song portal transmission state machine.
 *
 * The photo portal remains the base layer: verse tracking and its slideshow
 * keep running while a translucent hands or cassette insert is briefly
 * visible. A seek cancels the current insert and restores a clean portal;
 * subsequent natural verse boundaries start complete inserts again.
 */
(() => {
  if (!sharedSongAudio) return;

  // User-owned animation sets.  A slot may replace v_fin1/v_fin2 with its
  // own media while retaining the same PortalTV contract.
  const FINISH_LIST = 'usr/v_fin1/list.js';
  const HANDS_LIST = 'usr/v_fin2/list.js';
  let portalMotionAllowed = document.documentElement.dataset.visBri !== '0';

  const randomBetween = (minimum, maximum) => (
    minimum + Math.random() * Math.max(0, maximum - minimum)
  );
  const randomInteger = (minimum, maximum) => Math.round(randomBetween(minimum, maximum));
  const mediaUrl = (path) => new URL(path, document.baseURI).href;
  const finishListUrl = mediaUrl(FINISH_LIST);
  const handsListUrl = mediaUrl(HANDS_LIST);

  const state = {
    preview: null,
    frame: null,
    layer: null,
    image: null,
    video: null,
    title: null,
    titleText: null,
    action: null,
    controls: null,
    clickFrame: null,
    generation: 0,
    phase: 'start',
    started: false,
    firstVerseActivated: false,
    activeInsert: null,
    scheduledInsertVerseIndex: -1,
    nextInsertKind: 'hands',
    endSequenceStarted: false,
    finishMedia: null,
    finishPromise: null,
    finishPosterPreload: null,
    handsItems: null,
    handsPromise: null,
    handsBag: [],
    lastHandSource: '',
    lastStarts: new Map(),
  };

  const portalVideo = () => {
    if (state.video) return state.video;
    const video = document.createElement('video');
    video.className = 'song-portal-video';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.disablePictureInPicture = true;
    video.setAttribute('aria-hidden', 'true');
    video.addEventListener('error', () => {
      // A missing auxiliary clip must leave the existing photo portal usable.
      if (state.phase !== 'photo') showPhoto();
    });
    state.video = video;
    return video;
  };

  const portalTitle = () => {
    if (state.title) return state.title;
    const title = document.createElement('div');
    title.className = 'song-portal-title';
    title.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'song-portal-title__text';
    title.append(text);
    state.title = title;
    state.titleText = text;
    return title;
  };

  const portalAction = () => {
    if (state.action) return state.action;
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'song-portal-action';
    action.setAttribute('aria-label', 'Воспроизвести');
    action.innerHTML = '<span class="song-portal-action__icon" aria-hidden="true"></span>';
    state.action = action;
    return action;
  };

  const portalControls = () => {
    if (state.controls) return state.controls;
    const controls = document.createElement('div');
    controls.className = 'song-portal-controls';
    controls.setAttribute('aria-hidden', 'true');
    controls.append(portalTitle(), portalAction());
    state.controls = controls;
    return controls;
  };

  const setPortalTitle = (preview) => {
    const item = preview && preview.previousElementSibling?.querySelector('.song__item');
    const source = item && (
      item.querySelector('.song__player-title') || item.querySelector('.song__item-text')
    );
    const copy = source && source.cloneNode(true);
    if (copy) copy.querySelectorAll('.record-braces').forEach((node) => node.remove());
    portalTitle().querySelector('.song-portal-title__text').textContent = String(
      (copy && copy.textContent) || (source && source.textContent) || ''
    ).replace(/\s+/g, ' ').trim();
  };

  const setVideoSource = (source, { poster = '' } = {}) => {
    const video = portalVideo();
    if (video.poster !== poster) video.poster = poster;
    if (video.dataset.portalSource === source) return video;
    video.pause();
    video.dataset.portalSource = source;
    video.src = source;
    video.load();
    return video;
  };

  const ensurePortal = (preview) => {
    const image = preview && preview.querySelector('.song__preview-image');
    const frame = image && image.closest('.song-vibeframe');
    if (!image || !frame) return false;
    const layer = vcardMedia.ensurePortalMotionLayer(image);
    if (!layer) return false;
    const video = portalVideo();
    const controls = portalControls();
    if (video.parentElement !== layer) {
      video.pause();
      layer.append(video);
    }
    if (controls.parentElement !== layer) layer.append(controls);
    if (state.clickFrame !== frame) {
      if (state.clickFrame) {
        state.clickFrame.removeEventListener('click', onPortalClick, true);
        state.clickFrame.removeEventListener('pointerdown', onPortalMiddlePress, true);
      }
      frame.addEventListener('click', onPortalClick, true);
      frame.addEventListener('pointerdown', onPortalMiddlePress, true);
      state.clickFrame = frame;
    }
    state.preview = preview;
    state.frame = frame;
    state.layer = layer;
    state.image = image;
    return true;
  };

  const setPhase = (phase) => {
    state.phase = phase;
    if (state.frame) state.frame.dataset.transmission = phase;
    const video = portalVideo();
    video.classList.toggle(
      'is-visible',
      portalMotionAllowed && phase !== 'photo' && phase !== 'pause'
    );
    if (state.title) {
      state.title.classList.toggle(
        'is-visible',
        phase === 'start'
          || (phase === 'play' && !state.firstVerseActivated)
      );
    }
    if (state.action) {
      const isStart = phase === 'start';
      const isPause = phase === 'pause';
      state.action.classList.toggle('is-visible', isStart || isPause);
      state.action.dataset.action = isPause ? 'resume' : 'play';
      state.action.setAttribute('aria-label', isPause ? 'Продолжить' : 'Воспроизвести');
    }
  };

  const showPhoto = () => {
    state.activeInsert = null;
    const video = state.video;
    setPhase('photo');
    if (!video) return;
    const stopAfterFade = () => {
      if (state.phase === 'photo' && state.video === video) {
        video.pause();
      }
    };
    video.addEventListener('transitionend', (event) => {
      if (event.propertyName === 'opacity') stopAfterFade();
    }, { once: true });
    window.setTimeout(stopAfterFade, vcardMagicTimeMilliseconds + 100);
  };

  // Seeking must never reveal a partly completed insert.  Hide the video in
  // the same frame, then restore its normal CSS transition for later live
  // verse changes.
  const showPhotoImmediately = () => {
    state.activeInsert = null;
    const video = state.video;
    if (!video) {
      setPhase('photo');
      return;
    }
    video.style.transition = 'none';
    video.style.opacity = '0';
    setPhase('photo');
    video.pause();
    requestAnimationFrame(() => {
      if (state.phase !== 'photo' || state.video !== video) return;
      video.style.removeProperty('transition');
      video.style.removeProperty('opacity');
    });
  };

  const loadFinishMedia = () => {
    if (state.finishMedia) return Promise.resolve(state.finishMedia);
    if (state.finishPromise) return state.finishPromise;
    state.finishPromise = vcardMedia.loadList(finishListUrl)
      .then((items) => {
        const sources = items.map((item) => vcardMedia.listItemUrl(finishListUrl, item));
        const video = sources.find((source) => /\.(?:mp4|webm|ogv|m4v|mov)(?:[?#].*)?$/i.test(source));
        const poster = sources.find((source) => /\.(?:avif|gif|jpe?g|png|webp)(?:[?#].*)?$/i.test(source));
        if (!video || !poster) {
          throw new Error('v_fin1 needs one video and one graphic file');
        }
        state.finishMedia = { video, poster };
        const posterPreload = new Image();
        posterPreload.src = poster;
        state.finishPosterPreload = posterPreload;
        return state.finishMedia;
      })
      .catch((error) => {
        console.warn('VCard portal: cannot load v_fin1 media', error);
        return null;
      })
      .finally(() => { state.finishPromise = null; });
    return state.finishPromise;
  };

  const showTape = ({
    play = false,
    reset = false,
    phase = 'play',
    allowEndedPlayback = false,
  } = {}) => {
    if (!state.preview || !ensurePortal(state.preview)) return;
    state.activeInsert = null;
    const generation = state.generation;
    loadFinishMedia().then((media) => {
      if (
        !media
        || generation !== state.generation
        || !state.preview
        || !ensurePortal(state.preview)
      ) return;
      const shouldPlay = (
        play
        && portalMotionAllowed
        && (allowEndedPlayback || (!sharedSongAudio.paused && !sharedSongAudio.ended))
      );
      const video = shouldPlay
        ? setVideoSource(media.video, { poster: media.poster })
        : portalVideo();
      if (!shouldPlay) {
        video.pause();
        if (video.dataset.portalSource) {
          delete video.dataset.portalSource;
          video.removeAttribute('src');
          video.load();
        }
        video.poster = media.poster;
      }
      video.dataset.portalKind = 'tape';
      delete video.dataset.portalOverlay;
      video.loop = true;
      if (reset && shouldPlay) {
        const resetFrame = () => {
          try { video.currentTime = 0; } catch (_error) { }
        };
        if (video.readyState >= 1) resetFrame();
        else video.addEventListener('loadedmetadata', resetFrame, { once: true });
      }
      setPhase(phase);
      if (shouldPlay) {
        playVCardAnimation(video);
      } else {
        video.pause();
      }
    });
  };

  const startPortalPlayback = () => {
    if (!state.preview || sharedSongAudio.ended) return;
    document.dispatchEvent(new CustomEvent('vcard:prepare-audio-context'));
    sharedSongAudio.play().catch((error) => {
      console.warn('VCard portal: cannot start playback', error);
    });
  };

  const onPortalClick = (event) => {
    const isPlayingStage = ['play', 'photo', 'overlay'].includes(state.phase);
    if (!(state.phase === 'start' || state.phase === 'pause' || isPlayingStage) || event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (state.phase === 'start') {
      document.dispatchEvent(new CustomEvent('vcard:play-single-song', {
        detail: { preview: state.preview }
      }));
    }
    if (sharedSongAudio.paused || sharedSongAudio.ended) startPortalPlayback();
    else sharedSongAudio.pause();
  };

  const chooseHandStart = (source, duration, showDuration) => {
    const maximum = Math.max(0, duration - showDuration);
    const previous = state.lastStarts.get(source);
    let result = randomBetween(0, maximum);
    if (Number.isFinite(previous) && maximum >= vcardMagicTimeSeconds) {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const candidate = randomBetween(0, maximum);
        if (Math.abs(candidate - previous) >= vcardMagicTimeSeconds) {
          result = candidate;
          break;
        }
      }
    }
    state.lastStarts.set(source, result);
    return result;
  };

  const loadHandsItems = () => {
    if (state.handsItems) return Promise.resolve(state.handsItems);
    if (state.handsPromise) return state.handsPromise;
    state.handsPromise = vcardMedia.loadList(handsListUrl)
      .then((items) => {
        state.handsItems = items.map((item) => vcardMedia.listItemUrl(handsListUrl, item));
        return state.handsItems;
      })
      .catch((error) => {
        console.warn('VCard portal: cannot load hands media', error);
        state.handsItems = [];
        return state.handsItems;
      })
      .finally(() => { state.handsPromise = null; });
    return state.handsPromise;
  };

  const takeHandSource = (items) => {
    if (!state.handsBag.length) {
      state.handsBag = [...items];
      for (let index = state.handsBag.length - 1; index > 0; index -= 1) {
        const swapIndex = randomInteger(0, index);
        [state.handsBag[index], state.handsBag[swapIndex]] = [
          state.handsBag[swapIndex],
          state.handsBag[index],
        ];
      }
      // Do not repeat the last item across a bag boundary when another item exists.
      if (state.handsBag.length > 1 && state.handsBag.at(-1) === state.lastHandSource) {
        const replacement = state.handsBag.findIndex((item) => item !== state.lastHandSource);
        [state.handsBag[state.handsBag.length - 1], state.handsBag[replacement]] = [
          state.handsBag[replacement], state.handsBag[state.handsBag.length - 1],
        ];
      }
    }
    const source = state.handsBag.pop();
    state.lastHandSource = source;
    return source;
  };

  const startHandsInsert = (slot) => {
    const generation = state.generation;
    state.activeInsert = slot;
    loadHandsItems().then((items) => {
      if (
        generation !== state.generation
        || state.activeInsert !== slot
        || !items.length
        || !ensurePortal(state.preview)
      ) {
        if (state.activeInsert === slot) showPhoto();
        return;
      }
      const source = slot.handSource || takeHandSource(items);
      slot.handSource = source;
      const video = setVideoSource(source);
      video.dataset.portalKind = 'hands';
      video.dataset.portalOverlay = 'on';
      video.loop = false;
      const begin = () => {
        if (generation !== state.generation || state.activeInsert !== slot) return;
        const now = Number(sharedSongAudio.currentTime) || 0;
        if (
          now >= (slot.fadeOutStartsAt ?? slot.fadeStartsAt)
          && !Number.isFinite(slot.videoTime)
        ) {
          showPhoto();
          return;
        }
        const duration = Number(video.duration);
        if (!Number.isFinite(duration) || duration <= 0) {
          showPhoto();
          return;
        }
        try {
          const handStart = Number.isFinite(slot.handStart)
            ? slot.handStart
            : chooseHandStart(source, duration, slot.duration);
          slot.handStart = handStart;
          const offset = Number.isFinite(slot.videoTime) ? slot.videoTime : handStart;
          video.currentTime = Math.min(Math.max(0, offset), Math.max(0, duration - 0.05));
        } catch (_error) { }
        setPhase('overlay');
        if (portalMotionAllowed && !sharedSongAudio.paused && !sharedSongAudio.ended) {
          playVCardAnimation(video);
        }
      };
      if (video.readyState >= 1) begin();
      else video.addEventListener('loadedmetadata', begin, { once: true });
    });
  };

  const startTapeInsert = (slot) => {
    const generation = state.generation;
    state.activeInsert = slot;
    if (!ensurePortal(state.preview)) {
      showPhoto();
      return;
    }
    loadFinishMedia().then((media) => {
      if (!media || generation !== state.generation || state.activeInsert !== slot) return;
      const video = setVideoSource(media.video, { poster: media.poster });
      video.dataset.portalKind = 'tape';
      video.dataset.portalOverlay = 'on';
      video.loop = true;
      const begin = () => {
        if (generation !== state.generation || state.activeInsert !== slot) return;
        try {
          video.currentTime = Number.isFinite(slot.videoTime)
            ? Math.max(0, slot.videoTime)
            : 0;
        } catch (_error) { }
        setPhase('overlay');
        if (portalMotionAllowed && !sharedSongAudio.paused && !sharedSongAudio.ended) {
          playVCardAnimation(video);
        }
      };
      if (video.readyState >= 1) begin();
      else video.addEventListener('loadedmetadata', begin, { once: true });
    });
  };

  const startInsert = (slot) => {
    if (!portalMotionAllowed || state.endSequenceStarted) return;
    const kind = state.nextInsertKind;
    state.nextInsertKind = kind === 'hands' ? 'tape' : 'hands';
    if (kind === 'hands') startHandsInsert(slot);
    else startTapeInsert(slot);
  };

  const startManualHandsInsert = (startsAt) => {
    if (!portalMotionAllowed || state.endSequenceStarted) return;
    state.generation += 1;
    const slot = {
      ...makeInsertSlot(startsAt),
      kind: 'hands',
      manual: true,
    };
    startHandsInsert(slot);
  };

  const onPortalMiddlePress = (event) => {
    if (event.button !== 1) return;
    if (!['play', 'photo', 'overlay'].includes(state.phase)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!state.preview || sharedSongAudio.paused || sharedSongAudio.ended) return;
    // Middle click is an explicit hands-only preview, independent from the
    // verse alternation, so it is useful for checking the overlay treatment.
    startManualHandsInsert(Number(sharedSongAudio.currentTime) || 0);
  };

  const makeInsertSlot = (startsAt) => {
    const fadeStartsAt = startsAt + vcardMagicTimeSeconds * 2;
    const endsAt = fadeStartsAt + vcardMagicTimeSeconds;
    return {
      startsAt,
      duration: endsAt - startsAt,
      fadeStartsAt,
      endsAt,
    };
  };

  const makeVerseEndInsertSlot = (verseEndsAt) => {
    const startsAt = Math.max(
      0,
      verseEndsAt - vcardMagicTimeSeconds - vcardMagicHoldTimeSeconds
    );
    const fadeOutStartsAt = verseEndsAt + vcardMagicHoldTimeSeconds;
    const endsAt = fadeOutStartsAt + vcardMagicTimeSeconds;
    return {
      startsAt,
      duration: endsAt - startsAt,
      boundaryAt: verseEndsAt,
      fadeOutStartsAt,
      endsAt,
    };
  };

  const parseTrackBandTimes = (value) => String(value || '')
    .split('-')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const parts = item.split(':').map(Number);
      if (parts.some((part) => !Number.isFinite(part))) return NaN;
      return parts.reduce((total, part) => total * 60 + part, 0);
    })
    .filter((time) => Number.isFinite(time) && time >= 0);

  const resetPortalAfterSeek = () => {
    if (!state.preview || state.preview.hidden) return;
    state.generation += 1;
    state.activeInsert = null;
    state.scheduledInsertVerseIndex = -1;
    state.endSequenceStarted = false;
    const text = state.preview.querySelector('.song__preview-text[data-track-band]');
    const firstVerseAt = parseTrackBandTimes(text && text.dataset.trackBand)[0];
    const now = Number(sharedSongAudio.currentTime) || 0;
    const beforeFirstVerse = Number.isFinite(firstVerseAt) && now < firstVerseAt;

    if (beforeFirstVerse) {
      state.firstVerseActivated = false;
      showTape({
        play: !sharedSongAudio.paused && !sharedSongAudio.ended,
        phase: 'play',
      });
      return;
    }

    // A position inside a verse always gets a clean still portal.  The next
    // natural verse boundary may start a complete insert on its own.
    state.firstVerseActivated = true;
    showPhotoImmediately();
  };

  const startTrackEndSequence = () => {
    if (state.endSequenceStarted || !state.preview) return;
    state.endSequenceStarted = true;
    state.activeInsert = null;
    showTape({
      play: true,
      reset: true,
      phase: 'finish',
      allowEndedPlayback: true,
    });
  };

  const scheduleTrackEndSequence = () => {
    const duration = Number(sharedSongAudio.duration);
    const currentTime = Number(sharedSongAudio.currentTime) || 0;
    if (
      Number.isFinite(duration)
      && duration > 0
      && currentTime >= Math.max(0, duration - vcardMagicTimeSeconds)
      && (!sharedSongAudio.paused || sharedSongAudio.ended)
    ) {
      startTrackEndSequence();
    }
  };

  const update = ({ seeked = false } = {}) => {
    if (!state.preview || state.preview.hidden) return;
    const now = Number(sharedSongAudio.currentTime) || 0;
    if (sharedSongAudio.ended) return;
    if (seeked) {
      resetPortalAfterSeek();
      return;
    }
    if (state.phase === 'overlay') {
      if (
        !state.activeInsert
        || now >= (state.activeInsert.fadeOutStartsAt ?? state.activeInsert.fadeStartsAt)
      ) showPhoto();
      else return;
    }
  };

  const selectTrack = (preview) => {
    if (!ensurePortal(preview)) return;
    state.generation += 1;
    state.started = false;
    state.activeInsert = null;
    state.scheduledInsertVerseIndex = -1;
    // The first verse boundary uses hands; subsequent boundaries alternate.
    // The track-end sequence is independent and always forces the cassette.
    state.nextInsertKind = 'hands';
    state.firstVerseActivated = false;
    state.endSequenceStarted = false;
    setPortalTitle(preview);
    // Switch away from the photo immediately. The cassette manifest may still
    // be resolving, but the portal must not retain an old photo/finish phase.
    setPhase('start');
    showTape({ reset: true, phase: 'start' });
  };

  // This cassette is shared by every song; warm its manifest and poster before
  // the first portal is opened so the opening card can paint immediately.
  // Defer until the rest of this script has initialized `vcardMedia`.
  queueMicrotask(loadFinishMedia);

  document.addEventListener('vcard:portal-open', (event) => {
    const detail = event.detail || {};
    selectTrack(detail.preview);
    if (detail.continuesPlayback) {
      state.started = true;
      showTape({ play: true, phase: 'play' });
    }
  });

  document.addEventListener('vcard:visualization-state', (event) => {
    const brightnessLevel = Number(event.detail && event.detail.brightnessLevel);
    const nextAllowed = brightnessLevel > 0;
    if (nextAllowed === portalMotionAllowed) return;
    portalMotionAllowed = nextAllowed;
    const video = state.video;
    if (!video) return;
    if (!portalMotionAllowed) {
      video.pause();
      video.classList.remove('is-visible');
      return;
    }
    setPhase(state.phase);
    if (
      ['play', 'overlay', 'finish'].includes(state.phase)
      && (state.phase === 'finish' || (!sharedSongAudio.paused && !sharedSongAudio.ended))
    ) {
      playVCardAnimation(video);
    }
  });

  document.addEventListener('vcard:song-close', (event) => {
    const preview = event.target && event.target.closest('.song__preview');
    if (preview !== state.preview) return;
    state.activeInsert = null;
    freezeVCardVideo(state.video);
  });

  document.addEventListener('vcard:track-verse-pre-end', (event) => {
    const detail = event.detail || {};
    if (detail.preview !== state.preview) return;
    if (
      detail.seeked
      || (state.activeInsert && state.activeInsert.manual)
      || !Number.isInteger(detail.index)
      || !Number.isFinite(detail.endsAt)
      || state.endSequenceStarted
      || detail.index <= state.scheduledInsertVerseIndex
      || sharedSongAudio.paused
      || sharedSongAudio.ended
    ) return;
    state.scheduledInsertVerseIndex = detail.index;
    startInsert(makeVerseEndInsertSlot(detail.endsAt));
  });

  document.addEventListener('vcard:track-verse-active', (event) => {
    const detail = event.detail || {};
    if (detail.preview !== state.preview) return;
    if (detail.seeked) {
      state.firstVerseActivated = Number.isInteger(detail.index) && detail.index >= 0;
      return;
    }
    if (detail.index === 0) {
      state.firstVerseActivated = true;
      if (!sharedSongAudio.paused && !sharedSongAudio.ended) showPhoto();
      return;
    }
    const portalImage = state.preview && state.preview.querySelector('.song__preview-image');
    if (!portalImage) return;
    const handsOverlay = (
      state.video
      && state.video.dataset.portalKind === 'hands'
      && state.video.dataset.portalOverlay === 'on'
      && state.video.classList.contains('is-visible')
    );
    // A cassette masks a direct swap.  Hands remain an opaque overlay, so the
    // portal beneath them changes with a deliberately short one-second fade.
    vcardMedia.randomNext(
      portalImage,
      handsOverlay,
      handsOverlay ? vcardMagicShortTimeSeconds : 0
    );
  });

  sharedSongAudio.addEventListener('loadedmetadata', () => {
    if (!state.preview) return;
    update({ seeked: true });
  });
  sharedSongAudio.addEventListener('play', () => {
    if (!state.preview) return;
    const resumesAfterVerse = state.phase === 'pause' && state.firstVerseActivated;
    if (state.phase === 'start' || state.phase === 'pause' || !state.started) {
      state.started = true;
      showTape({ play: true, phase: 'play' });
      if (resumesAfterVerse) showPhotoImmediately();
    } else if (portalMotionAllowed && (state.phase === 'play' || state.phase === 'overlay')) {
      playVCardAnimation(portalVideo());
    }
    update();
  });
  sharedSongAudio.addEventListener('pause', () => {
    if (!state.preview || sharedSongAudio.ended) return;
    showTape({ reset: true, phase: 'pause' });
  });
  sharedSongAudio.addEventListener('timeupdate', () => {
    scheduleTrackEndSequence();
    update();
  });
  sharedSongAudio.addEventListener('seeked', () => {
    update({ seeked: true });
    scheduleTrackEndSequence();
  });
  sharedSongAudio.addEventListener('ended', () => {
    if (!state.preview) return;
    startTrackEndSequence();
    // The cassette spins through the final audio sample and only then
    // becomes the graphic static cassette from v_fin1.
    if (state.phase === 'finish') showTape({ phase: 'finish' });
  });
})();

(() => {
  const STORAGE_KEY = 'vcard-visualization';
  const BRIGHTNESS_STORAGE_KEY = 'vcard-visualization-brightness';
  const BRIGHTNESS_LEVEL_COUNT = 6;
  const LEGACY_STORAGE_KEY = 'vcard-spectrum';
  const MODE_OFF = 'off';
  const MODE_HORIZONTAL = 'h';
  const MODE_VERTICAL = 'v';
  const defaultMode = ({
    off: MODE_OFF,
    horizontal: MODE_HORIZONTAL,
    vertical: MODE_VERTICAL,
    h: MODE_HORIZONTAL,
    v: MODE_VERTICAL,
  })[vcardCssDefault('visualization', 'vertical').toLowerCase()] || MODE_VERTICAL;
  const defaultBrightness = Number.parseInt(
    vcardCssDefault('visualization-brightness', '2'),
    10
  );
  const DEFAULT_BRIGHTNESS_LEVEL = Number.isInteger(defaultBrightness)
    ? Math.max(0, Math.min(BRIGHTNESS_LEVEL_COUNT - 1, defaultBrightness))
    : 0;

  // A file:// page cannot use the Web Audio analyser, but the same brightness
  // control also drives the wallpaper and smoke-video opacity.  Keep that
  // state available when the page is opened directly from a folder.
  if (vcardFileMode) {
    const root = document.documentElement;
    let brightnessLevel = Number.parseInt(localStorage.getItem(BRIGHTNESS_STORAGE_KEY), 10);
    if (!Number.isInteger(brightnessLevel) || brightnessLevel < 0 || brightnessLevel >= BRIGHTNESS_LEVEL_COUNT) {
      brightnessLevel = DEFAULT_BRIGHTNESS_LEVEL;
    }
    const applyBrightnessLevel = (nextLevel, force = false) => {
      const clampedLevel = Math.max(0, Math.min(BRIGHTNESS_LEVEL_COUNT - 1, nextLevel));
      if (!force && clampedLevel === brightnessLevel) return;
      brightnessLevel = clampedLevel;
      localStorage.setItem(BRIGHTNESS_STORAGE_KEY, String(brightnessLevel));
      root.dataset.visBri = String(brightnessLevel);
      document.dispatchEvent(new CustomEvent('vcard:visualization-state', {
        detail: { mode: MODE_OFF, brightnessLevel }
      }));
    };
    document.addEventListener('vcard:toggle-visualization-brightness', () => {
      applyBrightnessLevel(brightnessLevel + 1);
    });
    document.addEventListener('vcard:step-visualization-brightness', (event) => {
      const delta = Number(event.detail && event.detail.delta);
      if (!Number.isInteger(delta) || delta === 0) return;
      applyBrightnessLevel(brightnessLevel + delta);
    });
    document.addEventListener('vcard:set-visualization-brightness', (event) => {
      const requestedLevel = Number(event.detail && event.detail.level);
      if (!Number.isInteger(requestedLevel) || requestedLevel < 0 || requestedLevel >= BRIGHTNESS_LEVEL_COUNT) return;
      applyBrightnessLevel(requestedLevel);
    });
    document.addEventListener('vcard:request-visualization-state', () => {
      document.dispatchEvent(new CustomEvent('vcard:visualization-state', {
        detail: { mode: MODE_OFF, brightnessLevel }
      }));
    });
    applyBrightnessLevel(brightnessLevel, true);
    return;
  }

  const audios = sharedSongAudio ? [sharedSongAudio] : [];
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!audios.length || !AudioContextClass) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'audio-spectrum';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);

  const canvasContext = canvas.getContext('2d', {
    alpha: true,
    desynchronized: true,
  });
  let audioContext = null;
  let analyser = null;
  let waveformData = null;
  let frequencyData = null;
  const mediaSources = [];
  let animationFrame = 0;
  let lastVisualizationFrame = 0;
  const storedVisualizationMode = localStorage.getItem(STORAGE_KEY);
  const legacyVisualizationMode = localStorage.getItem(LEGACY_STORAGE_KEY);
  let visualizationMode = storedVisualizationMode || (
    legacyVisualizationMode === null
      ? defaultMode
      : (legacyVisualizationMode === 'on' ? MODE_HORIZONTAL : MODE_VERTICAL)
  );
  let brightnessLevel = Number.parseInt(localStorage.getItem(BRIGHTNESS_STORAGE_KEY), 10);
  let smoothedAmplitude = 0;
  let lastWaveformSample = 0;
  let horizontalScale = 1;
  let horizontalScaleTarget = 1;
  let horizontalScaleStartedAt = 0;
  let horizontalScaleCalibrated = false;
  let horizontalNoiseFloor = 0;
  let horizontalNoiseFloorTarget = 0;
  let horizontalNoiseFloorUpdatedAt = 0;
  let horizontalNoiseFloorReady = false;
  let horizontalUpperShape = 1;
  let horizontalLowerShape = 1;
  let lastVerticalFrame = 0;
  const lowPowerVisualization = window.matchMedia('(pointer: coarse)').matches;
  const waveformHistory = [];
  const visualizationFrameInterval = Math.max(
    16,
    30
  );
  const visualizationPixelRatio = Math.max(
    0.5,
    Math.min(
      window.devicePixelRatio || 1,
      1
    )
  );
  const requestedFftSize = Math.round(
    512
  );
  const visualizationFftSize = [32, 64, 128, 256, 512, 1024, 2048]
    .reduce((best, size) => (
      Math.abs(size - requestedFftSize) < Math.abs(best - requestedFftSize)
        ? size
        : best
    ), 512);
  const horizontalSampleInterval = Math.max(
    25,
    lowPowerVisualization ? 100 : 80
  );
  const horizontalScrollSpeed = Math.max(
    10,
    90
  );
  const horizontalColumnStep = horizontalScrollSpeed * horizontalSampleInterval / 1000;
  const horizontalBarWidth = Math.max(
    1,
    Math.min(
      horizontalColumnStep,
      6
    )
  );
  const HORIZONTAL_VIEWPORT_MARGIN = Math.max(
    0,
    Math.min(
      0.49,
      0.04
    )
  );
  const HORIZONTAL_RESPONSE_CURVE = Math.max(
    0.1,
    Math.min(
      1,
      0.6
    )
  );
  const HORIZONTAL_DEAD_ZONE_PERCENTILE = Math.max(
    0,
    Math.min(
      0.5,
      0.05
    )
  );
  const HORIZONTAL_DEAD_ZONE_CUT = Math.max(
    0,
    Math.min(
      1,
      0.8
    )
  );
  const HORIZONTAL_DEAD_ZONE_INTERVAL = Math.max(
    250,
    1000
  );
  const HORIZONTAL_ASYMMETRY = Math.max(
    0,
    Math.min(
      0.45,
      0.5
    )
  );
  const HORIZONTAL_ASYMMETRY_SMOOTHING = Math.max(
    0.01,
    Math.min(
      1,
      0.1
    )
  );
  const HORIZONTAL_SCALE_INTERVAL = Math.max(
    250,
    2000
  );
  const HORIZONTAL_SCALE_TARGET = Math.max(
    0.5,
    Math.min(
      1,
      0.96
    )
  );
  const HORIZONTAL_SCALE_MAX = Math.max(
    1,
    6
  );
  const VERTICAL_BAR_COUNT = Math.max(
    1,
    40
  );
  const VERTICAL_RELEASE_RATE = Math.max(
    0,
    Math.min(1, 0.06)
  );
  const verticalAmplitudes = Array.from(
    { length: VERTICAL_BAR_COUNT },
    () => 0
  );

  if (![MODE_OFF, MODE_HORIZONTAL, MODE_VERTICAL].includes(visualizationMode)) {
    visualizationMode = MODE_VERTICAL;
  }
  if (!Number.isInteger(brightnessLevel) || brightnessLevel < 0 || brightnessLevel >= BRIGHTNESS_LEVEL_COUNT) {
    brightnessLevel = DEFAULT_BRIGHTNESS_LEVEL;
  }

  let cachedVisualizationColor = '';
  let visualizationColorReadAt = 0;
  const visualizationColor = (timestamp = performance.now()) => {
    if (!cachedVisualizationColor || timestamp - visualizationColorReadAt >= 250) {
      const pageColor = getComputedStyle(document.documentElement)
        .getPropertyValue('--vc-page')
        .trim();
      cachedVisualizationColor = pageColor || getComputedStyle(document.body).color;
      visualizationColorReadAt = timestamp;
    }
    return cachedVisualizationColor;
  };

  const horizontalAdjustedAmplitude = (amplitude) => Math.max(
    0,
    amplitude - horizontalNoiseFloor * HORIZONTAL_DEAD_ZONE_CUT
  );

  const verticalWaveBounds = () => {
    const probe = document.querySelector('.vcard-player-dock.block-mid')
      || document.querySelector('.list.block-mid:not([hidden])')
      || document.querySelector('.block-mid:not([hidden])');
    const rect = probe && probe.getBoundingClientRect();
    if (rect && rect.width > 0) {
      const left = Math.max(0, rect.left);
      const right = Math.min(window.innerWidth, rect.right);
      if (right > left) {
        return {
          left,
          right,
          width: right - left,
        };
      }
    }
    return {
      left: 0,
      right: window.innerWidth,
      width: window.innerWidth,
    };
  };

  const resizeCanvas = () => {
    const pixelRatio = visualizationPixelRatio;
    canvas.width = Math.round(window.innerWidth * pixelRatio);
    canvas.height = Math.round(window.innerHeight * pixelRatio);
    canvasContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    cachedHorizontalBounds = vcardHorizontalWaveBounds();
  };

  let cachedHorizontalBounds = vcardHorizontalWaveBounds();
  let horizontalBoundsFrame = 0;
  const refreshHorizontalBounds = () => {
    horizontalBoundsFrame = 0;
    cachedHorizontalBounds = vcardHorizontalWaveBounds();
  };
  const scheduleHorizontalBoundsRefresh = () => {
    if (brightnessLevel === 0) return;
    if (horizontalBoundsFrame) cancelAnimationFrame(horizontalBoundsFrame);
    horizontalBoundsFrame = requestAnimationFrame(() => {
      horizontalBoundsFrame = requestAnimationFrame(refreshHorizontalBounds);
    });
  };

  const clearVisualizationFrame = () => {
    canvasContext.clearRect(0, 0, window.innerWidth, window.innerHeight);
    waveformHistory.length = 0;
    verticalAmplitudes.fill(0);
    smoothedAmplitude = 0;
    horizontalScale = 1;
    horizontalScaleTarget = 1;
    horizontalScaleStartedAt = 0;
    horizontalScaleCalibrated = false;
    horizontalNoiseFloor = 0;
    horizontalNoiseFloorTarget = 0;
    horizontalNoiseFloorUpdatedAt = 0;
    horizontalNoiseFloorReady = false;
    horizontalUpperShape = 1;
    horizontalLowerShape = 1;
  };

  const initializeAudio = () => {
    if (audioContext) return;
    try {
      audioContext = new AudioContextClass({ latencyHint: 'playback' });
    } catch (error) {
      audioContext = new AudioContextClass();
    }
    analyser = audioContext.createAnalyser();
    analyser.fftSize = visualizationFftSize;
    analyser.smoothingTimeConstant = 0;
    waveformData = new Uint8Array(analyser.fftSize);
    frequencyData = new Uint8Array(analyser.frequencyBinCount);

    audios.forEach((audio) => {
      const source = audioContext.createMediaElementSource(audio);
      mediaSources.push(source);
      source.connect(analyser);
    });
    analyser.connect(audioContext.destination);
  };

  const resetAudioAnalysis = () => {
    if (!audioContext) return;
    try { analyser && analyser.disconnect(); } catch (e) { }

    analyser = audioContext.createAnalyser();
    analyser.fftSize = visualizationFftSize;
    analyser.smoothingTimeConstant = 0;
    waveformData = new Uint8Array(analyser.fftSize);
    frequencyData = new Uint8Array(analyser.frequencyBinCount);

    mediaSources.forEach((source) => {
      try { source.disconnect(); } catch (e) { }
      source.connect(analyser);
    });
    analyser.connect(audioContext.destination);
  };

  const drawHorizontalVisualization = (timestamp) => {
    const frameTime = typeof timestamp === 'number' ? timestamp : performance.now();
    const shouldSample = (
      !lastWaveformSample
      || frameTime - lastWaveformSample >= horizontalSampleInterval
    );

    if (shouldSample) {
      lastWaveformSample = frameTime;

      analyser.getByteTimeDomainData(waveformData);
      analyser.getByteFrequencyData(frequencyData);
      let sampleMean = 0;
      waveformData.forEach((value) => {
        sampleMean += value;
      });
      sampleMean /= waveformData.length;

      let peak = 0;
      let squareSum = 0;
      waveformData.forEach((value) => {
        const sample = Math.abs(value - sampleMean) / 128;
        peak = Math.max(peak, sample);
        squareSum += sample * sample;
      });

      const rms = Math.sqrt(squareSum / waveformData.length);
      const measuredAmplitude = Math.min(1, Math.max(peak * 0.78, rms * 1.8));
      smoothedAmplitude += (measuredAmplitude - smoothedAmplitude) * 0.32;

      const nyquist = audioContext.sampleRate / 2;
      const frequencyBin = (hertz) => Math.max(
        1,
        Math.min(
          frequencyData.length,
          Math.round(hertz / nyquist * frequencyData.length)
        )
      );
      const bandRms = (start, end) => {
        let bandSquareSum = 0;
        const safeEnd = Math.max(start + 1, Math.min(end, frequencyData.length));
        for (let index = start; index < safeEnd; index += 1) {
          const value = frequencyData[index] / 255;
          bandSquareSum += value * value;
        }
        return Math.sqrt(bandSquareSum / (safeEnd - start));
      };
      const lowEnergy = bandRms(frequencyBin(45), frequencyBin(250));
      const midEnergy = bandRms(frequencyBin(250), frequencyBin(2500));
      const highEnergy = bandRms(frequencyBin(2500), frequencyBin(8000));
      const bodyEnergy = lowEnergy * 0.65 + midEnergy * 0.35;
      const detailEnergy = midEnergy * 0.6 + highEnergy * 0.4;
      const spectralBalance = Math.max(
        -1,
        Math.min(
          1,
          (detailEnergy - bodyEnergy) / (detailEnergy + bodyEnergy + 0.02)
        )
      );
      const upperShapeTarget = 1 + spectralBalance * HORIZONTAL_ASYMMETRY;
      const lowerShapeTarget = 1 - spectralBalance * HORIZONTAL_ASYMMETRY;
      horizontalUpperShape += (
        upperShapeTarget - horizontalUpperShape
      ) * HORIZONTAL_ASYMMETRY_SMOOTHING;
      horizontalLowerShape += (
        lowerShapeTarget - horizontalLowerShape
      ) * HORIZONTAL_ASYMMETRY_SMOOTHING;

      waveformHistory.push({
        amplitude: smoothedAmplitude,
        upperShape: horizontalUpperShape,
        lowerShape: horizontalLowerShape,
      });
      if (!horizontalScaleStartedAt) horizontalScaleStartedAt = frameTime;

      const maximumColumns = Math.ceil(window.innerWidth / horizontalColumnStep) + 2;
      if (waveformHistory.length > maximumColumns) {
        waveformHistory.splice(0, waveformHistory.length - maximumColumns);
      }
      if (
        waveformHistory.length >= 12
        && frameTime - horizontalNoiseFloorUpdatedAt >= HORIZONTAL_DEAD_ZONE_INTERVAL
      ) {
      const floorSamples = waveformHistory
        .slice(-Math.min(waveformHistory.length, 120))
        .map((column) => column.amplitude)
        .sort((left, right) => left - right);
      const floorIndex = Math.floor(
        (floorSamples.length - 1) * HORIZONTAL_DEAD_ZONE_PERCENTILE
      );
      horizontalNoiseFloorTarget = floorSamples[floorIndex] || 0;
      horizontalNoiseFloorUpdatedAt = frameTime;
      if (!horizontalNoiseFloorReady) {
        horizontalNoiseFloor = horizontalNoiseFloorTarget * 0.5;
        horizontalNoiseFloorReady = true;
      }
      }
      horizontalNoiseFloor += (
        horizontalNoiseFloorTarget - horizontalNoiseFloor
      ) * (horizontalNoiseFloorTarget < horizontalNoiseFloor ? 0.15 : 0.04);

      if (
        !horizontalScaleCalibrated
        && waveformHistory.length >= 12
        && frameTime - horizontalScaleStartedAt >= HORIZONTAL_SCALE_INTERVAL
      ) {
      const transformedHistory = waveformHistory
        .slice(-Math.min(waveformHistory.length, 120))
        .map((column) => (
          Math.pow(
            horizontalAdjustedAmplitude(column.amplitude),
            HORIZONTAL_RESPONSE_CURVE
          ) * Math.max(column.upperShape, column.lowerShape)
        ))
        .sort((left, right) => left - right);
      const referenceIndex = Math.floor((transformedHistory.length - 1) * 0.95);
      const referenceAmplitude = Math.max(
        0.01,
        transformedHistory[referenceIndex] || 0
      );
      horizontalScaleTarget = Math.max(
        0.25,
        Math.min(
          HORIZONTAL_SCALE_MAX,
          HORIZONTAL_SCALE_TARGET / referenceAmplitude
        )
      );
        horizontalScaleCalibrated = true;
      } else if (horizontalScaleCalibrated) {
      const displayedAmplitude = Math.max(
        0.01,
        Math.pow(
          horizontalAdjustedAmplitude(smoothedAmplitude),
          HORIZONTAL_RESPONSE_CURVE
        ) * Math.max(horizontalUpperShape, horizontalLowerShape)
      );
      const safeScale = Math.max(
        0.25,
        Math.min(HORIZONTAL_SCALE_MAX, HORIZONTAL_SCALE_TARGET / displayedAmplitude)
      );
      // Loud peaks may reduce the scale immediately. Quiet passages never
      // enlarge it again, so the waveform does not breathe vertically.
        horizontalScaleTarget = Math.min(horizontalScaleTarget, safeScale);
      }
      if (horizontalScaleTarget < horizontalScale) {
        horizontalScale = horizontalScaleTarget;
      } else {
        horizontalScale += (horizontalScaleTarget - horizontalScale) * 0.05;
      }
    }

    const bounds = cachedHorizontalBounds;
    const centerY = bounds.top + bounds.height / 2;
    const maximumHalfHeight = Math.max(
      1,
      bounds.height * (0.5 - HORIZONTAL_VIEWPORT_MARGIN)
    );
    const phaseOffset = lastWaveformSample
      ? Math.min(
        horizontalColumnStep,
        (frameTime - lastWaveformSample) / horizontalSampleInterval * horizontalColumnStep
      )
      : 0;
    const waveformColor = visualizationColor(frameTime);

    canvasContext.clearRect(0, 0, window.innerWidth, window.innerHeight);
    canvasContext.save();
    canvasContext.beginPath();
    canvasContext.rect(0, bounds.top, window.innerWidth, bounds.height);
    canvasContext.clip();
    canvasContext.globalAlpha = [0, 0.28, 0.48, 0.68, 0.85, 1][brightnessLevel];
    canvasContext.fillStyle = waveformColor;
    for (let index = 0; index < waveformHistory.length; index += 1) {
      const column = waveformHistory[index];
      const baseHalfHeight = Math.pow(
        horizontalAdjustedAmplitude(column.amplitude),
        HORIZONTAL_RESPONSE_CURVE
      ) * maximumHalfHeight * horizontalScale;
      const x = window.innerWidth
        - (waveformHistory.length - index) * horizontalColumnStep
        - phaseOffset;
      const upperHeight = Math.max(
        1,
        Math.min(maximumHalfHeight, baseHalfHeight * column.upperShape)
      );
      const lowerHeight = Math.max(
        1,
        Math.min(maximumHalfHeight, baseHalfHeight * column.lowerShape)
      );
      canvasContext.fillRect(
        x,
        centerY - upperHeight,
        horizontalBarWidth,
        upperHeight + lowerHeight
      );
    }
    canvasContext.restore();
  };

  const drawVerticalVisualization = () => {
    const frameTime = performance.now();
    if (frameTime - lastVerticalFrame < 33) return;
    lastVerticalFrame = frameTime;

    analyser.getByteFrequencyData(frequencyData);

    const amplitudes = verticalAmplitudes.map((current, index) => {
      const start = Math.floor(
        index * frequencyData.length / VERTICAL_BAR_COUNT
      );
      const end = Math.max(
        start + 1,
        Math.floor((index + 1) * frequencyData.length / VERTICAL_BAR_COUNT)
      );
      let peak = 0;
      for (let bin = start; bin < Math.min(end, frequencyData.length); bin += 1) {
        peak = Math.max(peak, frequencyData[bin]);
      }
      const target = peak / 255;
      const next = target >= current
        ? target
        : current + (target - current) * VERTICAL_RELEASE_RATE;
      verticalAmplitudes[index] = next;
      return next;
    });

    const bounds = verticalWaveBounds();
    const centerX = bounds.left + bounds.width / 2;
    const waveformColor = visualizationColor(frameTime);
    const slotHeight = window.innerHeight / VERTICAL_BAR_COUNT;
    const gap = Math.max(4, Math.min(12, slotHeight * 0.18));
    const barHeight = Math.max(2, slotHeight - gap);
    const maxHalfWidth = bounds.width / 2;

    canvasContext.clearRect(0, 0, window.innerWidth, window.innerHeight);
    canvasContext.save();
    canvasContext.beginPath();
    canvasContext.rect(bounds.left, 0, bounds.width, window.innerHeight);
    canvasContext.clip();
    amplitudes.forEach((amplitude, index) => {
      if (amplitude < 0.004) return;
      const halfWidth = amplitude * maxHalfWidth;
      const x = centerX - halfWidth;
      const y = (VERTICAL_BAR_COUNT - index - 1) * slotHeight + gap / 2;
      const width = halfWidth * 2;
    canvasContext.globalAlpha = [0, 0.24, 0.42, 0.62, 0.82, 1][brightnessLevel];
      canvasContext.fillStyle = waveformColor;
      canvasContext.fillRect(x, y, width, barHeight);
    });
    canvasContext.restore();
  };

  const drawVisualization = (timestamp) => {
    animationFrame = 0;
    if (
      !analyser
      || visualizationMode === MODE_OFF
      || brightnessLevel === 0
    ) {
      clearVisualizationFrame();
      return;
    }
    if (audios.every((audio) => audio.paused || audio.ended)) {
      clearVisualizationFrame();
      return;
    }

    const frameTime = typeof timestamp === 'number' ? timestamp : performance.now();
    if (
      lastVisualizationFrame
      && frameTime - lastVisualizationFrame < visualizationFrameInterval
    ) {
      animationFrame = requestAnimationFrame(drawVisualization);
      return;
    }
    lastVisualizationFrame = frameTime;

    if (visualizationMode === MODE_VERTICAL) {
      drawVerticalVisualization();
    } else {
      drawHorizontalVisualization(frameTime);
    }

    animationFrame = requestAnimationFrame(drawVisualization);
  };

  const startVisualization = async () => {
    if (visualizationMode === MODE_OFF || brightnessLevel === 0) return;
    initializeAudio();
    if (audioContext.state === 'suspended') await audioContext.resume();
    if (!animationFrame) animationFrame = requestAnimationFrame(drawVisualization);
  };

  const prepareAudioContextFromGesture = () => {
    if (visualizationMode === MODE_OFF || brightnessLevel === 0) return;
    try {
      initializeAudio();
      if (audioContext.state === 'suspended') {
        audioContext.resume().catch((error) => {
          console.debug('VCard visualization: audio context remains suspended.', error);
        });
      }
    } catch (error) {
      console.debug('VCard visualization: audio context is unavailable.', error);
    }
  };

  document.addEventListener('vcard:prepare-audio-context', prepareAudioContextFromGesture);

  audios.forEach((audio) => {
    audio.addEventListener('play', () => {
      startVisualization();
    });
    audio.addEventListener('pause', drawVisualization);
    audio.addEventListener('ended', drawVisualization);
  });
  window.addEventListener('resize', resizeCanvas);
  document.addEventListener('vcard:portal-state', scheduleHorizontalBoundsRefresh);
  document.addEventListener('vcard:portal-size', scheduleHorizontalBoundsRefresh);
  document.addEventListener('vcard:portal-mode', scheduleHorizontalBoundsRefresh);
  document.addEventListener('load', (event) => {
    if (event.target instanceof HTMLImageElement && event.target.closest('.song-portal-stage')) {
      scheduleHorizontalBoundsRefresh();
    }
  }, true);

  const setVisualizationMode = (nextMode) => {
    visualizationMode = [MODE_HORIZONTAL, MODE_VERTICAL].includes(nextMode) ? nextMode : MODE_OFF;
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    lastVerticalFrame = 0;
    lastVisualizationFrame = 0;
    lastWaveformSample = 0;
    clearVisualizationFrame();
    if (brightnessLevel > 0) resetAudioAnalysis();
    localStorage.setItem(STORAGE_KEY, visualizationMode);
    localStorage.setItem(LEGACY_STORAGE_KEY, visualizationMode === MODE_OFF ? 'off' : 'on');
    canvas.classList.toggle(
      'is-enabled',
      visualizationMode !== MODE_OFF && brightnessLevel > 0
    );
    canvas.dataset.brightnessLevel = String(brightnessLevel);
    document.documentElement.dataset.visBri = String(brightnessLevel);
    document.dispatchEvent(new CustomEvent('vcard:visualization-state', {
      detail: { mode: visualizationMode, brightnessLevel }
    }));

    if (visualizationMode !== MODE_OFF && brightnessLevel > 0) {
      const playingAudio = audios.find((audio) => !audio.paused && !audio.ended);
      if (playingAudio) startVisualization();
    } else {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      clearVisualizationFrame();
    }
  };

  document.addEventListener('vcard:set-visualization', (event) => {
    const requestedMode = event.detail && event.detail.mode;
    const forceMode = Boolean(event.detail && event.detail.force);
    setVisualizationMode(!forceMode && requestedMode === visualizationMode ? MODE_OFF : requestedMode);
  });

  const applyBrightnessLevel = (nextLevel) => {
    const clampedLevel = Math.max(0, Math.min(BRIGHTNESS_LEVEL_COUNT - 1, nextLevel));
    if (clampedLevel === brightnessLevel) return;
    brightnessLevel = clampedLevel;
    localStorage.setItem(BRIGHTNESS_STORAGE_KEY, String(brightnessLevel));
    canvas.dataset.brightnessLevel = String(brightnessLevel);
    document.documentElement.dataset.visBri = String(brightnessLevel);
    canvas.classList.toggle(
      'is-enabled',
      visualizationMode !== MODE_OFF && brightnessLevel > 0
    );
    if (brightnessLevel === 0) {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      lastVisualizationFrame = 0;
      clearVisualizationFrame();
    } else {
      const playingAudio = audios.find((audio) => !audio.paused && !audio.ended);
      if (playingAudio) startVisualization();
    }
    document.dispatchEvent(new CustomEvent('vcard:visualization-state', {
      detail: { mode: visualizationMode, brightnessLevel }
    }));
  };

  document.addEventListener('vcard:toggle-visualization-brightness', () => {
    applyBrightnessLevel(brightnessLevel + 1);
  });

  document.addEventListener('vcard:step-visualization-brightness', (event) => {
    const delta = Number(event.detail && event.detail.delta);
    if (!Number.isInteger(delta) || delta === 0) return;
    applyBrightnessLevel(brightnessLevel + delta);
  });

  document.addEventListener('vcard:set-visualization-brightness', (event) => {
    const requestedLevel = Number(event.detail && event.detail.level);
    if (!Number.isInteger(requestedLevel) || requestedLevel < 0 || requestedLevel >= BRIGHTNESS_LEVEL_COUNT) return;
    applyBrightnessLevel(requestedLevel);
  });

  document.addEventListener('vcard:request-visualization-state', () => {
    document.dispatchEvent(new CustomEvent('vcard:visualization-state', {
      detail: { mode: visualizationMode, brightnessLevel }
    }));
  });

  resizeCanvas();
  setVisualizationMode(visualizationMode);
})();

const vcardDebugStylesLoaded = () => Boolean(document.querySelector(
  'link[href*="vcard-debug.css"], style[data-vcard-source$="vcard-debug.css"]'
));

(() => {
  if (!vcardDebugStylesLoaded()) return;

  const STORAGE_KEY = 'vcard-debug';
  const root = document.documentElement;
  const toggle = document.querySelector('[data-debug-toggle]');

  const setDebug = (enabled) => {
    root.dataset.debug = enabled ? 'on' : 'off';
    localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
  };

  setDebug(vcardSettingEnabled(STORAGE_KEY, 'debug', 'off'));

  if (toggle) {
    toggle.addEventListener('click', (event) => {
      event.preventDefault();
      setDebug(root.dataset.debug !== 'on');
    });
  }

  document.addEventListener('keydown', (event) => {
    if (
      event.key !== 'F12'
      || !event.ctrlKey
      || event.altKey
      || event.metaKey
      || event.shiftKey
      || event.repeat
    ) return;
    event.preventDefault();
    event.stopPropagation();
    setDebug(root.dataset.debug !== 'on');
  }, true);
})();

(() => {
  if (!vcardDebugStylesLoaded()) return;

  const blockTypes = [
    ['block-full', 'full'],
    ['block-mid', 'mid'],
    ['block-small', 'small']
  ];

  const debugElements = Array.from(document.querySelectorAll(
    'section.block-full, section.block-mid, section.block-small, [id]:not(a), [ids]:not(a)'
  ));

  const blockTypeFor = (element) => {
    const blockHost = element.closest('.block-full, .block-mid, .block-small');
    return blockHost
      ? blockTypes.find(([className]) => blockHost.classList.contains(className))
      : null;
  };

  const refreshDebugElement = (element) => {
    const blockType = blockTypeFor(element);
    const line = element.querySelector(':scope > .vc-debug-section-line');
    const marker = element.querySelector(':scope > .vc-debug-block-marker');
    if (line) {
      line.className = blockType
        ? `vc-debug-section-line vc-debug-section-line--${blockType[1]}`
        : 'vc-debug-section-line';
    }
    if (marker) {
      marker.className = blockType
        ? `vc-debug-block-marker vc-debug-block-marker--${blockType[1]}`
        : 'vc-debug-block-marker';
    }
  };

  debugElements.forEach((element) => {
      const blockType = blockTypeFor(element);
      const tagName = element.tagName.toLowerCase();
      const elementClass = Array.from(element.classList)
        .find((className) => !className.startsWith('block-'));
      const identifiers = [
        element.id ? `id=${element.id}` : '',
        element.getAttribute('ids') ? `ids=${element.getAttribute('ids')}` : ''
      ].filter(Boolean);
      const elementName = identifiers.length
        ? `${tagName} ${identifiers.join(' ')}`
        : elementClass
          ? `${tagName} class=${elementClass}`
          : tagName;

      element.classList.add('vc-debug-marker-host');

      const line = document.createElement('span');
      line.className = blockType
        ? `vc-debug-section-line vc-debug-section-line--${blockType[1]}`
        : 'vc-debug-section-line';
      line.setAttribute('aria-hidden', 'true');
      element.appendChild(line);

      const marker = document.createElement('span');
      marker.className = blockType
        ? `vc-debug-block-marker vc-debug-block-marker--${blockType[1]}`
        : 'vc-debug-block-marker';
      marker.textContent = elementName;
      marker.setAttribute('aria-hidden', 'true');
      element.appendChild(marker);
    });

  document.addEventListener('vcard:debug-layout-change', () => {
    debugElements.forEach(refreshDebugElement);
  });
})();

(() => {
  if (!vcardDebugStylesLoaded()) return;

  const label = document.querySelector('.vc-debug-label--body');
  const midLabel = document.querySelector('.vc-debug-label--mid');
  const smallLabel = document.querySelector('.vc-debug-label--small');
  if (!label && !midLabel && !smallLabel) return;

  const updateBodyDebugLabel = () => {
    if (label) {
      const width = Math.round(document.body.getBoundingClientRect().width);
      label.textContent = `BODY ${width}px / max 1200px`;
    }
    const rootStyle = getComputedStyle(document.documentElement);
    if (midLabel) {
      midLabel.textContent = `MID ${rootStyle.getPropertyValue('--block-mid-width').trim()}`;
    }
    if (smallLabel) {
      smallLabel.textContent = `SMALL ${rootStyle.getPropertyValue('--block-small-width').trim()}`;
    }
  };

  updateBodyDebugLabel();
  window.addEventListener('resize', updateBodyDebugLabel);
  document.addEventListener('vcard:debug-layout-change', updateBodyDebugLabel);

  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(updateBodyDebugLabel);
    observer.observe(document.body);
  }
})();

(() => {
  if (!vcardDebugStylesLoaded()) return;

  const root = document.documentElement;
  const fileName = (source) => {
    try {
      const pathName = new URL(String(source || ''), document.baseURI).pathname;
      return decodeURIComponent(pathName.split('/').filter(Boolean).pop() || '—');
    } catch (_error) {
      return String(source || '—').split(/[\\/]/).pop().split(/[?#]/, 1)[0] || '—';
    }
  };

  document.querySelectorAll('img').forEach((image) => {
    const host = image.closest(
      '.iod-frame, .image-vibeframe, .song-vibeframe'
    ) || image.parentElement;
    if (!host) return;
    host.classList.add('vc-debug-media-name-host');
    let label = host.querySelector(':scope > .vc-debug-media-name');
    if (!label) {
      label = document.createElement('span');
      label.className = 'vc-debug-media-name';
      label.setAttribute('aria-hidden', 'true');
      host.appendChild(label);
    }
    const update = () => {
      label.textContent = fileName(image.currentSrc || image.getAttribute('src'));
    };
    update();
    new MutationObserver(update).observe(image, {
      attributes: true,
      attributeFilter: ['src']
    });
    image.addEventListener('load', update);
  });

  const backgroundLabel = document.createElement('span');
  backgroundLabel.className = 'vc-debug-background-name';
  backgroundLabel.setAttribute('aria-hidden', 'true');
  document.body.appendChild(backgroundLabel);
  const updateBackgroundLabel = () => {
    backgroundLabel.textContent = `ФОН: ${root.dataset.pageBackgroundName || '—'}`;
  };
  updateBackgroundLabel();
  new MutationObserver(updateBackgroundLabel).observe(root, {
    attributes: true,
    attributeFilter: ['data-page-background-name', 'data-background-mode']
  });
})();

const vcardMedia = (() => {
  const listCache = new Map();
  const mediaStates = new Map();
  const activeImages = new Set();
  const root = document.documentElement;
  const variantKinds = {
    c: 'c', g: 'g', b: 'b',
    '\u0441': 'c', '\u0433': 'g', '\u0431': 'b'
  };

  const listKey = (listUrl) => new URL(String(listUrl || ''), document.baseURI).href;

  const loadListScript = (listUrl) => {
    const key = listKey(listUrl);
    const lists = window.VCARD_MEDIA_LISTS ||= {};
    if (Array.isArray(lists[key])) return Promise.resolve(lists[key].slice());
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = listUrl;
      script.async = true;
      script.onload = () => {
        const items = window.VCARD_MEDIA_LISTS?.[key];
        if (Array.isArray(items)) resolve(items.slice());
        else reject(new Error(`invalid media list ${listUrl}`));
      };
      script.onerror = () => reject(new Error(`cannot load media list ${listUrl}`));
      document.head.appendChild(script);
    });
  };

  const loadList = async (listUrl) => {
    if (!listCache.has(listUrl)) {
      listCache.set(listUrl, loadListScript(listUrl));
    }
    return listCache.get(listUrl);
  };

  const listDirectory = (listUrl) => {
    const path = String(listUrl || '').split(/[?#]/, 1)[0];
    return path.slice(0, path.lastIndexOf('/') + 1);
  };

  const listItemUrl = (listUrl, item) => `${listDirectory(listUrl)}${item}`;

  const normalizedName = (url) => {
    const path = String(url || '').split(/[?#]/, 1)[0];
    return path.slice(path.lastIndexOf('/') + 1).toLocaleLowerCase();
  };

  const normalizedSource = (url) => {
    try {
      const resolved = new URL(String(url || ''), document.baseURI);
      resolved.search = '';
      resolved.hash = '';
      return resolved.href.toLocaleLowerCase();
    } catch (_error) {
      return String(url || '').split(/[?#]/, 1)[0].replace(/\\/g, '/').toLocaleLowerCase();
    }
  };

  const imageVariant = (url) => {
    const name = normalizedName(url);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const kind = variantKinds[stem.slice(-1)];
    if (!kind) return null;
    return { pair: stem.slice(0, -1), kind };
  };

  const portalMaskPair = (url) => {
    const name = normalizedName(url);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const match = stem.match(/^([pm])(\d+)$/i);
    if (!match) return null;
    return { pair: String(Number(match[2])), role: match[1].toLowerCase() };
  };

  const directVariantGroup = (source) => {
    const variant = imageVariant(source);
    if (!variant) return { c: source, g: source, b: source, singleSource: true };
    const match = String(source).match(/^(.*?)([cgb\u0441\u0433\u0431])(\.[^./?#]+(?:[?#].*)?)$/i);
    if (!match) return { c: source, g: source, b: source };
    return {
      c: `${match[1]}c${match[3]}`,
      g: `${match[1]}g${match[3]}`,
      b: `${match[1]}b${match[3]}`,
    };
  };

  const variantGroups = (items) => {
    const groups = [];
    const byName = new Map();
    const byPortalPair = new Map();
    items.forEach((source) => {
      const maskPair = portalMaskPair(source);
      if (maskPair) {
        let group = byPortalPair.get(maskPair.pair);
        if (!group) {
          group = {
            base: '',
            mask: '',
            pairedPortal: true,
          };
          byPortalPair.set(maskPair.pair, group);
          groups.push(group);
        }
        group[maskPair.role === 'p' ? 'base' : 'mask'] = source;
        return;
      }
      const variant = imageVariant(source);
      if (!variant) {
        groups.push({ c: source, g: source, b: source, singleSource: true });
        return;
      }
      let group = byName.get(variant.pair);
      if (!group) {
        group = { c: '', g: '', b: '' };
        byName.set(variant.pair, group);
        groups.push(group);
      }
      group[variant.kind] = source;
    });
    return groups.flatMap((group) => {
      if (!group.pairedPortal) return (group.c || group.g || group.b) ? [group] : [];
      if (group.base && group.mask) return [group];
      const source = group.base || group.mask;
      return source ? [{ c: source, g: source, b: source, singleSource: true }] : [];
    });
  };

  const normalizeImageMode = (value) => ({
    color: 'duo',
    bw: 'night',
    text: 'auto',
    acc: 'auto',
    sch: 'auto',
    'sch-inv': 'auto',
    def: 'auto',
  })[String(value || '').trim().toLowerCase()]
    || (['auto', 'night', 'newspaper', 'mono', 'mono-inverse', 'duo', 'gray']
      .includes(String(value || '').trim().toLowerCase())
      ? String(value || '').trim().toLowerCase()
      : 'auto');

  const automaticImageMode = () => {
    const preset = String(root.dataset.colorPreset || '').toLowerCase();
    if (['night', 'mono', 'duo', 'newspaper'].includes(preset)) return preset;
    return vcardSettingEnabled('vcard-mono-color', 'mono-color', 'off')
      ? 'mono'
      : 'night';
  };

  const requestedImageMode = (image) => {
    const ownMode = normalizeImageMode(image.getAttribute('image-color') || 'auto');
    return ownMode;
  };

  const effectiveImageMode = (image) => {
    const managedFrame = image.closest('.image-vibeframe, .song-vibeframe');
    if (managedFrame && !image.classList.contains('is-fullscreen')) {
      const requested = requestedImageMode(image);
      if (requested === 'auto') return automaticImageMode();
      if (requested === 'mono') return 'color-tint';
      return requested;
    }
    const requested = requestedImageMode(image);
    return requested === 'auto' ? automaticImageMode() : requested;
  };

  const sourcesForMode = (group, mode, fullscreen = false) => {
    if (!group) return [];
    if (group.pairedPortal && group.base) return [group.base];
    const order = fullscreen || mode === 'duo'
      ? ['c', 'g', 'b']
      : (mode === 'gray' || mode === 'color-tint'
        ? ['g', 'b', 'c']
        : ['b', 'g', 'c']);
    return [...new Set(order.map((kind) => group[kind]).filter(Boolean))];
  };

  const sourceForMode = (group, mode, fullscreen = false) => (
    sourcesForMode(group, mode, fullscreen)[0] || ''
  );

  const currentAccentColor = () => (
    getComputedStyle(document.documentElement).getPropertyValue('--vc-acc').trim()
  );

  const applyImageEffect = (image, mode = effectiveImageMode(image)) => {
    if (image.classList.contains('is-fullscreen')) {
      image.dataset.imageEffect = 'original';
      return 'original';
    }
    image.dataset.imageEffect = mode;
    return mode;
  };

  const ensurePortalMotionLayer = (image) => {
    const frame = image.closest('.song-vibeframe, .image-vibeframe');
    if (!frame) return null;
    const existing = image.closest('.vcard-portal-motion-layer');
    if (existing) return existing;
    const layer = document.createElement('div');
    layer.className = 'vcard-portal-motion-layer';
    frame.insertBefore(layer, image);
    layer.append(image);
    return layer;
  };

  const coarsePointerPortalRender = window.matchMedia('(pointer: coarse)').matches;
  const portalRenderChunkBytes = 256 * 1024;
  const yieldPortalRender = () => new Promise((resolve) => window.setTimeout(resolve, 0));

  const colorizePortalPixels = async (
    basePixels,
    maskPixels,
    accent,
    shouldContinue = () => true
  ) => {
    const output = new ImageData(basePixels.width, basePixels.height);
    const targetRed = accent[0] / 255;
    const targetGreen = accent[1] / 255;
    const targetBlue = accent[2] / 255;
    const targetLuminance = (
      targetRed * 0.3
      + targetGreen * 0.59
      + targetBlue * 0.11
    );
    let maskedLuminance = 0;
    let maskWeight = 0;
    for (let start = 0; start < basePixels.data.length; start += portalRenderChunkBytes) {
      if (!shouldContinue()) return null;
      const end = Math.min(basePixels.data.length, start + portalRenderChunkBytes);
      for (let index = start; index < end; index += 4) {
        const weight = (
          maskPixels.data[index] * 0.2126
          + maskPixels.data[index + 1] * 0.7152
          + maskPixels.data[index + 2] * 0.0722
        ) * (maskPixels.data[index + 3] / 255);
        if (weight <= 0) continue;
        const sourceLuminance = (
          (basePixels.data[index] / 255) * 0.3
          + (basePixels.data[index + 1] / 255) * 0.59
          + (basePixels.data[index + 2] / 255) * 0.11
        );
        maskedLuminance += sourceLuminance * weight;
        maskWeight += weight;
      }
      if (coarsePointerPortalRender && end < basePixels.data.length) {
        await yieldPortalRender();
      }
    }
    const sourceCenter = maskWeight > 0
      ? maskedLuminance / maskWeight
      : targetLuminance;
    for (let start = 0; start < basePixels.data.length; start += portalRenderChunkBytes) {
      if (!shouldContinue()) return null;
      const end = Math.min(basePixels.data.length, start + portalRenderChunkBytes);
      for (let index = start; index < end; index += 4) {
        const sourceRed = basePixels.data[index] / 255;
        const sourceGreen = basePixels.data[index + 1] / 255;
        const sourceBlue = basePixels.data[index + 2] / 255;
        const sourceLuminance = (
          sourceRed * 0.3
          + sourceGreen * 0.59
          + sourceBlue * 0.11
        );
        const materialLuminance = Math.max(0, Math.min(
          1,
          targetLuminance + (sourceLuminance - sourceCenter) * 0.8
        ));
        const luminanceShift = materialLuminance - targetLuminance;
        let red = targetRed + luminanceShift;
        let green = targetGreen + luminanceShift;
        let blue = targetBlue + luminanceShift;
        const minimum = Math.min(red, green, blue);
        const maximum = Math.max(red, green, blue);
        if (minimum < 0 && materialLuminance > 0) {
          red = materialLuminance + (
            (red - materialLuminance) * materialLuminance
            / (materialLuminance - minimum)
          );
          green = materialLuminance + (
            (green - materialLuminance) * materialLuminance
            / (materialLuminance - minimum)
          );
          blue = materialLuminance + (
            (blue - materialLuminance) * materialLuminance
            / (materialLuminance - minimum)
          );
        }
        if (maximum > 1 && materialLuminance < 1) {
          red = materialLuminance + (
            (red - materialLuminance) * (1 - materialLuminance)
            / (maximum - materialLuminance)
          );
          green = materialLuminance + (
            (green - materialLuminance) * (1 - materialLuminance)
            / (maximum - materialLuminance)
          );
          blue = materialLuminance + (
            (blue - materialLuminance) * (1 - materialLuminance)
            / (maximum - materialLuminance)
          );
        }
        const maskLuminance = (
          maskPixels.data[index] * 0.2126
          + maskPixels.data[index + 1] * 0.7152
          + maskPixels.data[index + 2] * 0.0722
        );
        output.data[index] = Math.round(Math.max(0, Math.min(1, red)) * 255);
        output.data[index + 1] = Math.round(Math.max(0, Math.min(1, green)) * 255);
        output.data[index + 2] = Math.round(Math.max(0, Math.min(1, blue)) * 255);
        output.data[index + 3] = Math.round(
          maskLuminance * (maskPixels.data[index + 3] / 255)
        );
      }
      if (coarsePointerPortalRender && end < basePixels.data.length) {
        await yieldPortalRender();
      }
    }
    return output;
  };

  const ensurePortalPairCanvas = (image) => {
    const motionLayer = ensurePortalMotionLayer(image);
    if (!motionLayer) return null;
    let canvas = motionLayer.querySelector(':scope > .vcard-portal-mask-overlay');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'vcard-portal-mask-overlay';
      canvas.setAttribute('aria-hidden', 'true');
      motionLayer.append(canvas);
    }
    return { motionLayer, canvas };
  };

  const beginPortalImageCrossfade = (image, duration = vcardMagicTimeSeconds) => {
    if (!image.classList.contains('song__preview-image') || !image.getAttribute('src')) {
      return;
    }
    const motionLayer = ensurePortalMotionLayer(image);
    if (!motionLayer) return;
    motionLayer.querySelectorAll(':scope > .vcard-portal-crossfade-previous').forEach((frame) => {
      frame.remove();
    });
    const previous = document.createElement('div');
    previous.className = 'vcard-portal-crossfade-previous';
    previous.style.setProperty('--vc-portal-crossfade-duration', `${duration}s`);
    previous.setAttribute('aria-hidden', 'true');
    const previousImage = image.cloneNode(true);
    previousImage.removeAttribute('id');
    previous.append(previousImage);
    const activeCanvas = motionLayer.querySelector(
      ':scope > .vcard-portal-mask-overlay.is-ready'
    );
    if (activeCanvas && activeCanvas.width && activeCanvas.height) {
      const previousCanvas = document.createElement('canvas');
      previousCanvas.width = activeCanvas.width;
      previousCanvas.height = activeCanvas.height;
      previousCanvas.getContext('2d').drawImage(activeCanvas, 0, 0);
      previous.append(previousCanvas);
    }
    motionLayer.append(previous);
    const remove = () => previous.remove();
    previous.addEventListener('transitionend', (event) => {
      if (event.propertyName === 'opacity') remove();
    }, { once: true });
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => previous.classList.add('is-fading-out'));
    });
    window.setTimeout(remove, Math.ceil(duration * 1000) + 100);
  };

  document.addEventListener('vcard:visualization-state', (event) => {
    if (Number(event.detail && event.detail.brightnessLevel) !== 0) return;
    document.querySelectorAll('.vcard-portal-crossfade-previous').forEach((frame) => {
      frame.remove();
    });
  });

  const loadPortalPairImage = (source) => new Promise((resolve, reject) => {
    const loader = new Image();
    loader.onload = () => resolve(loader);
    loader.onerror = reject;
    loader.src = source;
  });

  const decodePortalImage = (source) => loadPortalPairImage(source).then((image) => {
    if (typeof image.decode !== 'function') return image;
    return image.decode().catch(() => {}).then(() => image);
  });

  const portalPairCacheKey = (baseSource, maskSource, accentColor) => (
    `${baseSource}\n${maskSource}\n${accentColor}`
  );

  const runWhenIdle = (callback) => {
    if (typeof window.requestIdleCallback === 'function') {
      return window.requestIdleCallback(callback, { timeout: 1200 });
    }
    return window.setTimeout(callback, 80);
  };

  const preparePortalPairOverlay = async (
    baseSource,
    maskSource,
    accentColor,
    shouldContinue = () => true
  ) => {
    const [baseLoader, maskLoader] = await Promise.all([
      loadPortalPairImage(baseSource),
      loadPortalPairImage(maskSource),
    ]);
    const width = baseLoader.naturalWidth;
    const height = baseLoader.naturalHeight;
    if (!width || !height) throw new Error('Empty portal pair image');
    if (maskLoader.naturalWidth !== width || maskLoader.naturalHeight !== height) {
      throw new Error('Portal base and mask dimensions differ');
    }
    const baseCanvas = document.createElement('canvas');
    baseCanvas.width = width;
    baseCanvas.height = height;
    const baseContext = baseCanvas.getContext('2d', { willReadFrequently: true });
    baseContext.drawImage(baseLoader, 0, 0, width, height);
    const basePixels = baseContext.getImageData(0, 0, width, height);
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = width;
    maskCanvas.height = height;
    const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true });
    maskContext.drawImage(maskLoader, 0, 0, width, height);
    const maskPixels = maskContext.getImageData(0, 0, width, height);
    const accentCanvas = document.createElement('canvas');
    accentCanvas.width = 1;
    accentCanvas.height = 1;
    const accentContext = accentCanvas.getContext('2d', { willReadFrequently: true });
    accentContext.fillStyle = accentColor || currentAccentColor();
    accentContext.fillRect(0, 0, 1, 1);
    const accent = accentContext.getImageData(0, 0, 1, 1).data;
    const coloredPixels = await colorizePortalPixels(
      basePixels,
      maskPixels,
      accent,
      shouldContinue
    );
    if (!coloredPixels) throw new Error('Portal render cancelled');
    return {
      width,
      height,
      coloredPixels,
    };
  };

  const commitPortalPairOverlay = (image, prepared) => {
    const pairSurface = ensurePortalPairCanvas(image);
    if (!pairSurface) return false;
    const { motionLayer, canvas } = pairSurface;
    motionLayer.style.aspectRatio = `${prepared.width} / ${prepared.height}`;
    canvas.width = prepared.width;
    canvas.height = prepared.height;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, prepared.width, prepared.height);
    context.putImageData(prepared.coloredPixels, 0, 0);
    canvas.classList.add('is-ready');
    motionLayer.classList.remove('is-pair-pending');
    return true;
  };

  const clearPortalPairOverlay = (image) => {
    const pairSurface = ensurePortalPairCanvas(image);
    if (!pairSurface) return;
    pairSurface.canvas.classList.remove('is-ready');
    pairSurface.motionLayer.classList.remove('is-pair-pending');
  };

  const releasePortalPairOverlay = (image) => {
    const motionLayer = image.closest('.vcard-portal-motion-layer');
    if (!motionLayer) return;
    const canvas = motionLayer && motionLayer.querySelector(
      ':scope > .vcard-portal-mask-overlay'
    );
    if (canvas) {
      canvas.classList.remove('is-ready');
      canvas.width = 0;
      canvas.height = 0;
    }
    motionLayer.classList.remove('is-pair-pending');
  };

  const setActive = (image, active = true) => {
    if (!image) return;
    const state = mediaStates.get(image);
    if (active) {
      const wasActive = activeImages.has(image) && (!state || state.active);
      activeImages.add(image);
      if (state) {
        state.active = true;
        if (!wasActive) renderState(image);
      }
      return;
    }
    activeImages.delete(image);
    if (!state) return;
    state.active = false;
    state.renderVersion = (state.renderVersion || 0) + 1;
    state.pairRenderVersion = (state.pairRenderVersion || 0) + 1;
    state.warmPair = null;
    releasePortalPairOverlay(image);
  };

  const syncPortalPairOverlay = (image, baseSource = '', maskSource = '', hideUntilReady = false) => {
    if (vcardFileMode) {
      releasePortalPairOverlay(image);
      return Promise.resolve(false);
    }
    const pairSurface = ensurePortalPairCanvas(image);
    if (!pairSurface) return Promise.resolve(false);
    const state = mediaStates.get(image);
    if (state) state.pairRenderVersion = (state.pairRenderVersion || 0) + 1;
    const version = state ? state.pairRenderVersion : 0;
    if (hideUntilReady) pairSurface.motionLayer.classList.add('is-pair-pending');
    if (!baseSource || !maskSource) {
      clearPortalPairOverlay(image);
      return Promise.resolve(false);
    }
    const accentColor = (state && state.portalAccentColor) || currentAccentColor();
    return preparePortalPairOverlay(
      baseSource,
      maskSource,
      accentColor,
      () => !state || (
        state.active
        && version === state.pairRenderVersion
      )
    ).then((prepared) => {
      if (state && version !== state.pairRenderVersion) return false;
      return commitPortalPairOverlay(image, prepared);
    }).catch(() => {
      if (!state || version === state.pairRenderVersion) {
        clearPortalPairOverlay(image);
      }
      return false;
    });
  };

  const renderState = (
    image,
    preload = true,
    accentColor = '',
    crossfade = true,
    crossfadeDuration = vcardMagicTimeSeconds
  ) => {
    const state = mediaStates.get(image);
    if (state && !state.active) return;
    const mode = effectiveImageMode(image);
    if (!state || !state.groups.length) {
      applyImageEffect(image, mode);
      return;
    }
    const group = state.groups[state.index] || state.groups[0];
    // A p/m portal is always composed from two independent color layers:
    // the grayscale photograph follows the bright page text color, while the
    // masked object is painted by the canvas overlay with --vc-acc.
    const duoGray = mode === 'duo' && root.dataset.duoGray === 'on';
    const isImageOfDay = image.classList.contains('iod-image')
      || image.hasAttribute('image-day');
    const baseMode = mode === 'duo'
      ? (duoGray ? 'gray' : ((group.pairedPortal || isImageOfDay) ? 'color-tint' : 'duo'))
      : mode;
    applyImageEffect(image, baseMode);
    if (group.pairedPortal) {
      state.portalAccentColor = String(accentColor || '').trim() || currentAccentColor();
    }
    const items = sourcesForMode(group, mode, image.classList.contains('is-fullscreen'));
    if (!items.length) return;
    const candidates = items.map((item) => state.listUrl ? listItemUrl(state.listUrl, item) : item);
    const nextSource = candidates[0];
    const pairedTone = mode === 'duo' || mode === 'color-tint';
    const pairBase = pairedTone && group.pairedPortal && group.base
      ? (state.listUrl ? listItemUrl(state.listUrl, group.base) : group.base)
      : '';
    const pairMask = pairedTone && group.pairedPortal && group.mask
      ? (state.listUrl ? listItemUrl(state.listUrl, group.mask) : group.mask)
      : '';
    state.renderVersion = (state.renderVersion || 0) + 1;
    const version = state.renderVersion;
    if (normalizedSource(image.getAttribute('src')) === normalizedSource(nextSource)) {
      const pairSurface = ensurePortalPairCanvas(image);
      const hideUntilReady = Boolean(
        pairBase
        && pairMask
        && pairSurface
        && !pairSurface.canvas.classList.contains('is-ready')
      );
      syncPortalPairOverlay(image, pairBase, pairMask, hideUntilReady);
      return;
    }
    if (!preload) {
      image.setAttribute('src', nextSource);
      syncPortalPairOverlay(image, pairBase, pairMask);
      return;
    }
    const tryCandidate = (index) => {
      if (version !== state.renderVersion || index >= candidates.length) return;
      const candidate = candidates[index];
      const accentColor = state.portalAccentColor || currentAccentColor();
      const pairKey = pairBase && pairMask
        ? portalPairCacheKey(pairBase, pairMask, accentColor)
        : '';
      const warmPair = pairKey && state.warmPair && state.warmPair.key === pairKey
        ? state.warmPair
        : null;
      if (warmPair) state.warmPair = null;
      const pairPromise = warmPair
        ? warmPair.promise
        : (pairBase && pairMask
          ? preparePortalPairOverlay(
            pairBase,
            pairMask,
            accentColor,
            () => state.active && version === state.renderVersion
          )
          : Promise.resolve(null));
      Promise.all([loadPortalPairImage(candidate), pairPromise]).then(([, prepared]) => {
        if (version !== state.renderVersion) return;
        // The source and its already rendered accent layer are committed in the
        // same task, so the browser never paints the bare base between them.
        if (crossfade) beginPortalImageCrossfade(image, crossfadeDuration);
        image.setAttribute('src', candidate);
        if (prepared) commitPortalPairOverlay(image, prepared);
        else clearPortalPairOverlay(image);
      }).catch(() => {
        if (version !== state.renderVersion) return;
        loadPortalPairImage(candidate).then(() => {
          if (version !== state.renderVersion) return;
          image.setAttribute('src', candidate);
          clearPortalPairOverlay(image);
        }).catch(() => tryCandidate(index + 1));
      });
    };
    tryCandidate(0);
  };

  const register = (image, listUrl, groups, index = 0) => {
    const initialIndex = Math.max(0, Math.min(index, Math.max(0, groups.length - 1)));
    const state = {
      listUrl,
      groups,
      primaryListUrl: listUrl,
      primaryGroups: groups,
      historyListUrls: [],
      historyExpanded: false,
      historyPromise: null,
      historyGeneration: 0,
      index: initialIndex,
      randomSeen: new Set([initialIndex]),
      renderVersion: 0,
      pairRenderVersion: 0,
      portalAccentColor: '',
      warmPair: null,
      active: activeImages.has(image) || !image.closest('.song__preview'),
    };
    mediaStates.set(image, state);
    if (state.active && image.dataset.portalRandomStartPending !== 'true') {
      activeImages.add(image);
      renderState(image);
    }
  };

  document.addEventListener('vcardacccolorchange', (event) => {
    const color = String(event.detail && event.detail.color || '').trim()
      || currentAccentColor();
    activeImages.forEach((image) => {
      const state = mediaStates.get(image);
      if (!state) return;
      if (!state.groups.some((group) => group.pairedPortal)) return;
      state.portalAccentColor = color;
      state.warmPair = null;
      renderState(image, false, color);
    });
  });

  const setIndex = (
    image,
    index,
    preload = true,
    crossfade = true,
    crossfadeDuration = vcardMagicTimeSeconds
  ) => {
    const state = mediaStates.get(image);
    if (!state || !state.groups.length) return;
    state.index = ((index % state.groups.length) + state.groups.length) % state.groups.length;
    state.randomSeen = new Set([state.index]);
    renderState(image, preload, '', crossfade, crossfadeDuration);
  };

  const preloadIndex = (image, index) => {
    const state = mediaStates.get(image);
    if (!state || !state.groups.length || !state.active) return Promise.resolve(false);
    const targetIndex = ((index % state.groups.length) + state.groups.length) % state.groups.length;
    const group = state.groups[targetIndex];
    const mode = effectiveImageMode(image);
    const item = sourceForMode(group, mode, image.classList.contains('is-fullscreen'));
    const source = item && (state.listUrl ? listItemUrl(state.listUrl, item) : item);
    const pairedTone = mode === 'duo' || mode === 'color-tint';
    const base = pairedTone && group.pairedPortal && group.base
      ? (state.listUrl ? listItemUrl(state.listUrl, group.base) : group.base)
      : '';
    const mask = pairedTone && group.pairedPortal && group.mask
      ? (state.listUrl ? listItemUrl(state.listUrl, group.mask) : group.mask)
      : '';
    const loads = source ? [decodePortalImage(source)] : [];
    if (base && base !== source) loads.push(decodePortalImage(base));
    if (mask) loads.push(decodePortalImage(mask));
    const accent = state.portalAccentColor || currentAccentColor();
    if (base && mask && !vcardFileMode) {
      const key = portalPairCacheKey(base, mask, accent);
      if (!state.warmPair || state.warmPair.key !== key) {
        state.warmPair = {
          key,
          promise: new Promise((resolve) => runWhenIdle(() => {
            preparePortalPairOverlay(base, mask, accent, () => state.active)
              .then(resolve)
              .catch(() => resolve(null));
          })),
        };
      }
      loads.push(state.warmPair.promise);
    }
    return Promise.all(loads).then(() => true).catch(() => false);
  };

  const clearPreload = (image) => {
    const state = mediaStates.get(image);
    if (state) state.warmPair = null;
  };

  const next = (image) => {
    const state = mediaStates.get(image);
    if (!state || state.groups.length < 2) return false;
    setIndex(image, state.index + 1);
    return true;
  };

  const setHistoryLists = (image, listUrls) => {
    const state = mediaStates.get(image);
    if (!state) return;
    state.historyListUrls = [...new Set(
      (listUrls || []).map((url) => String(url || '').trim()).filter(Boolean)
    )];
    state.historyExpanded = false;
    state.historyPromise = null;
    state.historyGeneration += 1;
  };

  const absoluteGroup = (group, listUrl) => {
    const absolute = {};
    if (group.pairedPortal && group.base && group.mask) {
      absolute.base = listUrl ? listItemUrl(listUrl, group.base) : group.base;
      absolute.mask = listUrl ? listItemUrl(listUrl, group.mask) : group.mask;
      absolute.pairedPortal = true;
      return absolute;
    }
    ['c', 'g', 'b'].forEach((kind) => {
      if (group[kind]) {
        absolute[kind] = listUrl ? listItemUrl(listUrl, group[kind]) : group[kind];
      }
    });
    if (group.singleSource) absolute.singleSource = true;
    return absolute;
  };

  const expandHistory = (image) => {
    const state = mediaStates.get(image);
    if (!state || state.historyExpanded || !state.historyListUrls.length) {
      return Promise.resolve(false);
    }
    if (state.historyPromise) return state.historyPromise;
    const generation = state.historyGeneration;
    state.historyPromise = Promise.all(state.historyListUrls.map(async (listUrl) => {
      try {
        const items = await loadList(listUrl);
        return variantGroups(items.map((item) => listItemUrl(listUrl, item)));
      } catch (error) {
        console.warn(`VCard portal history: cannot load ${listUrl}`, error);
        return [];
      }
    })).then((historyParts) => {
      if (generation !== state.historyGeneration) return false;
      const currentSource = normalizedSource(image.getAttribute('src'));
      const primaryGroups = state.primaryGroups.map(
        (group) => absoluteGroup(group, state.primaryListUrl)
      );
      const historyGroups = historyParts.flat();
      state.groups = [...primaryGroups, ...historyGroups];
      state.listUrl = '';
      state.historyExpanded = true;
      state.historyPromise = null;
      state.index = Math.max(0, state.groups.findIndex((group) => (
        sourcesForMode(group, effectiveImageMode(image)).some(
          (source) => normalizedSource(source) === currentSource
        )
      )));
      state.randomSeen = new Set([state.index]);
      return historyGroups.length > 0;
    });
    return state.historyPromise;
  };

  const randomNext = (image, crossfade = true, crossfadeDuration = vcardMagicTimeSeconds) => {
    const state = mediaStates.get(image);
    if (!state || !state.groups.length) return false;
    if (!(state.randomSeen instanceof Set)) {
      state.randomSeen = new Set([state.index]);
    }
    let candidates = state.groups
      .map((_, index) => index)
      .filter((index) => !state.randomSeen.has(index));
    if (!candidates.length) {
      if (!state.historyExpanded && state.historyListUrls.length) {
        expandHistory(image).then((expanded) => {
          if (expanded) randomNext(image, crossfade, crossfadeDuration);
        });
        return true;
      }
      if (state.groups.length < 2) return false;
      state.randomSeen = new Set([state.index]);
      candidates = state.groups
        .map((_, index) => index)
        .filter((index) => index !== state.index);
    }
    const index = candidates[Math.floor(Math.random() * candidates.length)];
    state.index = index;
    state.randomSeen.add(index);
    renderState(image, true, '', crossfade, crossfadeDuration);
    return true;
  };

  const randomStart = (image) => {
    const state = mediaStates.get(image);
    if (!state || !state.groups.length) return false;
    const currentSource = normalizedSource(image.getAttribute('src'));
    state.historyGeneration += 1;
    state.historyPromise = null;
    state.historyExpanded = false;
    state.groups = state.primaryGroups;
    state.listUrl = state.primaryListUrl;
    const currentPrimaryIndex = state.groups.findIndex((group) => (
      sourcesForMode(group, effectiveImageMode(image)).some((source) => (
        normalizedSource(state.listUrl ? listItemUrl(state.listUrl, source) : source)
          === currentSource
      ))
    ));
    const candidates = state.groups
      .map((_, index) => index)
      .filter((index) => state.groups.length < 2 || index !== currentPrimaryIndex);
    const index = candidates[Math.floor(Math.random() * candidates.length)];
    state.index = index;
    state.randomSeen = new Set([index]);
    renderState(image);
    return true;
  };

  const refresh = (options = {}) => {
    const skipPaired = Boolean(options && options.skipPaired);
    activeImages.forEach((image) => {
      const state = mediaStates.get(image);
      if (state) state.warmPair = null;
      const hasPair = Boolean(
        state && state.groups.some((group) => group.pairedPortal)
      );
      if (hasPair && skipPaired) return;
      renderState(image);
    });
  };

  document.addEventListener('vcard:preset-state', refresh);
  document.addEventListener('vcardcolorschemechange', refresh);
  document.addEventListener('vcardtextcolorchange', () => refresh({ skipPaired: true }));
  document.addEventListener('vcard:mono-color-state', refresh);
  const portraitMedia = window.matchMedia('(orientation: portrait)');
  if (typeof portraitMedia.addEventListener === 'function') {
    portraitMedia.addEventListener('change', refresh);
  } else if (typeof portraitMedia.addListener === 'function') {
    portraitMedia.addListener(refresh);
  }

  const isDebug = () => document.documentElement.dataset.debug === 'on';

  return {
    applyImageEffect,
    ensurePortalMotionLayer,
    effectiveImageMode,
    isDebug,
    listDirectory,
    listItemUrl,
    loadList,
    mediaStates,
    next,
    randomNext,
    randomStart,
    setHistoryLists,
    setActive,
    normalizedName,
    refresh,
    register,
    renderState,
    setIndex,
    preloadIndex,
    clearPreload,
    directVariantGroup,
    sourceForMode,
    sourcesForMode,
    variantGroups,
  };
})();

(() => {
  document.querySelectorAll('.page-image, img[image-color]').forEach(async (image) => {
    if (
      image.classList.contains('iod-image')
      || image.hasAttribute('image-day')
      || image.classList.contains('song__preview-image')
      || image.hasAttribute('slideshow')
    ) return;
    const source = (image.getAttribute('src') || '').trim();
    if (source.split(/[?#]/, 1)[0].toLowerCase().endsWith('.txt')) {
      try {
        const groups = vcardMedia.variantGroups(await vcardMedia.loadList(source));
        if (!groups.length) throw new Error('empty list');
        vcardMedia.register(image, source, groups, 0);
      } catch (error) {
        console.warn(`VCard image: cannot load ${source}`, error);
      }
      return;
    }
    vcardMedia.register(image, '', [vcardMedia.directVariantGroup(source)], 0);
  });
})();

(() => {
  const images = Array.from(document.querySelectorAll('img.iod-image, img[image-day]'));
  if (!images.length) return;

  images.forEach(async (image) => {
    const listUrl = (image.dataset.iodList || image.getAttribute('src') || '').trim();
    if (!listUrl) return;

    image.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const state = vcardMedia.mediaStates.get(image);
      if (!state || state.groups.length < 2) return;
      vcardMedia.next(image);
      image.dataset.iodIndex = String(state.index + 1);
    });

    try {
      const items = await vcardMedia.loadList(listUrl);
      const groups = vcardMedia.variantGroups(items);
      if (!groups.length) {
        console.warn(`VCard image of day: empty image list: ${listUrl}`, image);
        return;
      }

      const setRandomImage = () => {
        const index = Math.floor(Math.random() * groups.length);
        image.dataset.iodIndex = String(index + 1);
        if (!vcardMedia.mediaStates.has(image)) {
          vcardMedia.register(image, listUrl, groups, index);
        } else {
          vcardMedia.setIndex(image, index);
        }
      };

      setRandomImage();
    } catch (error) {
      console.warn(`VCard image of day: cannot load ${listUrl}`, error);
    }
  });
  })();

(() => {
  const videos = Array.from(document.querySelectorAll('video.iod-video[data-iod-list]'));
  if (!videos.length) return;
  let brightnessAllowsDayMotion = document.documentElement.dataset.visBri !== '0';
  let dayPageCoveredBySong = false;

  const syncDayAnimations = () => {
    const dayMotionAllowed = brightnessAllowsDayMotion && !dayPageCoveredBySong;
    videos.forEach((video) => {
      if (!video.currentSrc && !video.getAttribute('src')) return;
      if (dayMotionAllowed) playVCardAnimation(video);
      else freezeVCardVideo(video);
    });
  };

  videos.forEach(async (video) => {
    const listUrl = (video.dataset.iodList || '').trim();
    if (!listUrl) return;
    try {
      const items = await vcardMedia.loadList(listUrl);
      const sources = items.filter((item) => /\.(?:webm|mp4|ogv)(?:[?#].*)?$/i.test(item));
      if (!sources.length) {
        console.warn(`VCard animation of day: empty video list: ${listUrl}`, video);
        return;
      }
      const source = sources[Math.floor(Math.random() * sources.length)];
      video.src = vcardMedia.listItemUrl(listUrl, source);
      video.load();
      syncDayAnimations();
    } catch (error) {
      console.warn(`VCard animation of day: cannot load ${listUrl}`, error);
    }
  });

  document.addEventListener('vcard:visualization-state', (event) => {
    brightnessAllowsDayMotion = Number(event.detail && event.detail.brightnessLevel) > 0;
    syncDayAnimations();
  });
  document.addEventListener('vcard:song-open', () => {
    dayPageCoveredBySong = true;
    syncDayAnimations();
  });
  document.addEventListener('vcard:song-close', () => {
    dayPageCoveredBySong = false;
    syncDayAnimations();
  });
})();

(() => {
  const initializationPromises = new WeakMap();

  const frameListUrl = (folder) => {
    const value = String(folder || '').trim();
    if (!value) return '';
    if (/\.js(?:[?#].*)?$/i.test(value)) return value;
    const match = value.match(/^([^?#]*)([?#].*)?$/);
    const path = (match && match[1]) || value;
    const suffix = (match && match[2]) || '';
    return `${path.replace(/\/?$/, '/') }list.js${suffix}`;
  };

  const initializeFrame = (host) => {
    if (!host || initializationPromises.has(host)) {
      return initializationPromises.get(host) || Promise.resolve(false);
    }
    const initialization = (async () => {
    const listUrl = frameListUrl(host.getAttribute('frame'));
    if (!listUrl) return false;
    try {
      const items = await vcardMedia.loadList(listUrl);
      if (!items.length) throw new Error('empty list');
      const source = items[Math.floor(Math.random() * items.length)];
      const overlay = document.createElement('img');
      overlay.className = 'vcard-frame-overlay';
      overlay.alt = '';
      overlay.setAttribute('aria-hidden', 'true');
      overlay.src = vcardMedia.listItemUrl(listUrl, source);
      host.appendChild(overlay);
      return true;
    } catch (error) {
      console.warn(`VCard frame: cannot load ${listUrl}`, error);
      return false;
    }
    })();
    initializationPromises.set(host, initialization);
    return initialization;
  };

  document.querySelectorAll('.image-vibeframe[frame]').forEach(initializeFrame);
  document.addEventListener('vcard:activate-portal-image', (event) => {
    initializeFrame(event.detail?.image?.closest('.song-vibeframe[frame]'));
  });
})();

  (() => {
    const controllers = [];
    const initializationPromises = new WeakMap();

    const nonNegativeNumber = (value, fallback) => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    };

    const cssTimeSeconds = (value, fallback) => {
      const text = String(value || '').trim().toLowerCase();
      if (text.endsWith('ms')) {
        return nonNegativeNumber(text.slice(0, -2), fallback * 1000) / 1000;
      }
      if (text.endsWith('s')) {
        return nonNegativeNumber(text.slice(0, -1), fallback);
      }
      return nonNegativeNumber(text, fallback);
    };

    const positiveCssTimeSeconds = (value, fallback) => {
      const seconds = cssTimeSeconds(value, fallback);
      return seconds > 0 ? seconds : fallback;
    };

    const DEFAULT_DELAY_SECONDS = 3;
    const DEFAULT_CROSSFADE_MS = 400;

    const loadFrameList = (listUrl) => vcardMedia.loadList(listUrl);

    const listDirectory = (listUrl) => {
      const path = String(listUrl || '').split(/[?#]/, 1)[0];
      return path.slice(0, path.lastIndexOf('/') + 1);
    };

    const initializeSlideshow = (image) => {
      if (!image || initializationPromises.has(image)) {
        return initializationPromises.get(image) || Promise.resolve(false);
      }
      const initialization = (async () => {
      const songPreview = image.closest('.song__preview');
      image.removeAttribute('onerror');
      image.onerror = null;

      const hasSlideshow = image.hasAttribute('slideshow');
      const baseList = (image.getAttribute('src') || '').trim();
      if (!baseList) {
        console.warn('VCard slideshow: missing list URL', image);
        return false;
      }
      const frameLists = new Map();
      const listUrls = [baseList];
      await Promise.all(listUrls.map(async (listUrl) => {
        try {
          frameLists.set(listUrl, await loadFrameList(listUrl));
        } catch (error) {
          frameLists.set(listUrl, []);
          console.warn(`VCard slideshow: cannot load ${listUrl}`, error);
        }
      }));
      const baseFrames = vcardMedia.variantGroups(frameLists.get(baseList) || []);
      if (!baseFrames.length) {
        console.warn(`VCard slideshow: empty frame list: ${baseList}`);
        return false;
      }

      const delaySeconds = positiveCssTimeSeconds(
        image.getAttribute('slideshow'),
        DEFAULT_DELAY_SECONDS
      );
      const transitionMs = DEFAULT_CROSSFADE_MS;
      const delayMs = delaySeconds * 1000;

      let currentFrame = 0;
      let direction = 1;
      let timer = 0;
      let stopped = false;
      let pendingFrame = null;
      let sourceVersion = 0;
      let crossfadeLayer = null;

      const isInactive = () => (
        document.hidden
        || (songPreview && !songPreview.classList.contains('is-visible'))
      );

      const effectiveFrames = () => baseFrames;
      const frameSource = (frame) => {
        const frames = effectiveFrames();
        const item = vcardMedia.sourceForMode(
          frames[frame],
          vcardMedia.effectiveImageMode(image),
          image.classList.contains('is-fullscreen')
        );
        return item ? `${listDirectory(baseList)}${item}` : '';
      };
      const clearTimer = () => {
        if (!timer) return;
        window.clearTimeout(timer);
        timer = 0;
      };

      const stop = (missingSource) => {
        stopped = true;
        clearTimer();
        image.classList.remove('is-slideshow-changing');
        console.warn(`VCard slideshow: frame not found: ${missingSource}`);
      };

      const crossFadeTo = (
        nextSource,
        durationMs = DEFAULT_CROSSFADE_MS,
        enabled = true
      ) => {
        if (crossfadeLayer) crossfadeLayer.remove();
        if (!enabled || !durationMs) {
          image.setAttribute('src', nextSource);
          return;
        }

        const rect = image.getBoundingClientRect();
        const localHost = image.closest(
          '.vcard-portal-motion-layer, .image-vibeframe, .song-vibeframe'
        );
        const useLocalLayer = localHost && !image.classList.contains('is-fullscreen');
        const imageStyle = getComputedStyle(image);
        const layer = image.cloneNode(false);
        crossfadeLayer = layer;
        layer.removeAttribute('id');
        layer.removeAttribute('slideshow');
        layer.removeAttribute('active');
        layer.removeAttribute('act');
        layer.classList.remove('is-slideshow-changing');
        layer.classList.add('slideshow-crossfade-layer');
        layer.classList.add(useLocalLayer ? 'is-local' : 'is-fixed');
        layer.style.animation = 'none';
        layer.style.animationComposition = 'replace';
        layer.style.filter = imageStyle.filter;
        layer.style.setProperty('--crossfade-duration', `${durationMs}ms`);
        if (useLocalLayer) {
          const hostRect = localHost.getBoundingClientRect();
          layer.style.left = `${rect.left - hostRect.left - localHost.clientLeft}px`;
          layer.style.top = `${rect.top - hostRect.top - localHost.clientTop}px`;
        } else {
          layer.style.left = `${rect.left}px`;
          layer.style.top = `${rect.top}px`;
        }
        layer.style.width = `${rect.width}px`;
        layer.style.height = `${rect.height}px`;
        (useLocalLayer ? localHost : document.body).appendChild(layer);
        void layer.offsetWidth;

        image.setAttribute('src', nextSource);
        requestAnimationFrame(() => layer.classList.add('is-leaving'));
        window.setTimeout(() => {
          layer.remove();
          if (crossfadeLayer === layer) crossfadeLayer = null;
        }, durationMs);
      };

      const schedule = () => {
        clearTimer();
        if (!hasSlideshow || stopped || isInactive()) return;
        timer = window.setTimeout(showNextFrame, delayMs);
      };

      const beginSwap = (
        nextFrame,
        nextSource = frameSource(nextFrame),
        version = sourceVersion
      ) => {
        if (version !== sourceVersion || stopped || isInactive()) {
          schedule();
          return;
        }
        crossFadeTo(nextSource, transitionMs, true);
        currentFrame = nextFrame;
        const mediaState = vcardMedia.mediaStates.get(image);
        if (mediaState) mediaState.index = nextFrame;
        pendingFrame = null;
        timer = window.setTimeout(schedule, transitionMs);
      };

      function showNextFrame() {
        timer = 0;
        if (!hasSlideshow || stopped || isInactive()) return;

        const frames = effectiveFrames();
        const firstFrame = 0;
        if (frames.length - firstFrame < 2) {
          schedule();
          return;
        }
        let nextFrame = currentFrame + direction;
        if (nextFrame >= frames.length) {
          direction = -1;
          nextFrame = Math.max(firstFrame, frames.length - 2);
        } else if (nextFrame < firstFrame) {
          direction = 1;
          nextFrame = Math.min(frames.length - 1, firstFrame + 1);
        }
        const nextSource = frameSource(nextFrame);
        const version = sourceVersion;
        const preload = new Image();
        preload.onload = () => {
          if (stopped || version !== sourceVersion) return;
          if (isInactive()) {
            pendingFrame = nextFrame;
            return;
          }
          beginSwap(nextFrame, nextSource, version);
        };
        preload.onerror = () => stop(nextSource);
        preload.src = nextSource;
      }

      const resetToFirstFrame = () => {
        clearTimer();
        if (crossfadeLayer) {
          crossfadeLayer.remove();
          crossfadeLayer = null;
        }
        sourceVersion += 1;
        direction = 1;
        currentFrame = 0;
        pendingFrame = null;
        image.classList.remove('is-slideshow-changing');
        if (!vcardMedia.mediaStates.has(image)) {
          vcardMedia.register(image, baseList, baseFrames, 0);
        } else {
          vcardMedia.setIndex(image, 0, false);
        }
        schedule();
      };

      resetToFirstFrame();
      if (songPreview) {
        songPreview.addEventListener('vcard:song-open', resetToFirstFrame);
        songPreview.addEventListener('vcard:song-close', () => {
          clearTimer();
          image.classList.remove('is-slideshow-changing');
        });
      }

      controllers.push({
        pause() {
          clearTimer();
          image.classList.remove('is-slideshow-changing');
        },
        resume() {
          if (stopped) return;
          if (pendingFrame !== null) {
            beginSwap(pendingFrame);
            return;
          }
          schedule();
        }
      });
      return true;
      })();
      initializationPromises.set(image, initialization);
      return initialization;
    };

    document.querySelectorAll('img[slideshow]:not(.song__preview-image)')
      .forEach(initializeSlideshow);
    document.addEventListener('vcard:activate-portal-image', (event) => {
      const image = event.detail?.image;
      if (image?.hasAttribute('slideshow')) initializeSlideshow(image);
    });

    document.addEventListener('visibilitychange', () => {
      controllers.forEach((controller) => {
        if (document.hidden) controller.pause();
        else controller.resume();
      });
    });
  })();

  (() => {
    const initializationPromises = new WeakMap();

    const initializePortalImage = (image) => {
      if (!image) return Promise.resolve(false);
      if (vcardMedia.mediaStates.has(image)) return Promise.resolve(true);
      if (initializationPromises.has(image)) return initializationPromises.get(image);
      const initialization = (async () => {
      vcardMedia.ensurePortalMotionLayer(image);
      const frame = image.closest('.song-vibeframe');
      if (frame) {
        frame.addEventListener('contextmenu', (event) => {
          if (document.documentElement.dataset.debug !== 'on') return;
          event.preventDefault();
          event.stopPropagation();
          vcardMedia.next(image);
        }, true);
      }
      image.addEventListener('vcard:image-fullscreen', () => vcardMedia.renderState(image));
      const baseSrc = image.getAttribute('src') || '';
      const cleanSrc = baseSrc.split(/[?#]/, 1)[0];
      const listUrl = cleanSrc.toLowerCase().endsWith('.js')
        ? baseSrc
        : `${vcardMedia.listDirectory(baseSrc)}list.js`;
      let items = [];
      try {
        items = await vcardMedia.loadList(listUrl);
      } catch (error) {
        if (cleanSrc.toLowerCase().endsWith('.js')) {
          console.warn(`VCard portal: cannot load ${listUrl}`, error);
          return;
        }
      }
      const groups = items.length
        ? vcardMedia.variantGroups(items)
        : [vcardMedia.directVariantGroup(baseSrc)];
      const initialIndex = Math.max(
        0,
        groups.findIndex((group) => vcardMedia.sourcesForMode(
          group, vcardMedia.effectiveImageMode(image)
        ).some(
          (source) => vcardMedia.normalizedName(source) === vcardMedia.normalizedName(baseSrc)
        ))
      );
      vcardMedia.register(image, items.length ? listUrl : '', groups, initialIndex);
      vcardMedia.setHistoryLists(
        image,
        String(image.dataset.portalHistoryLists || '')
          .split(',')
          .map((url) => url.trim())
          .filter(Boolean)
      );
      if (image.dataset.portalRandomStartPending === 'true') {
        delete image.dataset.portalRandomStartPending;
        vcardMedia.randomStart(image);
      }
      document.dispatchEvent(new CustomEvent('vcard:portal-items-change', {
        detail: {
          preview: image.closest('.song__preview'),
          count: groups.length
        }
      }));
        return true;
      })().catch((error) => {
        console.warn('VCard portal: cannot initialize visible image', error);
        return false;
      }).finally(() => {
        initializationPromises.delete(image);
      });
      initializationPromises.set(image, initialization);
      return initialization;
    };

    document.addEventListener('vcard:activate-portal-image', (event) => {
      initializePortalImage(event.detail && event.detail.image);
    });
  })();

  (() => {
    const IMAGES_VISIBLE_STORAGE_KEY = 'vcard-images-visible';
    const PORTAL_SIZE_STORAGE_KEY = 'vcard-portal-size';
    const PORTAL_FULLSCREEN_STORAGE_KEY = 'vcard-portal-fullscreen';
    const PORTAL_FULLSCREEN_HISTORY_KEY = 'vcardPortalFullscreen';
    const root = document.documentElement;
    localStorage.removeItem('vcard-portal-view');
    let activeImage = null;
    const storedPortalSize = localStorage.getItem(PORTAL_SIZE_STORAGE_KEY);
    let rememberedPortalSize = ['small', 'mid'].includes(storedPortalSize)
      ? storedPortalSize
      : 'mid';
    let rememberedPortalFullscreen = (
      localStorage.getItem(PORTAL_FULLSCREEN_STORAGE_KEY) === 'on'
    );
    let fullscreenHistoryActive = Boolean(
      history.state && history.state[PORTAL_FULLSCREEN_HISTORY_KEY]
    );
    let handlingFullscreenPopstate = false;
    const canOpenFullscreen = (image) => image.classList.contains('song__preview-image');

    const consumeFullscreenHistory = () => {
      if (!fullscreenHistoryActive || handlingFullscreenPopstate) return;
      fullscreenHistoryActive = false;
      history.back();
    };

    const closeImage = () => {
      if (!activeImage) return;
      const image = activeImage;
      const frame = image.closest('.image-vibeframe, .song-vibeframe');
      image.classList.remove('is-fullscreen');
      if (frame) frame.classList.remove('has-fullscreen-image');
      activeImage = null;
      document.documentElement.classList.remove('page-image-open');
      image.dispatchEvent(new CustomEvent('vcard:image-fullscreen', {
        detail: { open: false }
      }));
    };

    const openImage = (image) => {
      closeImage();
      activeImage = image;
      const frame = image.closest('.image-vibeframe, .song-vibeframe');
      if (frame) frame.classList.add('has-fullscreen-image');
      image.classList.add('is-fullscreen');
      document.documentElement.classList.add('page-image-open');
      image.dispatchEvent(new CustomEvent('vcard:image-fullscreen', {
        detail: { open: true }
      }));
      if (!fullscreenHistoryActive) {
        history.pushState(
          {
            ...(history.state || {}),
            [PORTAL_FULLSCREEN_HISTORY_KEY]: true
          },
          ''
        );
        fullscreenHistoryActive = true;
      }
    };

    const setPortalSize = (image, key, remember = true) => {
      const frame = image && image.closest('.song-vibeframe');
      if (!frame) return;
      const full = key === 'f';
      const medium = key === 'm';
      const size = full ? 'full' : (medium ? 'mid' : 'small');
      frame.dataset.portalSize = size;
      if (remember) {
        rememberedPortalSize = size === 'small' ? 'small' : 'mid';
        localStorage.setItem(PORTAL_SIZE_STORAGE_KEY, rememberedPortalSize);
      }
      frame.classList.toggle('block-small', !medium && !full);
      frame.classList.toggle('block-mid', medium);
      frame.classList.toggle('block-full', full);
      document.dispatchEvent(new CustomEvent('vcard:portal-size', {
        detail: {
          preview: frame.closest('.song__preview'),
          size
        }
      }));
      vcardMedia.refresh();
      requestAnimationFrame(() => {
        document.dispatchEvent(new CustomEvent('vcard:debug-layout-change'));
      });
    };

    const portalMode = (preview) => {
      const image = preview && preview.querySelector('.song__preview-image');
      return image && image.classList.contains('is-fullscreen') ? 'full' : 'mono';
    };
    let imagesVisible = vcardSettingEnabled(IMAGES_VISIBLE_STORAGE_KEY, 'images');

    const publishPortalMode = (preview, mode) => {
      document.dispatchEvent(new CustomEvent('vcard:portal-state', {
        detail: { preview, mode, visible: imagesVisible }
      }));
    };

    const applyImagesVisibility = () => {
      root.dataset.imagesVisible = imagesVisible ? 'on' : 'off';
      const visiblePreview = document.querySelector('.song__preview.is-visible');
      const visibleFrame = visiblePreview && visiblePreview.querySelector('.song-vibeframe');
      if (visibleFrame) visibleFrame.hidden = !imagesVisible;
      if (!imagesVisible && activeImage) {
        closeImage();
      }
      document.dispatchEvent(new CustomEvent('vcard:portal-state', {
        detail: {
          preview: visiblePreview,
          mode: portalMode(visiblePreview),
          visible: imagesVisible
        }
      }));
      document.dispatchEvent(new CustomEvent('vcard:images-visible-state', {
        detail: { visible: imagesVisible }
      }));
    };

    const setImagesVisible = (visible) => {
      imagesVisible = Boolean(visible);
      localStorage.setItem(IMAGES_VISIBLE_STORAGE_KEY, imagesVisible ? 'on' : 'off');
      applyImagesVisibility();
    };

    const setPortalMode = (preview, requestedMode, remember = true) => {
      const mode = requestedMode === 'full' ? 'full' : 'mono';
      const frame = preview && preview.querySelector('.song-vibeframe');
      const image = frame && frame.querySelector('.song__preview-image');

      if (remember) {
        rememberedPortalFullscreen = mode === 'full';
        localStorage.setItem(
          PORTAL_FULLSCREEN_STORAGE_KEY,
          rememberedPortalFullscreen ? 'on' : 'off'
        );
      }
      if (!frame || !image) return;
      frame.dataset.portalMode = mode;
      frame.hidden = !imagesVisible;
      if (!imagesVisible) {
        if (activeImage === image) closeImage();
        publishPortalMode(preview, mode);
        return;
      }

      if (mode === 'full') {
        openImage(image);
      } else {
        if (activeImage === image) {
          closeImage();
          consumeFullscreenHistory();
        }
        const returnSize = frame.dataset.portalReturnSize;
        delete frame.dataset.portalReturnSize;
        const targetSize = returnSize === 'small'
          ? 'small'
          : rememberedPortalSize;
        setPortalSize(image, targetSize === 'small' ? 's' : 'm', remember);
      }
      publishPortalMode(preview, mode);
    };

    const restorePortalState = (preview) => {
      const image = preview && preview.querySelector('.song__preview-image');
      if (!image) return;
      setPortalSize(image, rememberedPortalSize === 'small' ? 's' : 'm', false);
      // Fullscreen belongs to the image the user explicitly opened.  Restoring
      // it for the next track briefly promoted the cassette/poster to the full
      // viewport during automatic track changes on iPad.
      setPortalMode(preview, 'mono', false);
    };

    const exitPortalFullscreenToMid = () => {
      const image = activeImage;
      const preview = image && image.closest('.song__preview');
      const frame = image && image.closest('.song-vibeframe');
      if (!image || !preview || !frame) return;
      delete frame.dataset.portalReturnSize;
      setPortalMode(preview, 'mono');
      setPortalSize(image, 'm');
      publishPortalMode(preview, 'mono');
    };

    window.addEventListener('popstate', (event) => {
      const nextHistoryActive = Boolean(
        event.state && event.state[PORTAL_FULLSCREEN_HISTORY_KEY]
      );
      const closesFullscreen = fullscreenHistoryActive && !nextHistoryActive;
      fullscreenHistoryActive = nextHistoryActive;
      if (!closesFullscreen || !activeImage) return;
      handlingFullscreenPopstate = true;
      try {
        exitPortalFullscreenToMid();
      } finally {
        handlingFullscreenPopstate = false;
      }
    });

    document.addEventListener('vcard:set-portal-mode', (event) => {
      const detail = event.detail || {};
      const preview = detail.preview || document.querySelector('.song__preview.is-visible');
      setPortalMode(preview, detail.mode);
    });

    document.addEventListener('vcard:set-portal-size', (event) => {
      const detail = event.detail || {};
      const preview = detail.preview || document.querySelector('.song__preview.is-visible');
      const image = preview && preview.querySelector('.song__preview-image');
      if (!image) {
        if (['small', 'mid'].includes(detail.size)) {
          rememberedPortalSize = detail.size;
          localStorage.setItem(PORTAL_SIZE_STORAGE_KEY, rememberedPortalSize);
        }
        return;
      }
      if (image.classList.contains('is-fullscreen')) return;
      const sizeKey = detail.size === 'small'
        ? 's'
        : (detail.size === 'full' ? 'f' : 'm');
      setPortalSize(image, sizeKey);
      publishPortalMode(preview, 'mono');
    });

    document.addEventListener('vcard:set-images-visible', (event) => {
      const detail = event.detail || {};
      setImagesVisible(detail.visible);
    });

    document.addEventListener('vcard:request-portal-state', (event) => {
      const detail = event.detail || {};
      const preview = detail.preview || document.querySelector('.song__preview.is-visible');
      if (!preview) {
        document.dispatchEvent(new CustomEvent('vcard:portal-state', {
          detail: {
            preview: null,
            mode: 'mono',
            visible: imagesVisible
          }
        }));
        return;
      }
      restorePortalState(preview);
    });

    document.addEventListener('vcard:song-open', (event) => {
      const preview = event.target && event.target.closest('.song__preview');
      if (preview) restorePortalState(preview);
    });

    document.addEventListener('vcard:page-image-fullscreen', (event) => {
      const image = event.detail && event.detail.image;
      if (!image) return;
      if (event.detail.open) {
        if (!canOpenFullscreen(image)) return;
        openImage(image);
      } else if (activeImage === image) {
        if (image.classList.contains('song__preview-image')) {
          setPortalMode(image.closest('.song__preview'), 'mono');
        } else {
          closeImage();
        }
      } else {
        image.classList.remove('is-fullscreen');
        const frame = image.closest('.image-vibeframe, .song-vibeframe');
        if (frame) frame.classList.remove('has-fullscreen-image');
      }
    });

    document.addEventListener('click', (event) => {
      // Portal open/resize is a normal primary-click action.  Do not let a
      // browser that synthesizes click from an auxiliary button bypass the
      // debug-only right/middle portal gestures.
      if (event.button !== 0) return;
      const image = event.target.closest('.song__preview-image');
      if (!image) return;
      const preview = image.closest('.song__preview');
      const frame = image.closest('.song-vibeframe');
      if (!imagesVisible) return;
      // The fullscreen image itself is the close control.  Do not depend on
      // the auxiliary activeImage reference: a rebuilt/restored portal may
      // already carry the fullscreen class before that reference is renewed.
      if (image.classList.contains('is-fullscreen')) {
        setPortalMode(preview, 'mono');
        return;
      }
      const portrait = window.matchMedia('(orientation: portrait)').matches;
      if (
        !portrait
        && frame
        && frame.classList.contains('block-small')
      ) {
        setPortalSize(image, 'm');
        return;
      }
      setPortalMode(preview, 'full');
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !activeImage) return;
      event.preventDefault();
      if (activeImage.classList.contains('song__preview-image')) {
        exitPortalFullscreenToMid();
        return;
      }
      closeImage();
      consumeFullscreenHistory();
    });

    applyImagesVisibility();
  })();

  (() => {
    const indexButtons = Array.from(document.querySelectorAll('.tabs__item'));
    const listSections = Array.from(document.querySelectorAll('.list'));
    const buttons = Array.from(document.querySelectorAll('.song__item'));
    const previews = Array.from(document.querySelectorAll('.song__preview'));
    const audios = () => sharedSongAudio ? [sharedSongAudio] : [];
    const players = new WeakMap();
    const playerDock = document.createElement('div');
    playerDock.className = 'vcard-player-dock block-mid has-player is-audio-unavailable';
    const playerTopline = document.createElement('div');
    playerTopline.className = 'vcard-player-topline';
    const playerSecondline = document.createElement('div');
    playerSecondline.className = 'vcard-player-secondline';
    const playerTitle = document.createElement('div');
    playerTitle.className = 'vcard-player-title';
    playerTitle.setAttribute('aria-live', 'polite');
    playerTitle.setAttribute('role', 'button');
    playerTitle.setAttribute('tabindex', '0');
    const playerTitleHint = vcardHints.playerTitle || 'Toggle image size';
    playerTitle.setAttribute('aria-label', playerTitleHint);
    playerTitle.setAttribute('title', playerTitleHint);
    playerTitle.dataset.vcardHint = 'true';
    const playerTitleTemplate = String(
      vcardUiConfig.playerTitleTemplate || '%TIT%'
    );
    const playerTitlePlainText = (html) => {
      const template = document.createElement('template');
      template.innerHTML = String(html || '').replace(/<br\s*\/?>/gi, ' ');
      return String(template.content.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
    };
    const withUnknownTrackValues = (html) => String(html || '')
      .replace(/%(?:SOUND|NOHASH_SOUND|MP3INFO)%/g, '?');
    const initialPlayerTitle = (() => {
      return playerTitlePlainText(withUnknownTrackValues(
        vcardUiConfig.playerStartUpTitleTemplate || ''
      ));
    })();
    playerTitle.textContent = initialPlayerTitle;
    playerTitle.dataset.fullTitle = initialPlayerTitle;
    playerTitle.hidden = !initialPlayerTitle;
    playerTopline.append(playerTitle);
    playerDock.append(playerTopline, playerSecondline);
    document.body.prepend(playerDock);
    let autoPlayFromEnded = false;
    let singleSongPlayback = false;
    let autoAdvanceTimer = 0;
    let pendingAutoOpenStartTimer = 0;
    const AUTO_OPEN_START_DELAY_MS = vcardPortalStaticHoldMilliseconds;
    const END_TRACK_TRANSITION_DELAY_MS = vcardPortalStaticHoldMilliseconds;
    let activePreview = null;
    let playingPreview = null;
    let activeTrackBandVerse = null;
    let initialTrackLayoutPreview = null;
    // A tab-local bookmark: refresh returns the reader to the same song and
    // verse, but does not attempt to bypass the browser's autoplay policy.
    const SONG_RESTORE_SESSION_KEY = 'vcard-song-restore-v1';
    let songRestoreWriteTimer = 0;
    let songRestoreApplying = false;
    let portalSizeButtons = [];
    let refreshDynamicPlayerHints = () => {};
    let playerImagesVisible = vcardSettingEnabled(
      'vcard-images-visible',
      'images'
    );
    let playerBackgroundMode = localStorage.getItem('vcard-background-mode') || ({
      h: 'graph1',
      v: 'graph2',
    })[localStorage.getItem('vcard-visualization')] || 'smoke';
    if (playerBackgroundMode === 'off' || playerBackgroundMode === 'light') {
      playerBackgroundMode = 'wallpaper';
    }
    if (vcardFileMode && ['graph1', 'graph2'].includes(playerBackgroundMode)) {
      playerBackgroundMode = 'wallpaper';
    }

    const activatePreviewPortal = (preview, active, randomize = false) => {
      const image = preview && preview.querySelector('.song__preview-image');
      if (!image) return;
      if (!active) {
        if (randomize) image.dataset.portalRandomStartPending = 'true';
        vcardMedia.setActive(image, false);
        return;
      }
      if (vcardMedia.mediaStates.has(image)) {
        if (randomize) vcardMedia.randomStart(image);
        vcardMedia.setActive(image, true);
        return;
      }
      if (randomize) image.dataset.portalRandomStartPending = 'true';
      vcardMedia.setActive(image, true);
      document.dispatchEvent(new CustomEvent('vcard:activate-portal-image', {
        detail: { image }
      }));
    };
    const TRACKPLAY_STORAGE_KEY = 'vcard-trackplay';
    let trackPlayEnabled = vcardSettingEnabled(TRACKPLAY_STORAGE_KEY, 'trackplay');
    const PLAYLIST_ALTERNATION_STORAGE_KEY = 'vcard-playlist-alternation';
    const SONG_ALTERNATION_STORAGE_KEY = 'vcard-song-alternation';
    const normalizePlaylistAlternation = (value) => (
      ['none', 'previous', 'next', 'random'].includes(String(value || '').toLowerCase())
        ? String(value).toLowerCase()
        : 'random'
    );
    const normalizeSongAlternation = (value) => (
      ['none', 'sequential', 'random'].includes(String(value || '').toLowerCase())
        ? String(value).toLowerCase()
        : 'random'
    );
    let playlistAlternation = normalizePlaylistAlternation(
      localStorage.getItem(PLAYLIST_ALTERNATION_STORAGE_KEY)
    );
    let songAlternation = normalizeSongAlternation(
      localStorage.getItem(SONG_ALTERNATION_STORAGE_KEY)
    );
    const randomSongBags = new Map();

    const cancelAutoAdvance = () => {
      if (autoAdvanceTimer) {
        window.clearTimeout(autoAdvanceTimer);
        autoAdvanceTimer = 0;
      }
      if (pendingAutoOpenStartTimer) {
        window.clearTimeout(pendingAutoOpenStartTimer);
        pendingAutoOpenStartTimer = 0;
      }
      autoPlayFromEnded = false;
    };

    const currentPortalPreview = (preferredPreview = null) => (
      preferredPreview && preferredPreview.classList.contains('is-visible')
        ? preferredPreview
        : (
          activePreview && activePreview.classList.contains('is-visible')
            ? activePreview
            : document.querySelector('.song__preview.is-visible')
        )
    );

    const refreshPortalControls = (preferredPreview = null) => {
      const preview = currentPortalPreview(preferredPreview);
      const image = preview && preview.querySelector('.song__preview-image');
      const frame = image && image.closest('.song-vibeframe');
      const portrait = window.matchMedia('(orientation: portrait)').matches;
      const fullscreen = Boolean(
        image
        && (
          image.classList.contains('is-fullscreen')
          || (frame && frame.dataset.portalMode === 'full')
        )
      );
      const rememberedSize = (
        localStorage.getItem('vcard-portal-fullscreen') === 'on'
          ? 'full'
          : (
            ['small', 'mid'].includes(localStorage.getItem('vcard-portal-size'))
              ? localStorage.getItem('vcard-portal-size')
              : 'mid'
          )
      );
      const currentSize = fullscreen
        ? 'full'
        : (
          frame && frame.dataset.portalSize
            ? frame.dataset.portalSize
            : (
              frame && frame.classList.contains('block-small')
                ? 'small'
                : (frame && frame.classList.contains('block-full') ? 'full' : rememberedSize)
            )
        );

      portalSizeButtons.forEach((button) => {
        const size = button.dataset.portalSize;
        const off = size === 'off';
        const active = off
          ? !playerImagesVisible
          : (playerImagesVisible && currentSize === size);
        button.disabled = !off && portrait && size === 'small';
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        button.classList.toggle('is-active', active);
      });

    };

    const setPlayerPortalSize = (size) => {
      const preview = currentPortalPreview();
      const portrait = window.matchMedia('(orientation: portrait)').matches;
      if (size === 'small' && portrait) return;

      const settleLayout = () => {
        if (!preview) return;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (currentPortalPreview() !== preview) return;
          const playingThisPreview = Boolean(
            trackPlayEnabled
            && playingPreview === preview
            && sharedSongAudio
            && !sharedSongAudio.paused
            && !sharedSongAudio.ended
          );
          if (playingThisPreview) {
            centerPreviewTrackVerse(preview, 'auto');
          } else {
            scrollPreviewPortalToTop(preview, 'auto');
          }
        }));
      };

      if (size === 'off') {
        document.dispatchEvent(new CustomEvent('vcard:set-images-visible', {
          detail: { visible: false }
        }));
        refreshPortalControls(preview);
        settleLayout();
        return;
      }

      document.dispatchEvent(new CustomEvent('vcard:set-images-visible', {
        detail: { visible: true }
      }));

      if (size === 'full') {
        const frame = preview && preview.querySelector('.song-vibeframe');
        if (frame) frame.dataset.portalReturnSize = 'mid';
        document.dispatchEvent(new CustomEvent('vcard:set-portal-mode', {
          detail: { preview, mode: 'full' }
        }));
      } else {
        document.dispatchEvent(new CustomEvent('vcard:set-portal-mode', {
          detail: { preview, mode: 'mono' }
        }));
        document.dispatchEvent(new CustomEvent('vcard:set-portal-size', {
          detail: { preview, size }
        }));
      }
      refreshPortalControls(preview);
      settleLayout();
    };

    document.addEventListener('vcard:portal-size', (event) => {
      const detail = event.detail || {};
      const preview = detail.preview;
      if (!preview || !preview.classList.contains('is-visible')) return;
      refreshPortalControls(preview);
    });

    document.addEventListener('vcard:preset-state', (event) => {
      const key = String((event.detail && event.detail.key) || '');
      document.querySelectorAll('[data-vcard-preset]').forEach((button) => {
        const active = button.dataset.vcardPreset === key;
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        button.classList.toggle('is-active', active);
      });
    });

    document.addEventListener('vcard:portal-state', (event) => {
      const detail = event.detail || {};
      playerImagesVisible = detail.visible !== false;
      if (detail.preview) {
        activatePreviewPortal(
          detail.preview,
          playerImagesVisible && !detail.preview.hidden
        );
      }
      refreshPortalControls(detail.preview);
    });

    document.addEventListener('vcard:portal-items-change', (event) => {
      refreshPortalControls(event.detail && event.detail.preview);
    });

    window.matchMedia('(orientation: portrait)').addEventListener(
      'change',
      () => refreshPortalControls()
    );

    const decodeHtmlLine = (() => {
      const textarea = document.createElement('textarea');
      return (html) => {
        textarea.innerHTML = String(html || '').replace(/<[^>]*>/g, '');
        return textarea.value;
      };
    })();

    const parseTrackBand = (value) => String(value || '')
      .match(/-?\d+:\d{2}/g)
      ?.map((time) => {
        const clean = time.replace(/^-/, '');
        const [minutes, seconds] = clean.split(':').map(Number);
        return Number.isFinite(minutes) && Number.isFinite(seconds)
          ? minutes * 60 + seconds
          : NaN;
      })
      .filter((seconds) => Number.isFinite(seconds))
      .sort((left, right) => left - right) || [];

    const lineFragment = (html) => {
      const template = document.createElement('template');
      template.innerHTML = html;
      return template.content;
    };

    const prepareTrackBandText = (text) => {
      if (!text || text.dataset.trackBandPrepared === 'true') return;
      text.dataset.trackBandPrepared = 'true';
      const lines = text.innerHTML.split(/<br\s*\/?>/i);
      const fragment = document.createDocumentFragment();
      let verse = null;
      let verseIndex = 0;

      lines.forEach((line, index) => {
        const plain = decodeHtmlLine(line).trim();
        const isMarker = /^\*\s*\*\s*\*$/.test(plain);
        const isBlank = plain === '';
        const isBoundary = isMarker || isBlank;
        if (index > 0) {
          (verse && !isBoundary ? verse : fragment).append(document.createElement('br'));
        }
        if (isBoundary) {
          verse = null;
          fragment.append(lineFragment(line));
          return;
        }
        if (!verse) {
          verse = document.createElement('span');
          verse.className = 'song__track-verse';
          verse.dataset.trackVerse = String(verseIndex);
          verse.dataset.trackGlow = plain;
          verseIndex += 1;
          fragment.append(verse);
        } else {
          verse.dataset.trackGlow += `\n${plain}`;
        }
        verse.append(lineFragment(line));
      });

      text.textContent = '';
      text.append(fragment);
    };

    const clearTrackBandHighlight = () => {
      if (!activeTrackBandVerse) return;
      activeTrackBandVerse.classList.remove('is-active');
      activeTrackBandVerse = null;
    };

    const updateTrackCenterPadding = (preview) => {
      const text = preview && preview.querySelector('.song__preview-text[data-track-band]');
      if (!text) return;
      prepareTrackBandText(text);
      // Verse centering is handled by scrolling the whole document.  A top
      // padding derived from viewport coordinates grows after every scroll:
      // the first verse moves above the viewport, the next recalculation sees
      // that negative position and pushes the complete text block farther
      // down.  Keep the portal and all verses in their natural document flow.
      text.style.paddingTop = '0px';
    };

    const portalPinScrollTop = (preview) => {
      const portal = preview && preview.querySelector('.song-portal-stage, .song-vibeframe');
      if (!portal || portal.hidden || getComputedStyle(portal).display === 'none') return 0;
      const positionValue = portal.style.getPropertyValue('position');
      const positionPriority = portal.style.getPropertyPriority('position');
      const topValue = portal.style.getPropertyValue('top');
      const topPriority = portal.style.getPropertyPriority('top');
      portal.style.setProperty('position', 'relative', 'important');
      portal.style.setProperty('top', 'auto', 'important');
      const portalDocumentTop = window.scrollY + portal.getBoundingClientRect().top;
      if (positionValue) {
        portal.style.setProperty('position', positionValue, positionPriority);
      } else {
        portal.style.removeProperty('position');
      }
      if (topValue) {
        portal.style.setProperty('top', topValue, topPriority);
      } else {
        portal.style.removeProperty('top');
      }
      return Math.max(0, portalDocumentTop - playerDockHeight());
    };

    const trackVerseViewportBounds = (preview) => {
      const viewportBottom = window.innerHeight;
      const playerRect = playerDock.getBoundingClientRect();
      let top = Math.max(0, Math.min(viewportBottom, playerRect.bottom));
      const portal = preview && preview.querySelector(
        '.song-portal-stage, .song-vibeframe'
      );
      const portalImage = portal && portal.querySelector('.song__preview-image');

      if (portalImage && portalImage.classList.contains('is-fullscreen')) return null;
      if (
        portal
        && !portal.hidden
        && getComputedStyle(portal).display !== 'none'
      ) {
        const portalRect = portal.getBoundingClientRect();
        if (
          portalRect.height > 0
          && portalRect.bottom > 0
          && portalRect.top < viewportBottom
        ) {
          top = Math.max(top, Math.min(viewportBottom, portalRect.bottom));
        }
      }

      const height = viewportBottom - top;
      return height > 1
        ? { top, bottom: viewportBottom, height }
        : null;
    };

    const centerTrackBandVerse = (verse, behavior = 'smooth') => {
      if (!verse) return;
      requestAnimationFrame(() => {
        const rect = verse.getBoundingClientRect();
        if (!rect.height) return;
        const preview = verse.closest('.song__preview');
        // Read the live layout here, immediately before calculating scroll.
        // Portal visibility and dimensions may change while the song is playing.
        const bounds = trackVerseViewportBounds(preview);
        if (!bounds) return;
        const targetCenter = bounds.top + bounds.height / 2;
        const centeredTarget = window.scrollY + rect.top + rect.height / 2 - targetCenter;
        const target = Math.max(centeredTarget, portalPinScrollTop(preview));
        const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        window.scrollTo({
          top: Math.max(0, Math.min(maxScroll, target)),
          behavior,
        });
      });
    };

    const centerPreviewTrackVerse = (preview, behavior = 'auto') => {
      if (!preview) return;
      const text = preview.querySelector('.song__preview-text[data-track-band]');
      if (!text) return;
      updateTrackCenterPadding(preview);
      centerTrackBandVerse(
        text.querySelector('.song__track-verse.is-active')
          || text.querySelector('.song__track-verse'),
        behavior
      );
    };

    let trackVerseLayoutFrame = 0;
    const scheduleTrackVerseLayout = (preferredPreview = null, behavior = 'auto') => {
      if (trackVerseLayoutFrame) cancelAnimationFrame(trackVerseLayoutFrame);
      trackVerseLayoutFrame = requestAnimationFrame(() => {
        trackVerseLayoutFrame = requestAnimationFrame(() => {
          trackVerseLayoutFrame = 0;
          const preview = (
            preferredPreview && preferredPreview.classList.contains('is-visible')
              ? preferredPreview
              : playingPreview
          );
          if (
            !preview
            || !preview.classList.contains('is-visible')
            || !trackPlayEnabled
            || !sharedSongAudio
            || sharedSongAudio.paused
            || sharedSongAudio.ended
          ) return;
          const portal = preview.querySelector('.song-portal-stage, .song-vibeframe');
          const playerBottom = playerDock.getBoundingClientRect().bottom;
          const portalRect = (
            portal
            && !portal.hidden
            && getComputedStyle(portal).display !== 'none'
          ) ? portal.getBoundingClientRect() : null;

          if (portalRect && portalRect.top > playerBottom + 1) {
            scrollPreviewPortalToTop(preview, 'auto');
            trackVerseLayoutFrame = requestAnimationFrame(() => {
              trackVerseLayoutFrame = 0;
              centerPreviewTrackVerse(preview, behavior);
            });
            return;
          }
          centerPreviewTrackVerse(preview, behavior);
        });
      });
    };

    const scheduleTrackVerseFromPortalEvent = (event) => {
      scheduleTrackVerseLayout(event.detail && event.detail.preview);
    };

    document.addEventListener('vcard:portal-size', scheduleTrackVerseFromPortalEvent);
    document.addEventListener('vcard:portal-state', scheduleTrackVerseFromPortalEvent);
    document.addEventListener('vcard:portal-mode', scheduleTrackVerseFromPortalEvent);
    document.addEventListener('vcard:portal-items-change', scheduleTrackVerseFromPortalEvent);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') scheduleTrackVerseLayout();
    });
    document.addEventListener('load', (event) => {
      if (
        event.target instanceof HTMLImageElement
        && event.target.closest('.song__preview.is-visible')
      ) scheduleTrackVerseLayout();
    }, true);
    window.addEventListener('focus', () => scheduleTrackVerseLayout());
    window.addEventListener('pageshow', () => scheduleTrackVerseLayout());
    window.addEventListener('resize', () => scheduleTrackVerseLayout(), { passive: true });

    let fontScaleRefreshFrame = 0;
    document.addEventListener('vcard:font-scale-state', () => {
      if (fontScaleRefreshFrame) cancelAnimationFrame(fontScaleRefreshFrame);
      // Let the new root font size settle before measuring the sticky player,
      // portal and current verse.  Two frames also cover Plyr's control wrap.
      fontScaleRefreshFrame = requestAnimationFrame(() => {
        fontScaleRefreshFrame = requestAnimationFrame(() => {
          fontScaleRefreshFrame = 0;
          const player = sharedSongAudio && players.get(sharedSongAudio);
          if (player && typeof player.update === 'function') player.update();
          const preview = (
            activePreview && activePreview.classList.contains('is-visible')
              ? activePreview
              : playingPreview
          );
          scheduleTrackVerseLayout(preview, 'auto');
        });
      });
    });

    if ('ResizeObserver' in window) {
      const trackLayoutObserver = new ResizeObserver(() => scheduleTrackVerseLayout());
      trackLayoutObserver.observe(playerDock);
      previews.forEach((preview) => {
        const portal = preview.querySelector('.song-portal-stage, .song-vibeframe');
        if (portal) trackLayoutObserver.observe(portal);
      });
    }

    const updateTrackBandHighlight = ({
      scroll = true,
      allowPaused = false,
      force = false,
      seeked = false,
    } = {}) => {
      const audio = sharedSongAudio;
      const previewIsOpen = Boolean(
        playingPreview && playingPreview.classList.contains('is-visible')
      );
      if (
        !audio
        || !previewIsOpen
        || !trackPlayEnabled
        || audio.ended
        || (!allowPaused && audio.paused)
      ) {
        clearTrackBandHighlight();
        return;
      }
      const text = playingPreview.querySelector('.song__preview-text[data-track-band]');
      if (!text) {
        clearTrackBandHighlight();
        return;
      }
      const thresholds = parseTrackBand(text.dataset.trackBand);
      if (!thresholds.length) {
        clearTrackBandHighlight();
        return;
      }
      prepareTrackBandText(text);
      const verses = Array.from(text.querySelectorAll('.song__track-verse'));
      if (!verses.length) {
        clearTrackBandHighlight();
        return;
      }
      const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      const nextIndex = thresholds.filter((threshold) => current >= threshold).length - 1;
      if (nextIndex < 0) {
        clearTrackBandHighlight();
        return;
      }
      const verseEndsAt = thresholds[nextIndex + 1];
      if (
        Number.isFinite(verseEndsAt)
        && current >= verseEndsAt - vcardMagicTimeSeconds - vcardMagicHoldTimeSeconds
      ) {
        document.dispatchEvent(new CustomEvent('vcard:track-verse-pre-end', {
          detail: {
            preview: playingPreview,
            index: nextIndex,
            endsAt: verseEndsAt,
            seeked,
          }
        }));
      }
      const nextVerse = verses[Math.min(nextIndex, verses.length - 1)] || null;
      if (nextVerse === activeTrackBandVerse && !force) return;
      const previousVerse = activeTrackBandVerse;
      if (previousVerse !== nextVerse) clearTrackBandHighlight();
      if (nextVerse) {
        nextVerse.classList.add('is-active');
        activeTrackBandVerse = nextVerse;
        document.dispatchEvent(new CustomEvent('vcard:track-verse-active', {
          detail: {
            preview: playingPreview,
            index: nextIndex,
            verse: nextVerse,
            seeked,
          }
        }));
        if (scroll) scheduleTrackVerseLayout(playingPreview, 'smooth');
      }
    };

    const alignInitialTrackLayout = (preview) => {
      if (!preview || !preview.classList.contains('is-visible') || !trackPlayEnabled) return;
      const text = preview.querySelector('.song__preview-text[data-track-band]');
      if (!text || !parseTrackBand(text.dataset.trackBand).length) return;
      prepareTrackBandText(text);
      updateTrackCenterPadding(preview);
      scheduleTrackVerseLayout(preview);
    };

    const publishTrackPlayState = () => {
      document.dispatchEvent(new CustomEvent('vcard:trackplay-state', {
        detail: { enabled: trackPlayEnabled }
      }));
    };

    document.addEventListener('vcard:set-trackplay', (event) => {
      trackPlayEnabled = Boolean(event.detail && event.detail.enabled);
      localStorage.setItem(TRACKPLAY_STORAGE_KEY, trackPlayEnabled ? 'on' : 'off');
      if (!trackPlayEnabled) {
        clearTrackBandHighlight();
      } else {
        updateTrackBandHighlight();
      }
      publishTrackPlayState();
    });

    document.addEventListener('vcard:request-trackplay-state', publishTrackPlayState);
    document.addEventListener('vcard:song-close', () => clearTrackBandHighlight());
    document.addEventListener('vcard:song-open', () => {
      window.requestAnimationFrame(() => updateTrackBandHighlight());
    });

    const setAudioAvailable = (audio, available) => {
      if (!audio) return;
      audio.hidden = false;
      playerTitle.hidden = !playerTitle.textContent;
      playerDock.classList.add('has-player');
      playerDock.classList.toggle('is-audio-unavailable', !available);
      const container = audio.closest('.plyr');
      if (container) {
        container.hidden = false;
        container.querySelectorAll(
          '[data-plyr="play"], [data-plyr="seek"], [data-plyr="mute"], [data-plyr="volume"]'
        ).forEach((control) => {
          control.disabled = !available;
          control.setAttribute('aria-disabled', available ? 'false' : 'true');
        });
      }
    };

    const renderPlayerTitle = (title, marquee = false) => {
      const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim();
      playerTitle.replaceChildren();
      playerTitle.classList.toggle('is-marquee', Boolean(cleanTitle && marquee));
      if (cleanTitle) {
        const track = document.createElement('span');
        track.className = 'vcard-player-title-track';
        const text = document.createElement('span');
        text.className = 'vcard-player-title-text';
        text.textContent = cleanTitle;
        track.append(text);
        if (marquee) {
          const copy = text.cloneNode(true);
          copy.setAttribute('aria-hidden', 'true');
          track.append(copy);
        }
        playerTitle.append(track);
        if (marquee) {
          const speed = 25;
          const distance = text.getBoundingClientRect().width;
          track.style.setProperty(
            '--vc-player-marquee-distance',
            `${Math.ceil(distance)}px`
          );
          track.style.setProperty(
            '--vc-player-marquee-duration',
            `${Math.max(1, distance / speed)}s`
          );
        }
      }
      playerTitle.dataset.fullTitle = cleanTitle;
      playerTitle.hidden = !cleanTitle;
    };

    const setPlayerTitle = (button, preview) => {
      const songTitle = button
        ? (
          (button.querySelector('.song__player-title') || {}).textContent
          || (button.querySelector('.song__item-text') || button).textContent
        ).replace(/\s+/g, ' ').trim()
        : '';
      const fileName = String((preview && preview.dataset.downloadName) || '').trim();
      const fullInfo = String((preview && preview.dataset.downloadTitle) || '').trim();
      const mp3Info = fileName && fullInfo.startsWith(fileName)
        ? fullInfo.slice(fileName.length).trim()
        : fullInfo;
      const author = String((preview && preview.dataset.mp3Author) || '').trim();
      const title = playerTitlePlainText(
        playerTitleTemplate
          .replaceAll('%AUTHOR%', author)
          .replaceAll('%TIT%', songTitle)
          .replaceAll('%SOUND%', fileName)
          .replaceAll('%MP3INFO%', mp3Info)
      );
      renderPlayerTitle(title, true);
      playerTitle.setAttribute('title', playerTitleHint);
    };

    const activatePlayerTitle = () => {
      const landscape = window.matchMedia('(orientation: landscape)').matches;
      if (landscape) {
        const preview = (
          activePreview && activePreview.classList.contains('is-visible')
            ? activePreview
            : document.querySelector('.song__preview.is-visible')
        );
        const portal = preview && preview.querySelector('.song-vibeframe:not([hidden])');
        if (portal && !portal.classList.contains('has-fullscreen-image')) {
          const currentSize = portal.classList.contains('block-small')
            ? 'small'
            : 'mid';
          const nextSize = currentSize === 'small'
            ? 'mid'
            : 'small';
          setPlayerPortalSize(nextSize);
        }
      }
    };

    playerTitle.addEventListener('click', activatePlayerTitle);
    playerTitle.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      document.dispatchEvent(new CustomEvent('vcard:set-images-visible', {
        detail: { visible: !playerImagesVisible }
      }));
    });
    playerTitle.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      activatePlayerTitle();
    });

    const moveSharedPlayer = (audio) => {
      if (!audio) return;
      const player = players.get(audio);
      const element = player && player.elements ? player.elements.container : audio;
      if (element.parentElement !== playerDock) playerDock.append(element);
    };

    const enhanceAudio = (audio) => {
      if (!audio || players.has(audio) || typeof window.Plyr !== 'function') return null;
      audio.removeAttribute('onerror');
      ensurePlyrIconSprite();
      const player = new window.Plyr(audio, {
        controls: ['play', 'progress', 'current-time', 'mute', 'volume'],
        invertTime: false,
        iconUrl: '',
        loadSprite: false,
        i18n: {
          play: playerText.play,
          pause: playerText.pause,
          mute: playerText.mute,
          unmute: playerText.unmute,
          volume: playerText.volume,
          seek: playerText.seek,
          seekLabel: String(playerText.seekLabel).replaceAll('{seek}', playerText.seek)
        }
      });
      const dynamicHintRefreshers = [];
      const currentHintTrackButton = () => (
        previewButton(playingPreview)
        || previewButton(activePreview)
        || document.querySelector('.song__item.is-active')
      );
      const currentHintTrackNumbers = () => {
        const currentButton = currentHintTrackButton();
        const listId = String((currentButton && currentButton.dataset.list) || '');
        const visibleList = listSections.find((section) => section.style.display !== 'none');
        const listButtons = listId
          ? buttons.filter((button) => button.dataset.list === listId)
          : buttons.filter((button) => visibleList && visibleList.contains(button));
        const currentIndex = listButtons.indexOf(currentButton);
        return {
          current: currentIndex < 0 ? 0 : currentIndex + 1,
          total: listButtons.length
        };
      };
      const expandPlayerHint = (template) => {
        const trackNumbers = currentHintTrackNumbers();
        const storedBrightness = Number.parseInt(
          document.documentElement.dataset.visBri,
          10
        );
        const currentBrightness = Number.isInteger(storedBrightness)
          ? Math.max(0, Math.min(5, storedBrightness))
          : 0;
        return String(template || '')
          .replaceAll('%CUR_TRACK_NO%', String(trackNumbers.current))
          .replaceAll('%TOTAL_TRACKS_IN_LIST%', String(trackNumbers.total))
          .replaceAll('%CUR_BRIGHT%', String(currentBrightness));
      };
      const keepPlayerHint = (button, hint) => {
        const applyHint = () => {
          const resolvedHint = String(typeof hint === 'function' ? hint() : hint || '');
          if (button.getAttribute('title') !== resolvedHint) button.setAttribute('title', resolvedHint);
          if (button.getAttribute('aria-label') !== resolvedHint) button.setAttribute('aria-label', resolvedHint);
        };
        applyHint();
        button.dataset.vcardHint = 'true';
        new MutationObserver(applyHint).observe(button, {
          attributes: true,
          attributeFilter: ['title', 'aria-label']
        });
        return applyHint;
      };
      const keepDynamicPlayerHint = (button, template) => {
        const applyHint = keepPlayerHint(button, () => expandPlayerHint(template));
        dynamicHintRefreshers.push(applyHint);
      };
      const makeTrackButton = (direction, hint, icon) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'plyr__control plyr__controls__item';
        button.dataset.vcardTrackDirection = String(direction);
        keepDynamicPlayerHint(button, hint);
        button.disabled = buttons.length < 2;
        button.innerHTML = `<svg aria-hidden="true" focusable="false"><use href="#plyr-${icon}"></use></svg>`;
        button.addEventListener('click', () => openRelativeSong(direction, { play: true }));
        return button;
      };
      const playButton = player.elements.controls.querySelector('[data-plyr="play"]');
      if (playButton) {
        const playHint = vcardHints.playerPlay || playerText.play;
        keepDynamicPlayerHint(playButton, playHint);
        playButton.addEventListener('click', (event) => {
          document.dispatchEvent(new CustomEvent('vcard:prepare-audio-context'));
          if (!audio.paused && !audio.ended) return;
          const preview = (
            activePreview && activePreview.classList.contains('is-visible')
              ? activePreview
              : document.querySelector('.song__preview.is-visible')
          );
          if (!preview) return;
          // Resuming an already started track remains immediate. A prepared
          // track at 0:00 still gets its five-second static cassette card.
          if (
            preview === playingPreview
            && Number(audio.currentTime) > 0
            && !audio.ended
          ) return;
          const button = previewButton(preview);
          if (!button) return;
          // Plyr otherwise resumes the previously prepared source after this
          // capture handler has returned.  The visible portal owns Play.
          event.preventDefault();
          event.stopImmediatePropagation();
          playSong(preview, button);
        }, true);
        playButton.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          document.dispatchEvent(new CustomEvent('vcard:set-trackplay', {
            detail: { enabled: !trackPlayEnabled }
          }));
        });

        const controls = player.elements.controls;
        const previousButton = makeTrackButton(
          -1,
          vcardHints.playerPrevious || playerText.previousTrack,
          'previous-track'
        );
        const nextButton = makeTrackButton(
          1,
          vcardHints.playerNext || playerText.nextTrack,
          'next-track'
        );
        previousButton.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          document.dispatchEvent(new CustomEvent('vcard:step-visualization-brightness', {
            detail: { delta: -1 }
          }));
        });
        nextButton.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          document.dispatchEvent(new CustomEvent('vcard:step-visualization-brightness', {
            detail: { delta: 1 }
          }));
        });
        const presetButtons = [
          {
            key: 'night',
            hint: vcardHints.playerNight || 'Go NIGHT colors',
            icon: '<path fill="currentColor" d="M15.7 2.6A9.5 9.5 0 1 0 21.4 14 7.4 7.4 0 0 1 15.7 2.6Z"/>'
          },
          {
            key: 'mono',
            hint: vcardHints.playerMono || 'Go MONO colors',
            icon: '<path fill="currentColor" d="M12 3a9 9 0 0 0 0 18h1.35a2.65 2.65 0 0 0 0-5.3h-.9a1.45 1.45 0 0 1 0-2.9H15A6 6 0 0 0 15 3h-3Zm-4.5 8.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Zm2.25-3.5a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Zm4.25-.5a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Zm3 3a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Z"/>'
          },
          {
            key: 'duo',
            hint: vcardHints.playerDuo || 'Go DUO colors',
            icon: '<circle cx="9" cy="12" r="6" fill="currentColor"/><circle cx="15" cy="12" r="6" fill="none" stroke="currentColor" stroke-width="2"/>'
          },
          {
            key: 'newspaper',
            hint: vcardHints.playerNews || 'Go NEWSPAPER colors',
            icon: '<path fill="currentColor" d="M4 3h14a2 2 0 0 1 2 2v15H6a2 2 0 0 1-2-2V3Zm3 4v4h4V7H7Zm6 0v2h4V7h-4Zm0 4v2h4v-2h-4Zm-6 2v2h10v-2H7Zm0 4v1h10v-1H7Z"/>'
          }
        ].map((preset) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'plyr__control plyr__controls__item vcard-player-preset vcard-player-preset--' + preset.key;
          button.dataset.vcardPreset = preset.key;
          button.setAttribute('aria-label', preset.hint);
          button.setAttribute('title', preset.hint);
          button.setAttribute('aria-pressed', 'false');
          button.dataset.vcardHint = 'true';
          button.innerHTML = '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">' + preset.icon + '</svg>';
          button.addEventListener('click', () => {
            document.dispatchEvent(new CustomEvent('vcard:apply-preset', {
              detail: { preset: preset.key }
            }));
            button.blur();
          });
          const active = document.documentElement.dataset.colorPreset === preset.key;
          button.setAttribute('aria-pressed', active ? 'true' : 'false');
          button.classList.toggle('is-active', active);
          return button;
        });
        const presetGroup = document.createElement('div');
        presetGroup.className = 'vcard-player-button-group vcard-player-preset-group';
        presetGroup.setAttribute('aria-label', 'Цветовая схема');
        presetGroup.append(...presetButtons);
        const syncPresetButtons = () => {
          const key = String(document.documentElement.dataset.colorPreset || '');
          presetButtons.forEach((button) => {
            const active = button.dataset.vcardPreset === key;
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
            button.classList.toggle('is-active', active);
          });
        };

        const backgroundButtons = [
          {
            key: 'wallpaper',
            hint: vcardHints.playerBackgroundWallpaper || 'Background: wallpaper',
            icon: '<path d="M3.5 5.5h17v13h-17zM5.5 16l4.2-4.4 3.1 3 2.4-2.2 3.3 3.6M8 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'
          },
          {
            key: 'graph1',
            hint: vcardHints.playerBackgroundGraph1 || 'Background: graph 1',
            icon: '<path d="M2 12h3l2-5 3 10 3-7 2 4 2-2h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
          },
          {
            key: 'graph2',
            hint: vcardHints.playerBackgroundGraph2 || 'Background: graph 2',
            icon: '<path d="M3 4h18M6 8h12M9 12h6M6 16h12M3 20h18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
          },
          {
            key: 'smoke',
            hint: vcardHints.playerBackgroundSmoke || 'Background: smoke',
            icon: '<path d="M5 17c-2.8-2.1-2.2-6.2.7-7.3C6.4 6.3 10.5 5.3 12 8c1.4-3.3 6.2-2.4 6.7.8 3.7-.2 5.3 4.6 2.4 6.8.8 3.7-4.2 5.7-6.7 3.1-2.7 3.1-7.6 1.5-7.2-2.2-1.1.6-1.8.8-2.2.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
          }
        ].map((background) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'plyr__control plyr__controls__item vcard-player-background vcard-player-background--' + background.key;
          button.dataset.backgroundMode = background.key;
          button.setAttribute('aria-label', background.hint);
          button.setAttribute('title', background.hint);
          button.setAttribute('aria-pressed', background.key === playerBackgroundMode ? 'true' : 'false');
          button.dataset.vcardHint = 'true';
          button.innerHTML = '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">' + background.icon + '</svg>';
          button.classList.toggle('is-active', background.key === playerBackgroundMode);
          if (vcardFileMode && ['graph1', 'graph2'].includes(background.key)) {
            const unavailableHint = 'Визуализация недоступна при запуске из папки';
            button.disabled = true;
            button.setAttribute('aria-disabled', 'true');
            button.setAttribute('aria-label', unavailableHint);
            button.setAttribute('title', unavailableHint);
          }
          button.addEventListener('click', () => {
            if (document.documentElement.dataset.visBri === '0') {
              document.dispatchEvent(new CustomEvent('vcard:set-visualization-brightness', {
                detail: { level: 3 }
              }));
            }
            document.dispatchEvent(new CustomEvent('vcard:set-background', {
              detail: { mode: background.key, force: true }
            }));
            button.blur();
          });
          return button;
        });
        const backgroundGroup = document.createElement('div');
        backgroundGroup.className = 'vcard-player-button-group vcard-player-background-group';
        backgroundGroup.setAttribute('aria-label', 'Фон');
        const brightnessZeroButton = document.createElement('button');
        brightnessZeroButton.type = 'button';
        brightnessZeroButton.className = 'plyr__control plyr__controls__item vcard-player-background vcard-player-brightness-zero';
        brightnessZeroButton.dataset.vcardBrightnessZero = 'true';
        brightnessZeroButton.textContent = '✕';
        const brightnessZeroHint = vcardHints.playerBrightnessZero || 'Фон: яркость 0';
        brightnessZeroButton.setAttribute('aria-label', brightnessZeroHint);
        brightnessZeroButton.setAttribute('title', brightnessZeroHint);
        brightnessZeroButton.dataset.vcardHint = 'true';
        brightnessZeroButton.setAttribute('aria-pressed', 'false');
        brightnessZeroButton.addEventListener('click', () => {
          document.dispatchEvent(new CustomEvent('vcard:set-visualization-brightness', {
            detail: { level: 0 }
          }));
          brightnessZeroButton.blur();
        });
        backgroundGroup.append(brightnessZeroButton, ...backgroundButtons);

        const settingsButton = document.createElement('button');
        settingsButton.type = 'button';
        settingsButton.className = 'plyr__control plyr__controls__item vcard-player-settings';
        settingsButton.setAttribute('settings-link', '');
        settingsButton.setAttribute('aria-expanded', 'false');
        const settingsHint = vcardHints.playerSettings || 'Settings';
        settingsButton.setAttribute('aria-label', settingsHint);
        settingsButton.setAttribute('title', settingsHint);
        settingsButton.dataset.vcardHint = 'true';
        settingsButton.innerHTML = [
          '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">',
          '<path fill="currentColor" d="M19.14 12.94c.04-.31.05-.62.05-.94s-.01-.63-.05-.94l2.03-1.58-1.92-3.32-2.39.96a7.3 7.3 0 0 0-1.62-.94L14.88 3h-3.84l-.36 3.18a7.3 7.3 0 0 0-1.62.94l-2.39-.96-1.92 3.32 2.03 1.58c-.04.31-.05.62-.05.94s.01.63.05.94l-2.03 1.58 1.92 3.32 2.39-.96c.5.39 1.04.7 1.62.94l.36 3.18h3.84l.36-3.18a7.3 7.3 0 0 0 1.62-.94l2.39.96 1.92-3.32-2.03-1.58ZM12.96 15.2a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4Z"/>',
          '</svg>'
        ].join('');
        portalSizeButtons = [
          ['off', '0'],
          ['small', '1'],
          ['mid', '2'],
          ['full', '3']
        ].map(([size, label]) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'plyr__control plyr__controls__item vcard-portal-control vcard-portal-size';
          button.dataset.portalSize = size;
          button.textContent = label;
          const sizeHint = vcardHints[`player${label}`]
            || (size === 'off' ? 'Portal off' : `Portal size ${label}`);
          button.setAttribute('aria-label', sizeHint);
          button.setAttribute('aria-pressed', 'false');
          button.addEventListener('click', () => {
            setPlayerPortalSize(size);
            button.blur();
          });
          return button;
        });
        const portalGroup = document.createElement('div');
        portalGroup.className = 'vcard-player-button-group vcard-player-portal-group';
        const portalSizeHint = vcardHints.playerPortalSize || 'Размер и видимость картинок';
        keepPlayerHint(portalGroup, portalSizeHint);
        portalGroup.append(...portalSizeButtons);

        const fontScaleButtons = [
          ['xs', 'z'],
          ['s', 'z'],
          ['m', 'z'],
          ['l', 'Z'],
          ['xl', 'Z']
        ].map(([key, label]) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'plyr__control plyr__controls__item vcard-font-scale';
          button.dataset.vcardFontScale = key;
          button.textContent = label;
          button.setAttribute('aria-label', `Размер шрифта ${key}`);
          button.setAttribute('aria-pressed', 'false');
          button.addEventListener('click', () => {
            document.dispatchEvent(new CustomEvent('vcard:set-font-scale', {
              detail: { key }
            }));
            button.blur();
          });
          return button;
        });
        const fontScaleGroup = document.createElement('div');
        fontScaleGroup.className = 'vcard-player-button-group vcard-player-font-scale-group';
        const fontScaleHint = vcardHints.playerFontScale || 'Размер шрифта';
        keepPlayerHint(fontScaleGroup, fontScaleHint);
        fontScaleGroup.append(...fontScaleButtons);

        const portraitToolbarMedia = window.matchMedia('(orientation: portrait)');
        const syncPortraitPlayerToolbar = () => {
          if (portraitToolbarMedia.matches) {
            playerTopline.replaceChildren(
              playButton,
              playerTitle,
              settingsButton
            );
            // Portrait keeps its two essential portal sizes.  The track
            // buttons divide the colour-scheme and background groups.
            playerSecondline.replaceChildren(
              portalGroup,
              presetGroup,
              previousButton,
              nextButton,
              backgroundGroup
            );
            fontScaleGroup.remove();
            syncPresetButtons();
            return;
          }

          playerTopline.replaceChildren(
            playButton,
            presetGroup,
            previousButton,
            playerTitle,
            nextButton,
            backgroundGroup,
            settingsButton
          );
          playerSecondline.replaceChildren();
          controls.prepend(portalGroup, fontScaleGroup);
          // The preset group was detached in portrait.  Restore its state
          // from the canonical root dataset after moving it back.
          syncPresetButtons();
        };
        portraitToolbarMedia.addEventListener('change', syncPortraitPlayerToolbar);
        syncPortraitPlayerToolbar();

        const brightnessRow = document.createElement('div');
        brightnessRow.className = 'plyr__controls__item vcard-player-brightness-row';
        const brightnessHint = vcardHints.playerBrightness
          || 'Яркость фона: %CUR_BRIGHT%, 0=всё выкл';
        keepDynamicPlayerHint(brightnessRow, brightnessHint);
        Array.from({ length: 6 }, (_item, level) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'plyr__control vcard-player-brightness-level';
          button.dataset.vcardBrightnessLevel = String(level);
          button.textContent = String(level);
          button.setAttribute('aria-label', `Яркость фона ${level}`);
          button.setAttribute('aria-pressed', 'false');
          button.addEventListener('click', () => {
            document.dispatchEvent(new CustomEvent('vcard:set-visualization-brightness', {
              detail: { level }
            }));
            button.blur();
          });
          brightnessRow.append(button);
        });
        controls.append(brightnessRow);
        const soundButton = controls.querySelector('[data-plyr="mute"]');
        if (soundButton) {
          const soundHint = vcardHints.playerSound || playerText.mute;
          keepPlayerHint(soundButton, soundHint);
        }
        refreshPortalControls();
        refreshDynamicPlayerHints = () => {
          dynamicHintRefreshers.forEach((refreshHint) => refreshHint());
        };
        refreshDynamicPlayerHints();
      }
      document.dispatchEvent(new CustomEvent('vcard:request-portal-state', {
        detail: { preview: activePreview }
      }));
      player.elements.controls.querySelectorAll('button, input, a').forEach((element) => {
        if (element.dataset.vcardHint === 'true') return;
        element.removeAttribute('title');
      });
      publishPlayerMp3Info(activePreview);
      document.dispatchEvent(new CustomEvent('vcard:request-visualization-state'));
      document.dispatchEvent(new CustomEvent('vcard:request-background-state'));
      audio.addEventListener('error', () => setAudioAvailable(audio, false));
      players.set(audio, player);
      return player;
    };

    const syncPlayerBackgroundButtonStates = () => {
      const brightnessIsOff = document.documentElement.dataset.visBri === '0';
      document.querySelectorAll('[data-background-mode], [data-settings-background-mode]').forEach((button) => {
        const mode = button.dataset.backgroundMode || button.dataset.settingsBackgroundMode;
        const active = !brightnessIsOff && mode === playerBackgroundMode;
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        button.classList.toggle('is-active', active);
      });
    };

    document.addEventListener('vcard:background-state', (event) => {
      const detail = event.detail || {};
      playerBackgroundMode = detail.mode || playerBackgroundMode;
      syncPlayerBackgroundButtonStates();
    });

    document.addEventListener('vcard:visualization-state', (event) => {
      const brightness = Number(event.detail && event.detail.brightnessLevel);
      const value = Number.isInteger(brightness) ? String(brightness) : '0';
      document.querySelectorAll('[data-vcard-brightness-value]').forEach((element) => {
        element.textContent = value;
      });
      document.querySelectorAll('[data-vcard-brightness-level]').forEach((button) => {
        const active = button.dataset.vcardBrightnessLevel === value;
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        button.classList.toggle('is-active', active);
      });
      document.querySelectorAll('[data-vcard-brightness-zero]').forEach((button) => {
        const active = value === '0';
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        button.classList.toggle('is-active', active);
      });
      syncPlayerBackgroundButtonStates();
      refreshDynamicPlayerHints();
    });
    document.addEventListener('vcard:song-open', () => refreshDynamicPlayerHints());

    document.addEventListener('vcard:preset-state', (event) => {
      const key = String((event.detail && event.detail.key) || '');
      document.querySelectorAll('[data-vcard-preset]').forEach((button) => {
        const active = button.dataset.vcardPreset === key;
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        button.classList.toggle('is-active', active);
      });
    });

    document.addEventListener('vcard:portal-state', (event) => {
      const detail = event.detail || {};
      document.querySelectorAll('[data-portal-toggle="image"]').forEach((button) => {
        const visible = detail.visible !== false;
        button.setAttribute('aria-pressed', visible ? 'true' : 'false');
        button.classList.toggle('is-active', visible);
        button.removeAttribute('title');
        button.setAttribute('aria-label', visible ? 'Images: ON' : 'Images: OFF');
      });
    });

    document.addEventListener('vcard:trackplay-state', (event) => {
      const mode = event.detail && event.detail.enabled ? 'on' : 'off';
      document.querySelectorAll('[data-settings-track-play]').forEach((button) => {
        const active = button.dataset.settingsTrackPlay === mode;
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        button.classList.toggle('is-active', active);
      });
    });

    document.addEventListener('vcard:color-scheme-state', (event) => {
      const key = event.detail && event.detail.key;
      document.querySelectorAll('[data-settings-color-scheme]').forEach((button) => {
        const active = button.dataset.settingsColorScheme === key;
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        button.classList.toggle('is-active', active);
      });
    });

    document.addEventListener('vcard:font-scale-state', (event) => {
      const key = event.detail && event.detail.key;
      document.querySelectorAll('[data-settings-font-scale], [data-vcard-font-scale]').forEach((button) => {
        const buttonKey = button.dataset.settingsFontScale || button.dataset.vcardFontScale;
        const active = buttonKey === key;
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        button.classList.toggle('is-active', active);
      });
    });

    const setActiveIndexButton = (activeListId) => {
      indexButtons.forEach((button) => {
        const active = (
          Boolean(activeListId)
          && button.getAttribute('list') === activeListId
        );
        button.classList.toggle('is-active', active);
        if (active) {
          button.setAttribute('aria-current', 'page');
        } else {
          button.removeAttribute('aria-current');
        }
      });
    };

    const showListById = (id) => {
      if (!id) return;
      listSections.forEach((section) => {
        if (section.id === id) {
          section.style.display = '';
        } else {
          section.style.display = 'none';
        }
      });
    };

    const playerDockHeight = () => {
      const player = playerDock.querySelector('.plyr');
      if (!player || player.hidden || getComputedStyle(player).display === 'none') return 0;
      return playerDock.getBoundingClientRect().height;
    };

    const ACTIVE_PLAYLIST_STORAGE_KEY = 'vcard-active-playlist';

    const activateList = (targetListId) => {
      setActiveIndexButton(targetListId);
      showListById(targetListId);
      localStorage.setItem(ACTIVE_PLAYLIST_STORAGE_KEY, targetListId);
      document.dispatchEvent(new CustomEvent('vcard:playlist-change', {
        detail: { listId: targetListId }
      }));
    };

    // Restore the last selected playlist when it is present in this build.
    // A removed/renamed list falls back to the configured initial button.
    const rememberedPlaylist = localStorage.getItem(ACTIVE_PLAYLIST_STORAGE_KEY);
    const initialActive = indexButtons.find((button) => (
      button.getAttribute('list') === rememberedPlaylist
    )) || indexButtons.find((button) => button.classList.contains('is-active'));
    if (initialActive) {
      const initialId = initialActive.getAttribute('list');
      if (initialId) activateList(initialId);
    } else if (listSections.length) {
      showListById(listSections[0].id);
    }

    indexButtons.forEach((button) => {
      button.addEventListener('click', (event) => {
        const targetListId = button.getAttribute('list');
        if (targetListId) {
          event.preventDefault();
          activateList(targetListId);
          return;
        }

        // Fallback: if button has data-page, navigate as before
        if (button.dataset.page) {
          window.location.href = button.dataset.page;
        }
      });
    });

    const resolveSource = (preview) => {
      const host = preview ? preview.querySelector('[ids="audio"]') : null;
      const hostSrc = host ? (host.dataset.audioSrc || '').trim() : '';
      const previewSrc = preview ? (preview.dataset.src || '').trim() : '';
      return hostSrc || previewSrc || '';
    };

    const isPlayableSource = (src) => {
      const value = (src || '').trim();
      return !!value && !value.endsWith('/');
    };

    const ensureAudioSource = (preview, audioEl) => {
      if (!preview || !audioEl) return '';
      const src = resolveSource(preview);
      if (!isPlayableSource(src)) {
        clearTrackBandHighlight();
        audioEl.pause();
        audioEl.removeAttribute('src');
        audioEl.load && audioEl.load();
        setAudioAvailable(audioEl, false);
        publishPlayerMp3Info(preview);
        document.dispatchEvent(new CustomEvent('vcard:request-portal-state', {
          detail: { preview }
        }));
        return '';
      }
      preview.dataset.src = src;
      if (audioEl.getAttribute('src') !== src) {
        clearTrackBandHighlight();
        const retainedVolume = audioEl.volume;
        const retainedMuted = audioEl.muted;
        audioEl.setAttribute('src', src);
        audioEl.load && audioEl.load();
        audioEl.volume = retainedVolume;
        audioEl.muted = retainedMuted;
      }
      const player = players.get(audioEl);
      if (player) publishPlayerMp3Info(preview);
      setAudioAvailable(audioEl, true);
      document.dispatchEvent(new CustomEvent('vcard:request-portal-state', {
        detail: { preview }
      }));
      return src;
    };

    const showPreview = (preview) => {
      if (!preview) return;
      preview.hidden = false;
      activatePreviewPortal(preview, playerImagesVisible, true);
      requestAnimationFrame(() => {
        preview.classList.add('is-visible');
        preview.dispatchEvent(new CustomEvent('vcard:song-open', { bubbles: true }));
      });
    };

    const hidePreview = (preview) => {
      if (!preview) return;
      if (!songRestoreApplying) forgetSavedSong(preview);
      activatePreviewPortal(preview, false);
      preview.dispatchEvent(new CustomEvent('vcard:song-close', { bubbles: true }));
      preview.classList.remove('is-visible');
      const transitionMs = getComputedStyle(preview).transitionDuration
        .split(',')
        .some((duration) => parseFloat(duration) > 0);
      if (!transitionMs) {
        try { preview.hidden = true; } catch (err) { }
        return;
      }
      const onEnd = (e) => {
        if (e && e.target !== preview) return;
        if (preview.classList.contains('is-visible')) {
          preview.removeEventListener('transitionend', onEnd);
          return;
        }
        try { preview.hidden = true; } catch (err) { }
        preview.removeEventListener('transitionend', onEnd);
      };
      preview.addEventListener('transitionend', onEnd);
    };

    const hideAllPreviews = () => {
      if (activePreview) hidePreview(activePreview);
      const activeButton = document.querySelector('.song__item.is-active');
      if (activeButton) activeButton.classList.remove('is-active');
    };

    const buttonPreview = (button) => {
      const anchor = button && button.closest('.song__title') ? button.closest('.song__title') : button;
      let node = anchor ? anchor.nextElementSibling : null;
      while (node && !node.classList.contains('song__preview')) {
        node = node.nextElementSibling;
      }
      return node && node.classList.contains('song__preview') ? node : null;
    };

    const previewButton = (preview) => {
      let node = preview ? preview.previousElementSibling : null;
      if (node && node.classList.contains('song__title')) {
        const button = node.querySelector('.song__item');
        return button || null;
      }
      while (node && !node.classList.contains('song__item')) {
        node = node.previousElementSibling;
      }
      return node && node.classList.contains('song__item') ? node : null;
    };

    const readSavedSong = () => {
      try {
        const raw = window.sessionStorage.getItem(SONG_RESTORE_SESSION_KEY);
        if (!raw) return null;
        const value = JSON.parse(raw);
        return value && typeof value === 'object' ? value : null;
      } catch (_error) {
        return null;
      }
    };

    const writeSavedSong = (value) => {
      try {
        window.sessionStorage.setItem(SONG_RESTORE_SESSION_KEY, JSON.stringify(value));
      } catch (_error) {
        // Private browsing or a full storage quota must not affect playback.
      }
    };

    const forgetSavedSong = (preview = null) => {
      const saved = readSavedSong();
      const button = previewButton(preview);
      if (
        preview
        && saved
        && button
        && (
          saved.list !== String(button.dataset.list || '')
          || saved.song !== String(button.dataset.song || '')
        )
      ) return;
      if (songRestoreWriteTimer) {
        window.clearTimeout(songRestoreWriteTimer);
        songRestoreWriteTimer = 0;
      }
      try {
        window.sessionStorage.removeItem(SONG_RESTORE_SESSION_KEY);
      } catch (_error) { }
    };

    const savedVerseIndex = (preview, time) => {
      const text = preview && preview.querySelector('.song__preview-text[data-track-band]');
      const thresholds = parseTrackBand(text && text.dataset.trackBand);
      if (!thresholds.length) return -1;
      return thresholds.reduce(
        (index, threshold, candidate) => (time >= threshold ? candidate : index),
        -1
      );
    };

    const rememberSongPosition = (preview = playingPreview || activePreview, immediate = false) => {
      if (songRestoreApplying || !preview || !preview.classList.contains('is-visible')) return;
      const button = previewButton(preview);
      const audio = sharedSongAudio;
      const isCurrentTrack = Boolean(audio && audio.vcardPlayingPreview === preview);
      const time = isCurrentTrack && Number.isFinite(audio.currentTime)
        ? Math.max(0, audio.currentTime)
        : 0;
      const state = {
        list: String((button && button.dataset.list) || ''),
        song: String((button && button.dataset.song) || ''),
        time,
        verse: savedVerseIndex(preview, time),
      };
      if (!state.list || !state.song) return;
      const persist = () => {
        songRestoreWriteTimer = 0;
        writeSavedSong(state);
      };
      if (immediate) {
        if (songRestoreWriteTimer) window.clearTimeout(songRestoreWriteTimer);
        persist();
        return;
      }
      if (!songRestoreWriteTimer) {
        songRestoreWriteTimer = window.setTimeout(persist, 750);
      }
    };

    const restoreSavedSong = () => {
      const saved = readSavedSong();
      if (!saved) return;
      const button = buttons.find((item) => (
        String(item.dataset.list || '') === String(saved.list || '')
        && String(item.dataset.song || '') === String(saved.song || '')
      ));
      if (!button) {
        forgetSavedSong();
        return;
      }

      const listId = String(button.dataset.list || '');
      if (listId) activateList(listId);
      songRestoreApplying = true;
      openSongButton(button, { forceOpen: true, play: false, restore: true });
      const preview = buttonPreview(button);
      const audio = sharedSongAudio;
      if (!preview || !audio) {
        songRestoreApplying = false;
        return;
      }

      const restorePosition = () => {
        if (audio.vcardPlayingPreview !== preview) {
          songRestoreApplying = false;
          return;
        }
        const savedTime = Number(saved.time);
        const verseTime = (() => {
          const text = preview.querySelector('.song__preview-text[data-track-band]');
          const thresholds = parseTrackBand(text && text.dataset.trackBand);
          return Number.isInteger(saved.verse) ? thresholds[saved.verse] : NaN;
        })();
        let target = Number.isFinite(savedTime) && savedTime >= 0
          ? savedTime
          : (Number.isFinite(verseTime) ? verseTime : 0);
        if (Number.isFinite(audio.duration)) {
          target = Math.min(target, Math.max(0, audio.duration - 0.05));
        }
        try {
          audio.currentTime = target;
        } catch (_error) { }
        requestAnimationFrame(() => requestAnimationFrame(() => {
          updateTrackBandHighlight({ scroll: false, allowPaused: true });
          scrollPreviewPortalToTop(preview, 'auto');
          const text = preview.querySelector('.song__preview-text[data-track-band]');
          const verse = text && text.querySelector(
            `.song__track-verse[data-track-verse="${savedVerseIndex(preview, target)}"]`
          );
          if (verse) centerTrackBandVerse(verse, 'auto');
          else centerPreviewTrackVerse(preview, 'auto');
          songRestoreApplying = false;
          rememberSongPosition(preview, true);
        }));
      };
      if (audio.readyState >= 1) {
        restorePosition();
      } else {
        audio.addEventListener('loadedmetadata', restorePosition, { once: true });
      }
    };

    const openRelativeSong = (direction, options = {}) => {
      const currentButton = previewButton(playingPreview) || previewButton(activePreview) || document.querySelector('.song__item.is-active');
      const currentIdx = buttons.indexOf(currentButton);
      if (currentIdx < 0 || !buttons.length) return;
      const nextIdx = (currentIdx + direction + buttons.length) % buttons.length;
      const nextButton = buttons[nextIdx];
      if (!nextButton) return;
      const nextListId = nextButton.dataset.list || '';
      if (nextListId) activateList(nextListId);
      openSongButton(nextButton, {
        forceOpen: true,
        play: options.play !== false,
        fromEnded: options.fromEnded === true,
      });
    };

    const playableButtonsForList = (listId) => buttons.filter((button) => (
      String(button.dataset.list || '') === String(listId || '')
      && isPlayableSource(resolveSource(buttonPreview(button)))
    ));

    const playableListIds = () => [...new Set([
      ...listSections.map((section) => String(section.id || '')),
      ...buttons.map((button) => String(button.dataset.list || '')),
    ])].filter((listId) => listId && playableButtonsForList(listId).length);

    const shuffled = (items) => {
      const result = [...items];
      for (let index = result.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
      }
      return result;
    };

    const resetRandomSongBag = (listId, currentButton = null) => {
      const bag = shuffled(
        playableButtonsForList(listId).filter((button) => button !== currentButton)
      );
      randomSongBags.set(listId, bag);
      return bag;
    };

    const takeRandomSong = (listId, currentButton = null) => {
      const bag = randomSongBags.has(listId)
        ? randomSongBags.get(listId)
        : resetRandomSongBag(listId, currentButton);
      return bag.shift() || null;
    };

    const nextPlaylistId = (currentListId) => {
      if (playlistAlternation === 'none') return '';
      const listIds = playableListIds();
      if (!listIds.length) return '';
      const currentIndex = listIds.indexOf(currentListId);
      if (playlistAlternation === 'random') {
        const candidates = listIds.length > 1
          ? listIds.filter((listId) => listId !== currentListId)
          : listIds;
        return candidates[Math.floor(Math.random() * candidates.length)] || '';
      }
      const direction = playlistAlternation === 'previous' ? -1 : 1;
      const baseIndex = currentIndex < 0 ? 0 : currentIndex;
      return listIds[(baseIndex + direction + listIds.length) % listIds.length] || '';
    };

    const openAutoNextSong = (currentButton) => {
      if (!currentButton || songAlternation === 'none') return false;
      const currentListId = String(currentButton.dataset.list || '');
      const currentListButtons = playableButtonsForList(currentListId);
      let nextButton = null;

      if (songAlternation === 'random') {
        nextButton = takeRandomSong(currentListId, currentButton);
      } else {
        const currentIndex = currentListButtons.indexOf(currentButton);
        if (currentIndex >= 0 && currentIndex + 1 < currentListButtons.length) {
          nextButton = currentListButtons[currentIndex + 1];
        }
      }

      if (!nextButton) {
        const targetListId = nextPlaylistId(currentListId);
        if (!targetListId) return false;
        const targetButtons = playableButtonsForList(targetListId);
        if (songAlternation === 'random') {
          const bag = resetRandomSongBag(targetListId);
          nextButton = bag.shift() || null;
        } else {
          nextButton = targetButtons[0] || null;
        }
      }

      if (!nextButton) return false;
      const nextListId = String(nextButton.dataset.list || '');
      if (nextListId) activateList(nextListId);
      openSongButton(nextButton, {
        forceOpen: true,
        play: true,
        fromEnded: true,
      });
      return true;
    };

    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.setActionHandler('previoustrack', () => openRelativeSong(-1, { play: true }));
        navigator.mediaSession.setActionHandler('nexttrack', () => openRelativeSong(1, { play: true }));
      } catch (error) {
        console.debug('VCard media session track controls are unavailable.', error);
      }
    }

    const bindAutoAdvance = (audioEl, currentButton) => {
      if (!audioEl || !currentButton) return;
      audioEl.onended = () => {
        cancelAutoAdvance();
        if (singleSongPlayback) {
          singleSongPlayback = false;
          return;
        }
        if (songAlternation === 'none') return;
        autoPlayFromEnded = true;
        const endedPreview = playingPreview;
        const endedSource = audioEl.currentSrc || audioEl.src;
        autoAdvanceTimer = window.setTimeout(() => {
          autoAdvanceTimer = 0;
          if (
            !audioEl.ended
            || playingPreview !== endedPreview
            || (audioEl.currentSrc || audioEl.src) !== endedSource
          ) {
            autoPlayFromEnded = false;
            return;
          }
          if (!openAutoNextSong(currentButton)) autoPlayFromEnded = false;
        }, END_TRACK_TRANSITION_DELAY_MS);
      };
    };

    const playSong = (preview, button, { delayStart = false } = {}) => {
      const audioEl = sharedSongAudio;
      if (!preview || !button || !audioEl) return;
      singleSongPlayback = false;
      playingPreview = preview;
      const newSongSelected = audioEl.vcardPlayingPreview !== preview;
      audioEl.vcardPlayingPreview = preview;
      if (newSongSelected) {
        document.dispatchEvent(new CustomEvent('vcard:song-start', {
          detail: { preview }
        }));
      }
      setPlayerTitle(button, preview);
      const audioSrc = ensureAudioSource(preview, audioEl);
      if (!audioSrc) return;
      bindAutoAdvance(audioEl, button);
      setAudioAvailable(audioEl, true);

      const startFromBeginning = () => {
        if (
          playingPreview !== preview
          || audioEl.getAttribute('src') !== audioSrc
        ) return;
        try {
          audioEl.currentTime = 0;
        } catch (error) {
          console.warn(`VCard audio: cannot rewind ${audioSrc}`, error);
        }
        rememberSongPosition(preview, true);
        updateTrackBandHighlight();
        scheduleTrackVerseLayout(preview);
        if (!audioEl.play) return;
        document.dispatchEvent(new CustomEvent('vcard:prepare-audio-context'));
        audioEl.play().catch((error) => {
          console.warn(`VCard audio: cannot play ${audioSrc}`, error);
          setAudioAvailable(audioEl, false);
        });
      };

      const scheduleStart = () => {
        if (!delayStart) {
          if (pendingAutoOpenStartTimer) {
            window.clearTimeout(pendingAutoOpenStartTimer);
            pendingAutoOpenStartTimer = 0;
          }
          startFromBeginning();
          return;
        }
        if (pendingAutoOpenStartTimer) {
          window.clearTimeout(pendingAutoOpenStartTimer);
        }
        pendingAutoOpenStartTimer = window.setTimeout(() => {
          pendingAutoOpenStartTimer = 0;
          // A click on the portal may have started this prepared track.
          if (!audioEl.paused && !audioEl.ended) return;
          startFromBeginning();
        }, AUTO_OPEN_START_DELAY_MS);
      };

      if (audioEl.readyState >= 1) {
        scheduleStart();
      } else {
        audioEl.addEventListener('loadedmetadata', scheduleStart, { once: true });
      }
    };

    const prepareSongPlayer = (preview, button) => {
      const audioEl = sharedSongAudio;
      if (!preview || !button || !audioEl) return '';
      playingPreview = preview;
      const newSongSelected = audioEl.vcardPlayingPreview !== preview;
      audioEl.vcardPlayingPreview = preview;
      if (newSongSelected) {
        document.dispatchEvent(new CustomEvent('vcard:song-start', {
          detail: { preview }
        }));
      }
      const audioSrc = ensureAudioSource(preview, audioEl);
      if (!audioSrc) return '';
      bindAutoAdvance(audioEl, button);
      setAudioAvailable(audioEl, true);
      updateTrackBandHighlight();
      rememberSongPosition(preview, true);
      return audioSrc;
    };

    const playTrackBandVerse = (verse) => {
      const text = verse && verse.closest('.song__preview-text[data-track-band]');
      const preview = text && text.closest('.song__preview');
      const button = previewButton(preview);
      const index = Number.parseInt(verse && verse.dataset.trackVerse, 10);
      const thresholds = parseTrackBand(text && text.dataset.trackBand);
      const startTime = thresholds[index];
      if (!preview || !button || !Number.isFinite(startTime)) return;
      initialTrackLayoutPreview = null;
      singleSongPlayback = false;
      cancelAutoAdvance();
      if (!prepareSongPlayer(preview, button)) return;

      activePreview = preview;
      const previousButton = document.querySelector('.song__item.is-active');
      if (previousButton && previousButton !== button) {
        previousButton.classList.remove('is-active');
      }
      button.classList.add('is-active');

      const seek = () => {
        try {
          sharedSongAudio.currentTime = startTime;
        } catch (error) {
          console.warn(`VCard track band: cannot seek to ${startTime}`, error);
        }
      };
      if (sharedSongAudio.readyState >= 1) {
        seek();
      } else {
        sharedSongAudio.addEventListener('loadedmetadata', seek, { once: true });
      }

      document.dispatchEvent(new CustomEvent('vcard:prepare-audio-context'));
      sharedSongAudio.play().then(updateTrackBandHighlight).catch((error) => {
        console.warn('VCard track band: cannot start playback', error);
      });
    };

    document.querySelectorAll('.song__preview-text[data-track-band]').forEach((text) => {
      if (!parseTrackBand(text.dataset.trackBand).length) return;
      prepareTrackBandText(text);

      let lastTouchTap = null;
      let suppressNativeDoubleClickUntil = 0;
      const doubleTapDelay = 360;
      const doubleTapDistance = 24;
      text.addEventListener('pointerup', (event) => {
        if (event.pointerType !== 'touch') return;
        const verse = event.target.closest('.song__track-verse');
        if (!verse) return;
        const now = performance.now();
        const previousTap = lastTouchTap;
        lastTouchTap = null;
        if (
          previousTap
          && previousTap.verse === verse
          && now - previousTap.at <= doubleTapDelay
          && Math.abs(event.clientX - previousTap.x) <= doubleTapDistance
          && Math.abs(event.clientY - previousTap.y) <= doubleTapDistance
        ) {
          suppressNativeDoubleClickUntil = now + doubleTapDelay;
          event.preventDefault();
          playTrackBandVerse(verse);
          return;
        }
        lastTouchTap = { verse, at: now, x: event.clientX, y: event.clientY };
      });
      text.addEventListener('pointercancel', () => {
        lastTouchTap = null;
      });
      text.addEventListener('contextmenu', (event) => {
        if (!event.target.closest('.song__track-verse')) return;
        event.preventDefault();
      });
      text.addEventListener('dblclick', (event) => {
        const verse = event.target.closest('.song__track-verse');
        if (!verse) return;
        if (performance.now() < suppressNativeDoubleClickUntil) return;
        event.preventDefault();
        playTrackBandVerse(verse);
      });
    });

    hideAllPreviews();

    if (sharedSongAudio) {
      enhanceAudio(sharedSongAudio);
      moveSharedPlayer(sharedSongAudio);
      sharedSongAudio.preload = 'none';
      setAudioAvailable(sharedSongAudio, false);
      sharedSongAudio.addEventListener('play', cancelAutoAdvance);
      sharedSongAudio.addEventListener('play', () => setAudioAvailable(sharedSongAudio, true));
      sharedSongAudio.addEventListener('timeupdate', updateTrackBandHighlight);
      sharedSongAudio.addEventListener('seeked', () => updateTrackBandHighlight({
        allowPaused: true,
        force: true,
        seeked: true,
      }));
      sharedSongAudio.addEventListener('loadedmetadata', updateTrackBandHighlight);
      sharedSongAudio.addEventListener('timeupdate', () => rememberSongPosition());
      sharedSongAudio.addEventListener('seeked', () => rememberSongPosition(undefined, true));
      sharedSongAudio.addEventListener('loadedmetadata', () => rememberSongPosition(undefined, true));
      sharedSongAudio.addEventListener('play', () => {
        if (!playingPreview) return;
        setPlayerTitle(previewButton(playingPreview), playingPreview);
        const initialLayout = initialTrackLayoutPreview === playingPreview;
        initialTrackLayoutPreview = null;
        if (initialLayout) alignInitialTrackLayout(playingPreview);
        updateTrackBandHighlight({ scroll: !initialLayout });
      });
      sharedSongAudio.addEventListener('pause', () => {
        clearTrackBandHighlight();
      });
      // A short network/audio-buffer underrun must not make tracking appear
      // disabled.  Keep the last timed verse active until playback resumes;
      // the next timeupdate/seeked event will advance it normally.
      sharedSongAudio.addEventListener('emptied', clearTrackBandHighlight);
      sharedSongAudio.addEventListener('ended', () => {
        clearTrackBandHighlight();
        forgetSavedSong(playingPreview);
      });
    }

    document.addEventListener('vcard:play-single-song', (event) => {
      const preview = event.detail && event.detail.preview;
      if (!preview || preview !== playingPreview) return;
      cancelAutoAdvance();
      singleSongPlayback = true;
    });

    document.addEventListener('vcard:track-verse-active', (event) => {
      rememberSongPosition(event.detail && event.detail.preview, true);
    });
    window.addEventListener('pagehide', () => rememberSongPosition(undefined, true));

    const scrollPreviewPortalToTop = (preview, behavior = 'auto') => {
      const videoLinks = preview && preview.querySelector('.song__video-links');
      const videoLink = videoLinks && videoLinks.querySelector('.song__video-link');
      const height = playerDockHeight();
      document.documentElement.style.setProperty('--song-sticky-audio-height', `${height}px`);
      if (videoLink) {
        const linkDocumentTop = window.scrollY + videoLinks.getBoundingClientRect().top;
        const top = Math.max(0, linkDocumentTop - height);
        window.scrollTo({ top, behavior });
        return top;
      }

      const frame = preview && preview.querySelector('.song-portal-stage, .song-vibeframe');
      const text = preview && preview.querySelector('.song__preview-text');
      if (!text) return;
      const firstVerse = text.querySelector('.song__track-verse') || text;
      if (!frame || frame.hidden || getComputedStyle(frame).display === 'none') {
        const firstVerseDocumentTop = window.scrollY + firstVerse.getBoundingClientRect().top;
        const verseStyle = getComputedStyle(firstVerse);
        const lineGap = Number.parseFloat(verseStyle.lineHeight)
          || Number.parseFloat(verseStyle.fontSize)
          || 0;
        const top = Math.max(0, firstVerseDocumentTop - height - lineGap);
        window.scrollTo({ top, behavior });
        return top;
      }

      const frameDocumentTop = window.scrollY + frame.getBoundingClientRect().top;
      const top = Math.max(0, frameDocumentTop - height);
      window.scrollTo({ top, behavior });
      return top;
    };

    const schedulePortalScroll = (preview, behavior = 'auto') => {
      const hasVideoLinks = Boolean(
        preview && preview.querySelector('.song__video-links .song__video-link')
      );
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (activePreview !== preview) return;
          scrollPreviewPortalToTop(preview, behavior);
          if (hasVideoLinks) return;
          requestAnimationFrame(() => {
            if (activePreview !== preview) return;
            centerPreviewTrackVerse(preview, behavior);
          });
        });
      });

      const image = preview && preview.querySelector('.song__preview-image');
      if (image && !image.complete) {
        image.addEventListener('load', () => {
          if (activePreview !== preview) return;
          requestAnimationFrame(() => {
            scrollPreviewPortalToTop(preview, 'auto');
            if (!hasVideoLinks) centerPreviewTrackVerse(preview, 'auto');
          });
        }, { once: true });
      }
    };

    const openSongButton = (button, options = {}) => {
      const preview = buttonPreview(button);
      if (!preview || !preview.classList.contains('song__preview')) return;
      if (!options.fromEnded) {
        singleSongPlayback = false;
        cancelAutoAdvance();
        if (songAlternation === 'random') {
          resetRandomSongBag(String(button.dataset.list || ''), button);
        }
      }

      // Toggle behavior: clicking an already open item closes its preview
      if (!options.forceOpen && button.classList.contains('is-active') && preview.classList.contains('is-visible')) {
        hidePreview(preview);
        button.classList.remove('is-active');
        if (initialTrackLayoutPreview === preview) initialTrackLayoutPreview = null;
        activePreview = null;
        refreshPortalControls();
        autoPlayFromEnded = false;
        return;
      }

      const shouldAutoPlay = autoPlayFromEnded;
      autoPlayFromEnded = false;

      hideAllPreviews();
      showPreview(preview);
      button.classList.add('is-active');
      activePreview = preview;
      initialTrackLayoutPreview = preview;

      const keepsPreviousPlayback = Boolean(
        sharedSongAudio
        && !sharedSongAudio.paused
        && !sharedSongAudio.ended
      );
      const startsAutomatically = Boolean(shouldAutoPlay || options.play);
      const continuesPreviousPlayback = !startsAutomatically && keepsPreviousPlayback;
      document.dispatchEvent(new CustomEvent('vcard:portal-open', {
        detail: {
          preview,
          autoPlay: startsAutomatically || continuesPreviousPlayback,
          continuesPlayback: continuesPreviousPlayback,
        }
      }));

      if (startsAutomatically) {
        playSong(preview, button, { delayStart: Boolean(options.fromEnded) });
      } else if (!sharedSongAudio || sharedSongAudio.paused || sharedSongAudio.ended) {
        prepareSongPlayer(preview, button);
      }
      if (!options.restore) {
        requestAnimationFrame(() => rememberSongPosition(preview, true));
      }
      refreshDynamicPlayerHints();

      try {
        schedulePortalScroll(preview, options.play ? 'smooth' : 'auto');
      } catch (e) { }
    };

    buttons.forEach((button) => {
      button.addEventListener('click', () => openSongButton(button));
      button.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openSongButton(button);
      });
    });

    document.querySelectorAll('.song__text-year').forEach((year) => {
      const activate = () => {
        const preview = year.closest('.song__preview');
        const button = previewButton(preview);
        if (button) openSongButton(button);
      };
      year.addEventListener('click', activate);
      year.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        activate();
      });
    });

    // Wait until the first layout pass has created the sticky player.  This
    // keeps the restored portal and verse aligned with its real height.
    window.requestAnimationFrame(restoreSavedSong);

    (() => {
      const triggers = Array.from(document.querySelectorAll(
        '[settings-link]'
      ));
      if (!triggers.length) return;

      const dialog = document.createElement('div');
      dialog.className = 'vcard-settings-dialog';
      dialog.hidden = true;
      dialog.setAttribute('role', 'dialog');

      const panel = document.createElement('div');
      panel.className = 'vcard-settings-dialog__panel';
      const header = document.createElement('header');
      header.className = 'vcard-settings-dialog__header';
      const closeButton = document.createElement('button');
      closeButton.type = 'button';
      closeButton.className = 'vcard-settings-dialog__command is-primary';
      closeButton.textContent = playerText.close;
      const settingsTitle = document.createElement('div');
      settingsTitle.className = 'vcard-settings-dialog__settings-title';
      const formatVcardDatetime = (value, pattern) => {
        const pad = (number) => String(number).padStart(2, '0');
        const source = String(pattern || '');
        const upperSource = source.toUpperCase();
        const monthsRu = [
          'ЯНВ', 'ФЕВ', 'МАР', 'АПР', 'МАЙ', 'ИЮН',
          'ИЮЛ', 'АВГ', 'СЕН', 'ОКТ', 'НОЯ', 'ДЕК'
        ];
        return source.replace(/YYYY|MMM|YY|DD|HH|MM|SS/gi, (token, offset) => {
          const key = token.toUpperCase();
          if (key === 'YYYY') return String(value.getFullYear());
          if (key === 'YY') return pad(value.getFullYear() % 100);
          if (key === 'MMM') return monthsRu[value.getMonth()];
          if (key === 'DD') return pad(value.getDate());
          if (key === 'HH') return pad(value.getHours());
          if (key === 'SS') return pad(value.getSeconds());
          const prefix = upperSource.slice(0, offset);
          const lastHour = prefix.lastIndexOf('HH');
          const lastDate = Math.max(
            prefix.lastIndexOf('DD'),
            prefix.lastIndexOf('YY')
          );
          return pad(lastHour > lastDate ? value.getMinutes() : value.getMonth() + 1);
        });
      };
      const expandVcardDatetime = (html) => {
        const configured = new Date(String(vcardUiConfig.vcardDatetime || ''));
        const modified = new Date(document.lastModified);
        const value = Number.isNaN(configured.getTime()) ? modified : configured;
        if (Number.isNaN(value.getTime())) return html;
        return html.replace(
          /%VCARDDT\(\s*["'“„«](.*?)["'”„“»]\s*\)%/gi,
          (macro, pattern) => formatVcardDatetime(value, pattern)
        );
      };
      const settingsTitleTemplate = expandVcardDatetime(String(
        vcardUiConfig.settingsTitleHtml || vcardUiConfig.settingsTitle || ''
      ))
        .trim()
        .replace(/(<(?:div|p|section)\b[^>]*>)[ \t]*\r?\n/gi, '$1')
        .replace(/\r?\n[ \t]*(<\/(?:div|p|section)>)/gi, '$1')
        .replace(/(<br\s*\/?>)[ \t]*\r?\n/gi, '$1');
      const withUnknownSettingsTrackValues = (html) => String(html || '')
        .replace(/%(?:SOUND|NOHASH_SOUND|MP3INFO)%/g, '?');
      settingsTitle.innerHTML = withUnknownSettingsTrackValues(settingsTitleTemplate);
      settingsTitle.hidden = !settingsTitle.textContent.trim();
      dialog.setAttribute(
        'aria-label',
        settingsTitle.textContent.trim() || 'Settings'
      );
      header.append(closeButton, settingsTitle);
      const content = document.createElement('div');
      content.className = 'vcard-settings-dialog__content';
      const settingsHtmlTemplate = String(
        vcardUiConfig.settingsHtml || vcardUiConfig.helpHtml || ''
      );
      content.innerHTML = settingsHtmlTemplate;
      const formatMediaBytes = (value) => {
        const bytes = Math.max(0, Number(value) || 0);
        if (bytes < 1024) return `${bytes} B`;
        const units = ['КБ', 'МБ', 'ГБ'];
        let amount = bytes / 1024;
        let unit = 0;
        while (amount >= 1024 && unit < units.length - 1) {
          amount /= 1024;
          unit += 1;
        }
        return `${amount.toFixed(amount >= 100 ? 0 : 1)} ${units[unit]}`;
      };
      const updateMediaCacheSummary = async () => {
        const summary = content.querySelector('[data-media-cache-summary]');
        const replaceMediaMacros = (values) => {
          const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
          const nodes = [];
          while (walker.nextNode()) nodes.push(walker.currentNode);
          nodes.forEach((node) => {
            let value = node.nodeValue;
            Object.entries(values).forEach(([macro, replacement]) => {
              value = value.replaceAll(macro, String(replacement));
            });
            node.nodeValue = value;
          });
        };
        const setSessionStat = (name, value) => {
          const item = content.querySelector(`[data-media-stat="${name}"]`);
          if (item) item.textContent = String(value);
        };
        const setManifestStat = (name, value) => {
          const item = content.querySelector(`[data-media-cache-total-${name}]`);
          if (item) item.textContent = String(value);
        };
        if (summary) summary.textContent = 'считаем…';
        try {
          const stats = await vcardMediaCache.getStats();
          const manifest = vcardMediaCache.manifestStats();
          if (summary) {
            summary.textContent = `${stats.cache.files} файлов = ${formatMediaBytes(stats.cache.bytes)}`;
          }
          setManifestStat('files', manifest.files);
          setManifestStat('size', formatMediaBytes(manifest.bytes));
          replaceMediaMacros({
            '%FILES_REQ%': stats.session.files,
            '%FILES_CACHED%': stats.session.cached,
            '%FILES_DL%': stats.session.downloaded,
          });
          setSessionStat('files-req', stats.session.files);
          setSessionStat('files-cached', stats.session.cached);
          setSessionStat('files-dl', stats.session.downloaded);
        } catch (_error) {
          if (summary) summary.textContent = 'данные недоступны';
          replaceMediaMacros({
            '%FILES_REQ%': '?',
            '%FILES_CACHED%': '?',
            '%FILES_DL%': '?',
          });
          setSessionStat('files-req', '?');
          setSessionStat('files-cached', '?');
          setSessionStat('files-dl', '?');
          setManifestStat('files', '?');
          setManifestStat('size', '?');
        }
      };
      panel.append(header, content);
      dialog.append(panel);
      document.body.append(dialog);

      let activeTrigger = null;
      let state = null;

      const fitSettingsTitle = () => {
        if (dialog.hidden || settingsTitle.hidden) return;
        settingsTitle.style.removeProperty('font-size');
        const initialSize = Number.parseFloat(getComputedStyle(settingsTitle).fontSize);
        if (!Number.isFinite(initialSize)) return;
        const minSize = 10;
        let size = initialSize;
        while (
          settingsTitle.scrollHeight > settingsTitle.clientHeight + 1
          && size > minSize
        ) {
          size = Math.max(minSize, size - 0.5);
          settingsTitle.style.fontSize = `${size}px`;
        }
      };

      const updateDialogTop = () => {
        const playerBottom = playerDock.getBoundingClientRect().bottom;
        const top = playerBottom > 0
          ? Math.min(window.innerHeight, playerBottom)
          : 0;
        dialog.style.setProperty('--vcard-settings-top', `${top}px`);
      };

      const updateDialogWidth = () => {
        const width = Math.round(playerDock.getBoundingClientRect().width);
        if (width > 0) dialog.style.setProperty('--vcard-settings-width', `${width}px`);
      };

      window.addEventListener('resize', () => {
        if (!dialog.hidden) {
          updateDialogTop();
          updateDialogWidth();
          requestAnimationFrame(fitSettingsTitle);
        }
      });

      const normalizeBackground = (value) => {
        const migrated = ({
          off: 'wallpaper',
          light: 'wallpaper',
          h: 'graph1',
          horizontal: 'graph1',
          v: 'graph2',
          vertical: 'graph2'
        })[value] || value;
        return ['wallpaper', 'graph1', 'graph2', 'smoke'].includes(migrated)
          ? migrated
          : 'smoke';
      };
      const normalizePortalView = (value) => {
        const migrated = ({ auto: 'duo', color: 'duo' })[value] || value;
        return ['auto', 'night', 'newspaper', 'mono', 'mono-inverse', 'duo', 'gray'].includes(migrated)
          ? migrated
          : 'auto';
      };
      const normalizeScale = (value) => ({
        '75%': 's',
        '100%': 'm',
        '125%': 'l',
        s: 's',
        m: 'm',
        l: 'l',
      })[String(value || '').toLowerCase()] || 'm';

      const readState = () => {
        const brightnessDefault = Number.parseInt(
          vcardCssDefault('visualization-brightness', '3'),
          10
        );
        const storedBrightness = Number.parseInt(
          localStorage.getItem('vcard-visualization-brightness'),
          10
        );
        const brightness = Number.isInteger(storedBrightness)
          ? Math.max(0, Math.min(5, storedBrightness))
          : Math.max(0, Math.min(5, brightnessDefault));
        const imagesVisible = vcardSettingEnabled('vcard-images-visible', 'images');
        return {
          background: normalizeBackground(
            localStorage.getItem('vcard-background-mode')
            || localStorage.getItem('vcard-visualization')
            || 'smoke'
          ),
          brightness: String(brightness),
          playlistAlternation,
          songAlternation,
          trackPlay: vcardSettingEnabled('vcard-trackplay', 'trackplay') ? 'on' : 'off',
          accent: vcardSettingEnabled('vcard-accent', 'accent') ? 'on' : 'off',
          colorScheme: vcardStoredSetting('vcard-color-scheme', 'color-scheme', 'black') === 'white'
            ? 'white'
            : 'black',
          monoColor: vcardSettingEnabled('vcard-mono-color', 'mono-color', 'off') ? 'on' : 'off',
          randomColor: vcardSettingEnabled(
            'vcard-random-color',
            'random-color',
            'on'
          ) ? 'on' : 'off',
          fontScale: normalizeScale(vcardStoredSetting('vcard-song-scale', 'font-size', '100%')),
          preset: localStorage.getItem('vcard-preset') || '',
        };
      };

      const renderState = () => {
        dialog.querySelectorAll('[sd-opt]').forEach((link) => {
          const key = link.getAttribute('sd-opt');
          if (key === 'mediaCache' || key === 'full-reset') {
            const loading = link.classList.contains('is-loading');
            link.classList.remove('is-selected');
            link.classList.toggle('is-disabled', loading);
            link.removeAttribute('aria-current');
            if (loading) link.setAttribute('aria-disabled', 'true');
            else link.removeAttribute('aria-disabled');
            return;
          }
          const monoForced = key === 'monoColor' && state && state.colorScheme === 'white';
          const randomColorUnavailable = (
            key === 'randomColor'
            && state
            && !['mono', 'duo'].includes(state.preset)
          );
          const fileVisualizationUnavailable = (
            vcardFileMode
            && key === 'background'
            && ['graph1', 'graph2'].includes(link.getAttribute('sd-val'))
          );
          const currentValue = monoForced ? 'on' : state && state[key];
          const backgroundGroup = key === 'background' || link.hasAttribute('data-background-off');
          const selected = backgroundGroup
            ? (link.hasAttribute('data-background-off')
              ? state?.brightness === '0'
              : state?.brightness !== '0' && currentValue === link.getAttribute('sd-val'))
            : currentValue === link.getAttribute('sd-val');
          const disabled = (
            (monoForced && link.getAttribute('sd-val') === 'off')
            || randomColorUnavailable
            || fileVisualizationUnavailable
          );
          link.classList.toggle('is-selected', selected);
          link.classList.toggle('is-disabled', disabled);
          link.setAttribute('aria-current', selected ? 'true' : 'false');
          link.setAttribute('aria-disabled', disabled ? 'true' : 'false');
        });
        dialog.querySelectorAll('[dd-preset]').forEach((link) => {
          const selected = Boolean(state) && state.preset === link.getAttribute('dd-preset');
          link.classList.toggle('is-selected', selected);
          link.setAttribute('aria-current', selected ? 'true' : 'false');
        });
      };

      const currentSettingsPreview = () => {
        const visibleList = listSections.find((section) => section.style.display !== 'none');
        return (
          activePreview
          || playingPreview
          || document.querySelector('.song__preview.is-visible')
          || (visibleList && visibleList.querySelector('.song__preview'))
          || previews[0]
          || null
        );
      };

      const updateDownloadLinks = () => {
        const preview = currentSettingsPreview();
        const source = preview ? resolveSource(preview) : '';
        content.querySelectorAll('[data-dialog-download]').forEach((link) => {
          link.hidden = !source;
          if (!source) {
            link.removeAttribute('href');
            link.removeAttribute('download');
            return;
          }
          link.href = new URL(source, document.baseURI).href;
          link.download = preview.dataset.downloadName || '';
        });
      };

      const updateSettingsTrackInfo = (preview) => {
        const fileName = String((preview && preview.dataset.downloadName) || '').trim();
        const fullInfo = String((preview && preview.dataset.downloadTitle) || '').trim();
        const fileInfo = fileName && fullInfo.startsWith(fileName)
          ? fullInfo.slice(fileName.length).trim()
          : fullInfo;
        const displayFileName = fileName || '?';
        const displayFileInfo = fileInfo || '?';
        const escapeHtml = (value) => String(value || '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
        content.innerHTML = settingsHtmlTemplate
          .replaceAll('%SOUND%', escapeHtml(displayFileName))
          .replaceAll('%NOHASH_SOUND%', escapeHtml(displayFileName))
          .replaceAll('%MP3INFO%', escapeHtml(displayFileInfo));
        updateMediaCacheSummary();
        settingsTitle.innerHTML = settingsTitleTemplate
          .replaceAll('%SOUND%', escapeHtml(displayFileName))
          .replaceAll('%NOHASH_SOUND%', escapeHtml(displayFileName))
          .replaceAll('%MP3INFO%', escapeHtml(displayFileInfo));
        dialog.querySelectorAll('[data-settings-mp3-name]').forEach((item) => {
          item.textContent = fileName;
          item.hidden = !fileName;
        });
        dialog.querySelectorAll('[data-settings-mp3-info]').forEach((item) => {
          item.textContent = fileInfo;
          item.hidden = !fileInfo;
        });
        settingsTitle.hidden = !settingsTitle.textContent.trim();
        dialog.setAttribute(
          'aria-label',
          settingsTitle.textContent.trim() || 'Settings'
        );
        requestAnimationFrame(fitSettingsTitle);
        if (state) renderState();
      };

      const closeDialog = () => {
        const trigger = activeTrigger;
        activeTrigger = null;
        state = null;
        dialog.hidden = true;
        document.documentElement.classList.remove('vcard-settings-dialog-open');
        triggers.forEach((item) => item.setAttribute('aria-expanded', 'false'));
        if (trigger) trigger.focus({ preventScroll: true });
      };

      const openDialog = (trigger) => {
        if (!dialog.hidden) {
          closeDialog();
          return;
        }
        activeTrigger = trigger;
        state = readState();
        updateSettingsTrackInfo(currentSettingsPreview());
        renderState();
        updateDownloadLinks();
        updateDialogWidth();
        updateDialogTop();
        dialog.hidden = false;
        document.documentElement.classList.add('vcard-settings-dialog-open');
        trigger.setAttribute('aria-expanded', 'true');
        requestAnimationFrame(() => {
          fitSettingsTitle();
          closeButton.focus({ preventScroll: true });
        });
      };

      const applySetting = (key, value) => {
        if (!state) return;
        const changesColorPreset = key === 'colorScheme' || key === 'monoColor';
        if (changesColorPreset) {
          state.preset = '';
          localStorage.setItem('vcard-preset', 'custom');
          document.dispatchEvent(new CustomEvent('vcard:preset-state', {
            detail: { key: '' }
          }));
        }
        state[key] = value;
        if (key === 'background') {
          if (state.brightness === '0') {
            state.brightness = '3';
            localStorage.setItem('vcard-visualization-brightness', '3');
            document.dispatchEvent(new CustomEvent('vcard:set-visualization-brightness', {
              detail: { level: 3 }
            }));
          }
          localStorage.setItem('vcard-background-mode', value);
          document.dispatchEvent(new CustomEvent('vcard:set-background', {
            detail: { mode: value, force: true }
          }));
        } else if (key === 'brightness') {
          localStorage.setItem('vcard-visualization-brightness', value);
          document.dispatchEvent(new CustomEvent('vcard:set-visualization-brightness', {
            detail: { level: Number(value) }
          }));
        } else if (key === 'trackPlay') {
          localStorage.setItem('vcard-trackplay', value);
          document.dispatchEvent(new CustomEvent('vcard:set-trackplay', {
            detail: { enabled: value === 'on' }
          }));
        } else if (key === 'playlistAlternation') {
          playlistAlternation = normalizePlaylistAlternation(value);
          state[key] = playlistAlternation;
          localStorage.setItem(PLAYLIST_ALTERNATION_STORAGE_KEY, playlistAlternation);
          cancelAutoAdvance();
        } else if (key === 'songAlternation') {
          songAlternation = normalizeSongAlternation(value);
          state[key] = songAlternation;
          localStorage.setItem(SONG_ALTERNATION_STORAGE_KEY, songAlternation);
          randomSongBags.clear();
          cancelAutoAdvance();
        } else if (key === 'randomColor') {
          localStorage.setItem('vcard-random-color', value);
        } else if (key === 'accent') {
          localStorage.setItem('vcard-accent', value);
          document.dispatchEvent(new CustomEvent('vcard:set-accent', {
            detail: { enabled: value === 'on' }
          }));
        } else if (key === 'colorScheme') {
          localStorage.setItem('vcard-color-scheme', value);
          document.dispatchEvent(new CustomEvent('vcard:set-color-scheme', {
            detail: { key: value }
          }));
        } else if (key === 'monoColor') {
          localStorage.setItem('vcard-mono-color', value);
          document.dispatchEvent(new CustomEvent('vcard:set-mono-color', {
            detail: { enabled: value === 'on' }
          }));
        } else if (key === 'fontScale') {
          localStorage.setItem('vcard-song-scale', value);
          document.dispatchEvent(new CustomEvent('vcard:set-font-scale', {
            detail: { key: value }
          }));
        }
        renderState();
      };

      const deleteIndexedDatabase = (name) => new Promise((resolve) => {
        const request = indexedDB.deleteDatabase(name);
        request.addEventListener('success', resolve, { once: true });
        request.addEventListener('error', resolve, { once: true });
        request.addEventListener('blocked', resolve, { once: true });
      });

      const fullReset = async () => {
        document.querySelectorAll('audio, video').forEach((media) => {
          try {
            media.pause();
          } catch (_) {}
        });

        const cleanupTasks = [];
        if ('serviceWorker' in navigator) {
          cleanupTasks.push(
            navigator.serviceWorker.getRegistrations()
              .then((registrations) => Promise.allSettled(
                registrations.map((registration) => registration.unregister())
              ))
          );
        }
        if ('caches' in window) {
          cleanupTasks.push(
            caches.keys()
              .then((names) => Promise.allSettled(names.map((name) => caches.delete(name))))
          );
        }
        if ('indexedDB' in window && typeof indexedDB.databases === 'function') {
          cleanupTasks.push(
            indexedDB.databases()
              .then((databases) => Promise.allSettled(
                databases
                  .map((database) => database.name)
                  .filter(Boolean)
                  .map(deleteIndexedDatabase)
              ))
          );
        }
        await Promise.allSettled(cleanupTasks);

        try {
          localStorage.clear();
        } catch (_) {}
        try {
          sessionStorage.clear();
        } catch (_) {}
        try {
          history.replaceState(null, document.title, window.location.href);
        } catch (_) {}
      };

      const closeAfterFullReset = () => {
        try {
          window.close();
        } catch (_) {}
        if (!window.closed) window.location.replace('about:blank');
      };

      localStorage.removeItem('vcard-auto-color');

      triggers.forEach((trigger) => {
        trigger.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          openDialog(trigger);
        }, true);
      });

      content.addEventListener('click', async (event) => {
        const link = event.target.closest('[sd-opt]');
        if (!link) return;
        event.preventDefault();
        if (link.getAttribute('sd-opt') === 'full-reset') {
          if (!window.confirm(
            'Сейчас буду сброшены все настройки сайта и закрыта страница, ОК?'
          )) return;
          link.classList.add('is-loading', 'is-disabled');
          link.setAttribute('aria-disabled', 'true');
          link.textContent = 'СБРАСЫВАЕМ…';
          await fullReset();
          closeAfterFullReset();
          return;
        }
        if (link.getAttribute('sd-opt') === 'mediaCache') {
          const mediaCacheAction = link.getAttribute('sd-val');
          if (mediaCacheAction === 'preload') {
            const initialMarkup = link.innerHTML;
            const renderProgress = (progressEvent) => {
              const progress = progressEvent.detail || {};
              link.textContent = `ПРОГРУЖАЕМ ${progress.completed || 0}/${progress.total || 0}`;
            };
            link.classList.add('is-loading', 'is-disabled');
            link.setAttribute('aria-disabled', 'true');
            document.addEventListener('vcard:media-cache-progress', renderProgress);
            vcardMediaCache.preloadAll()
              .catch(() => {})
              .finally(() => {
                document.removeEventListener('vcard:media-cache-progress', renderProgress);
                link.innerHTML = initialMarkup;
                link.classList.remove('is-loading', 'is-disabled');
                link.removeAttribute('aria-disabled');
                updateMediaCacheSummary();
              });
            return;
          }
          if (mediaCacheAction !== 'clear') return;
          link.setAttribute('aria-disabled', 'true');
          link.textContent = 'ОЧИЩАЕМ…';
          vcardMediaCache.clear()
            .catch(() => {})
            .finally(() => {
              link.textContent = 'ОЧИСТИТЬ';
              link.removeAttribute('aria-disabled');
              updateMediaCacheSummary();
            });
          return;
        }
        if (!state || link.getAttribute('aria-disabled') === 'true') return;
        applySetting(link.getAttribute('sd-opt'), link.getAttribute('sd-val'));
      });
      document.addEventListener('vcard:color-scheme-state', (event) => {
        if (!state) return;
        state.colorScheme = event.detail && event.detail.key === 'white' ? 'white' : 'black';
        renderState();
      });
      document.addEventListener('vcard:mono-color-state', (event) => {
        if (!state) return;
        state.monoColor = event.detail && event.detail.enabled ? 'on' : 'off';
        renderState();
      });
      document.addEventListener('vcard:preset-state', (event) => {
        if (!state) return;
        state.preset = String((event.detail && event.detail.key) || '');
        state = { ...state, ...readState(), preset: state.preset };
        renderState();
      });
      closeButton.addEventListener('click', closeDialog);
      document.addEventListener('vcard:mp3-info-change', (event) => {
        updateSettingsTrackInfo(currentSettingsPreview());
      });
      document.addEventListener('vcard:media-cache-change', () => {
        if (!dialog.hidden) updateMediaCacheSummary();
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !dialog.hidden) {
          event.preventDefault();
          closeDialog();
        }
      });
    })();

    document.querySelectorAll('.news-link').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        const targetListId = link.dataset.list || '';
        const targetSongId = link.dataset.song || '';
        if (!targetListId || !targetSongId) return;
        activateList(targetListId);
        const targetButton = buttons.find((button) => (
          button.dataset.list === targetListId && button.dataset.song === targetSongId
        ));
        if (targetButton) openSongButton(targetButton);
      });
    });
  })();

  (() => {
    const root = document.documentElement;

    const updateStickyAudioHeight = () => {
      const playerDock = document.querySelector('.vcard-player-dock');
      const player = playerDock && playerDock.querySelector('.plyr');
      if (!player || player.hidden || getComputedStyle(player).display === 'none') {
        root.style.setProperty('--song-sticky-audio-height', '0px');
        return;
      }

      const rect = playerDock.getBoundingClientRect();
      root.style.setProperty('--song-sticky-audio-height', `${rect.height}px`);
    };

    if ('ResizeObserver' in window) {
      const observer = new ResizeObserver(updateStickyAudioHeight);
      const playerDock = document.querySelector('.vcard-player-dock');
      if (playerDock) observer.observe(playerDock);
    }

    window.addEventListener('resize', updateStickyAudioHeight, { passive: true });
    document.addEventListener('click', () => requestAnimationFrame(updateStickyAudioHeight), true);
    requestAnimationFrame(updateStickyAudioHeight);
    setTimeout(updateStickyAudioHeight, 500);
  })();

  // Service Worker Registration
  if (location.protocol !== 'file:' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { });
  }

  // Email copy handler
  (() => {
    const email1 = 's.akp';
    const emailLink = document.getElementById('email-link');
    if (emailLink) {
      emailLink.addEventListener('click', (e) => {
        e.preventDefault();
        const email2 = 'es@gmail.com';
        const email = email0 + email1 + email2;
        navigator.clipboard.writeText(email).then(() => {
          alert('скопирован в буфер обмена');
        }).catch(() => {
          alert('Не удалось скопировать: ' + email);
        });
      });
    }
  })();
  (() => {
    const root = document.documentElement;
    const STORAGE_KEY = 'vcard-background-mode';
    const IMAGE_STORAGE_KEY = 'vcard-background-image';
    const imageListUrl = 'usr/v_bkimg/list.js';
    const videoListUrl = 'usr/v_bkvid/list.js';
    const modes = ['wallpaper', 'graph1', 'graph2', 'smoke'];
    const migrateMode = (value) => ({
      off: 'wallpaper',
      light: 'wallpaper',
      h: 'graph1',
      horizontal: 'graph1',
      v: 'graph2',
      vertical: 'graph2'
    })[value] || value;
    let backgroundMode = migrateMode(localStorage.getItem(STORAGE_KEY)) || migrateMode(localStorage.getItem('vcard-visualization')) || 'smoke';
    if (!modes.includes(backgroundMode)) backgroundMode = 'smoke';
    if (vcardFileMode && ['graph1', 'graph2'].includes(backgroundMode)) backgroundMode = 'wallpaper';
    let images = ['usr/v_bkimg/1.jpg', 'usr/v_bkimg/2.jpg', 'usr/v_bkimg/3.jpg'];
    let videos = ['usr/v_bkvid/smoke-loop.mp4'];
    let currentImageIndex = -1;
    let currentVideoIndex = -1;
    let backgroundIntensityOff = root.dataset.visBri === '0';
    let imageBag = [];
    let backgroundImageVersion = 0;
    let backgroundVideoVersion = 0;
    const video = document.createElement('video');
    video.className = 'vcard-page-background-video';
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.disablePictureInPicture = true;
    video.setAttribute('aria-hidden', 'true');
    video.hidden = true;
    document.body.prepend(video);

    const hideVideo = () => {
      backgroundVideoVersion += 1;
      freezeVCardVideo(video);
      video.hidden = true;
    };

    const showVideo = (source) => {
      const version = ++backgroundVideoVersion;
      root.dataset.pageBackgroundKind = 'image-video';
      video.playbackRate = vcardBackgroundPlaybackRate;
      if (backgroundIntensityOff) {
        freezeVCardVideo(video);
        video.hidden = true;
        return;
      }
      // A newly attached video paints a browser-default (often white) frame
      // before its first decoded image.  This is especially visible after
      // brightness 0, when the wallpaper layer is deliberately absent.
      const revealWhenReady = () => {
        if (version !== backgroundVideoVersion || backgroundIntensityOff) return;
        if (video.readyState < 2) return;
        video.hidden = false;
        playVCardAnimation(video, vcardBackgroundPlaybackRate);
      };
      video.hidden = true;
      if (video.src !== source) {
        video.src = source;
        video.load();
      }
      if (video.readyState >= 2) {
        revealWhenReady();
      } else {
        video.addEventListener('loadeddata', revealWhenReady, { once: true });
      }
    };

    const randomSource = (sources, currentIndex) => {
      const choices = sources
        .map((source, index) => ({ source, index }))
        .filter((item) => sources.length < 2 || item.index !== currentIndex);
      return choices[Math.floor(Math.random() * choices.length)] || null;
    };

    const refillImageBag = () => {
      imageBag = images.map((_source, index) => index);
      for (let index = imageBag.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [imageBag[index], imageBag[swapIndex]] = [imageBag[swapIndex], imageBag[index]];
      }
      if (imageBag.length > 1 && imageBag[0] === currentImageIndex) {
        const swapIndex = 1 + Math.floor(Math.random() * (imageBag.length - 1));
        [imageBag[0], imageBag[swapIndex]] = [imageBag[swapIndex], imageBag[0]];
      }
    };

    const nextImageSource = () => {
      if (!images.length) return null;
      if (!imageBag.length) refillImageBag();
      const index = imageBag.shift();
      return Number.isInteger(index) ? { source: images[index], index } : null;
    };

    const imageStorageName = (source) => {
      const sourceUrl = new URL(source, document.baseURI);
      const name = sourceUrl.pathname.split('/').filter(Boolean).pop() || '';
      try {
        return decodeURIComponent(name);
      } catch (_error) {
        return name;
      }
    };

    const showImage = (choice) => {
      if (!choice) return;
      currentImageIndex = choice.index;
      const sourceUrl = new URL(choice.source, document.baseURI);
      const source = sourceUrl.href;
      const version = ++backgroundImageVersion;
      const image = new Image();
      image.onload = () => {
        if (version !== backgroundImageVersion) return;
        root.dataset.pageBackgroundKind = 'image';
        const imageName = imageStorageName(source);
        root.dataset.pageBackgroundName = imageName || '—';
        root.dataset.pageBackgroundColor = sourceUrl.searchParams.get('vc-color') === '1'
          ? 'color'
          : 'mono';
        localStorage.setItem(IMAGE_STORAGE_KEY, imageName);
        root.style.setProperty('--vc-page-background-image', 'url("' + source + '")');
      };
      image.src = source;
    };

    const showRandomImage = () => {
      showImage(nextImageSource());
    };

    const restoreStoredImage = () => {
      const storedName = localStorage.getItem(IMAGE_STORAGE_KEY);
      if (!storedName) return false;
      const index = images.findIndex((source) => imageStorageName(source) === storedName);
      if (index < 0) return false;
      showImage({ source: images[index], index });
      return true;
    };

    const showRandomVideo = () => {
      const choice = randomSource(videos, currentVideoIndex);
      if (!choice) return;
      currentVideoIndex = choice.index;
      showVideo(new URL(choice.source, document.baseURI).href);
    };

    const applyBackgroundMode = (nextMode, randomize = false) => {
      if (vcardFileMode && ['graph1', 'graph2'].includes(nextMode)) nextMode = 'wallpaper';
      backgroundMode = modes.includes(nextMode) ? nextMode : 'wallpaper';
      localStorage.setItem(STORAGE_KEY, backgroundMode);
      root.dataset.backgroundMode = backgroundMode;
      if (currentImageIndex < 0 || (backgroundMode === 'wallpaper' && randomize)) {
        showRandomImage();
      }
      if (backgroundMode === 'smoke') {
        if (randomize || currentVideoIndex < 0) showRandomVideo();
        else playVCardAnimation(video, vcardBackgroundPlaybackRate);
      } else {
        hideVideo();
        root.dataset.pageBackgroundKind = 'image';
      }
      const visualizationMode = backgroundMode === 'graph1'
        ? 'h'
        : (backgroundMode === 'graph2' ? 'v' : 'off');
      document.dispatchEvent(new CustomEvent('vcard:set-visualization', {
        detail: { mode: visualizationMode, force: true }
      }));
      document.dispatchEvent(new CustomEvent('vcard:background-state', {
        detail: { mode: backgroundMode, videoEnabled: backgroundMode === 'smoke' }
      }));
    };

    document.addEventListener('vcard:set-background', (event) => {
      const requestedMode = event.detail && event.detail.mode;
      const forceMode = Boolean(event.detail && event.detail.force);
      applyBackgroundMode(requestedMode, forceMode);
    });
    document.addEventListener('vcard:request-background-state', () => {
      document.dispatchEvent(new CustomEvent('vcard:background-state', {
        detail: { mode: backgroundMode, videoEnabled: backgroundMode === 'smoke' }
      }));
    });
    document.addEventListener('vcard:visualization-state', (event) => {
      const brightnessLevel = Number(event.detail && event.detail.brightnessLevel);
      backgroundIntensityOff = brightnessLevel === 0;
      if (backgroundMode !== 'smoke') return;
      if (backgroundIntensityOff) {
        hideVideo();
        return;
      }
      if (currentVideoIndex >= 0 && videos[currentVideoIndex]) {
        showVideo(new URL(videos[currentVideoIndex], document.baseURI).href);
      } else {
        showRandomVideo();
      }
    });
    document.addEventListener('vcard:playlist-change', () => {
      showRandomImage();
      if (backgroundMode === 'smoke') showRandomVideo();
    });

    Promise.all([
      vcardMedia.loadList(imageListUrl).then((items) => {
        const supported = items.filter((item) => /\.(?:avif|gif|jpe?g|png|webp)(?:[?#].*)?$/i.test(item));
        if (supported.length) images = supported.map((item) => vcardMedia.listItemUrl(imageListUrl, item));
      }).catch((error) => console.warn(`VCard background: cannot load ${imageListUrl}`, error)),
      vcardMedia.loadList(videoListUrl).then((items) => {
        const supported = items.filter((item) => /\.(?:webm|mp4|ogv)(?:[?#].*)?$/i.test(item));
        if (supported.length) videos = supported.map((item) => vcardMedia.listItemUrl(videoListUrl, item));
      }).catch((error) => console.warn(`VCard background: cannot load ${videoListUrl}`, error)),
    ]).finally(() => {
      restoreStoredImage();
      applyBackgroundMode(backgroundMode, false);
    });
  })();
  (() => {
    const STORAGE_KEY = "vcard-color-scheme";
    const root = document.documentElement;
    const links = Array.from(document.querySelectorAll("[data-color-scheme]"));
    const defaultScheme = () => {
      const key = vcardCssDefault('color-scheme', 'black').toLowerCase();
      return key === 'white' ? 'white' : 'black';
    };

    function applyScheme(key) {
      if (key !== "black" && key !== "white") key = "white";

      root.dataset.colorScheme = key;
      localStorage.setItem(STORAGE_KEY, key);

      links.forEach((link) => {
        link.classList.toggle("is-active", link.dataset.colorScheme === key);
      });

      document.dispatchEvent(new CustomEvent("vcardcolorschemechange", {
        detail: { key }
      }));
      document.dispatchEvent(new CustomEvent("vcard:color-scheme-state", {
        detail: { key }
      }));
    }

    document.addEventListener("vcard:set-color-scheme", (event) => {
      applyScheme(event.detail && event.detail.key);
    });

    document.addEventListener("vcard:request-color-scheme-state", () => {
      document.dispatchEvent(new CustomEvent("vcard:color-scheme-state", {
        detail: {
          key: root.dataset.colorScheme
            || vcardStoredSetting(STORAGE_KEY, 'color-scheme', defaultScheme())
        }
      }));
    });

    links.forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        applyScheme(link.dataset.colorScheme);
      });
    });

    document.addEventListener("keydown", (event) => {
      if (!isVCardHotkey(event)) return;
      const key = event.key.toLowerCase();
      if (key !== "b" && key !== "w") return;
      event.preventDefault();
      applyScheme(key === "b" ? "black" : "white");
    });

    applyScheme(vcardStoredSetting(STORAGE_KEY, 'color-scheme', defaultScheme()));
  })();
  (() => {
    const root = document.documentElement;
    const MONO_COLOR_STORAGE_KEY = "vcard-mono-color";
    const ACCENT_STORAGE_KEY = "vcard-accent";
    const PRESET_STORAGE_KEY = "vcard-preset";
    let textColorValue = "white";
    let accColorValue = "white";
    let monoColorEnabled = vcardSettingEnabled(MONO_COLOR_STORAGE_KEY, 'mono-color', 'off');
    let accentEnabled = vcardSettingEnabled(ACCENT_STORAGE_KEY, 'accent');
    // Manual accent saturation adjustment: 100 keeps the palette unchanged,
    // lower values mute it, and values above 100 intensify it up to HSL 100%.
    const ACCENT_SATURATION_PERCENT = 100;
    const COLOR_PALETTE = Object.freeze([
      "#ffd400", // Yellow
      "#ff7f92", // Red
      "#859fec", // Blue
      "#ff8a00", // Orange
      "#a8ff00", // Lime
      "#00d9ff", // Cyan
      "#00e676", // Green
      "#ff59f4", // Magenta
      "#cbabff", // Violet
    ]);
    let pageColorBag = [];
    let duoThemeBag = [];
    let duoInitialPreview = null;
    const currentColorPreview = () => sharedSongAudio.vcardPlayingPreview || null;
    const recentAccentColors = [];
    const svgNamespace = "http://www.w3.org/2000/svg";
    const tintSvg = document.createElementNS(svgNamespace, "svg");
    const tintFilter = document.createElementNS(svgNamespace, "filter");
    const tintFlood = document.createElementNS(svgNamespace, "feFlood");
    const tintBlend = document.createElementNS(svgNamespace, "feBlend");
    const tintClip = document.createElementNS(svgNamespace, "feComposite");
    const emojiTintFilter = document.createElementNS(svgNamespace, "filter");
    const emojiTintGray = document.createElementNS(svgNamespace, "feColorMatrix");
    const emojiTintFlood = document.createElementNS(svgNamespace, "feFlood");
    const emojiTintBlend = document.createElementNS(svgNamespace, "feBlend");
    const emojiTintClip = document.createElementNS(svgNamespace, "feComposite");
    const songEmojiTintFilter = document.createElementNS(svgNamespace, "filter");
    const songEmojiTintGray = document.createElementNS(svgNamespace, "feColorMatrix");
    const songEmojiTintFlood = document.createElementNS(svgNamespace, "feFlood");
    const songEmojiTintBlend = document.createElementNS(svgNamespace, "feBlend");
    const songEmojiTintClip = document.createElementNS(svgNamespace, "feComposite");
    const videoTintFilter = document.createElementNS(svgNamespace, "filter");
    const videoTintGray = document.createElementNS(svgNamespace, "feColorMatrix");
    const videoTintFlood = document.createElementNS(svgNamespace, "feFlood");
    const videoTintBlend = document.createElementNS(svgNamespace, "feBlend");

    tintSvg.setAttribute("aria-hidden", "true");
    tintSvg.setAttribute("width", "0");
    tintSvg.setAttribute("height", "0");
    tintSvg.style.position = "absolute";
    tintFilter.id = "vc-text-tint";
    tintFilter.setAttribute("x", "0");
    tintFilter.setAttribute("y", "0");
    tintFilter.setAttribute("width", "100%");
    tintFilter.setAttribute("height", "100%");
    tintFilter.setAttribute("color-interpolation-filters", "sRGB");
    tintFlood.setAttribute("flood-color", "white");
    tintFlood.setAttribute("result", "text-color");
    tintBlend.setAttribute("in", "text-color");
    tintBlend.setAttribute("in2", "SourceGraphic");
    tintBlend.setAttribute("mode", "multiply");
    tintBlend.setAttribute("result", "tinted-image");
    tintClip.setAttribute("in", "tinted-image");
    tintClip.setAttribute("in2", "SourceAlpha");
    tintClip.setAttribute("operator", "in");
    tintFilter.append(tintFlood, tintBlend, tintClip);
    emojiTintFilter.id = "vc-emoji-tint";
    emojiTintFilter.setAttribute("x", "-25%");
    emojiTintFilter.setAttribute("y", "-25%");
    emojiTintFilter.setAttribute("width", "150%");
    emojiTintFilter.setAttribute("height", "150%");
    emojiTintFilter.setAttribute("color-interpolation-filters", "sRGB");
    emojiTintGray.setAttribute("in", "SourceGraphic");
    emojiTintGray.setAttribute("type", "saturate");
    emojiTintGray.setAttribute("values", "0");
    emojiTintGray.setAttribute("result", "emoji-gray");
    emojiTintFlood.setAttribute("flood-color", "white");
    emojiTintFlood.setAttribute("result", "emoji-color");
    emojiTintBlend.setAttribute("in", "emoji-color");
    emojiTintBlend.setAttribute("in2", "emoji-gray");
    emojiTintBlend.setAttribute("mode", "multiply");
    emojiTintBlend.setAttribute("result", "emoji-tinted");
    emojiTintClip.setAttribute("in", "emoji-tinted");
    emojiTintClip.setAttribute("in2", "SourceAlpha");
    emojiTintClip.setAttribute("operator", "in");
    emojiTintFilter.append(
      emojiTintGray,
      emojiTintFlood,
      emojiTintBlend,
      emojiTintClip
    );
    songEmojiTintFilter.id = "vc-song-emoji-tint";
    songEmojiTintFilter.setAttribute("x", "-25%");
    songEmojiTintFilter.setAttribute("y", "-25%");
    songEmojiTintFilter.setAttribute("width", "150%");
    songEmojiTintFilter.setAttribute("height", "150%");
    songEmojiTintFilter.setAttribute("color-interpolation-filters", "sRGB");
    songEmojiTintGray.setAttribute("in", "SourceGraphic");
    songEmojiTintGray.setAttribute("type", "saturate");
    songEmojiTintGray.setAttribute("values", "0");
    songEmojiTintGray.setAttribute("result", "song-emoji-gray");
    songEmojiTintFlood.setAttribute("flood-color", "white");
    songEmojiTintFlood.setAttribute("result", "song-emoji-color");
    songEmojiTintBlend.setAttribute("in", "song-emoji-color");
    songEmojiTintBlend.setAttribute("in2", "song-emoji-gray");
    songEmojiTintBlend.setAttribute("mode", "multiply");
    songEmojiTintBlend.setAttribute("result", "song-emoji-tinted");
    songEmojiTintClip.setAttribute("in", "song-emoji-tinted");
    songEmojiTintClip.setAttribute("in2", "SourceAlpha");
    songEmojiTintClip.setAttribute("operator", "in");
    songEmojiTintFilter.append(
      songEmojiTintGray,
      songEmojiTintFlood,
      songEmojiTintBlend,
      songEmojiTintClip
    );
    videoTintFilter.id = "vc-page-background-video-tint-filter";
    videoTintFilter.setAttribute("x", "0");
    videoTintFilter.setAttribute("y", "0");
    videoTintFilter.setAttribute("width", "100%");
    videoTintFilter.setAttribute("height", "100%");
    videoTintFilter.setAttribute("color-interpolation-filters", "sRGB");
    videoTintGray.setAttribute("in", "SourceGraphic");
    videoTintGray.setAttribute("type", "saturate");
    videoTintGray.setAttribute("values", "0");
    videoTintGray.setAttribute("result", "video-gray");
    videoTintFlood.setAttribute("flood-color", "white");
    videoTintFlood.setAttribute("result", "video-color");
    videoTintFlood.style.floodOpacity = "var(--vc-page-background-video-tint, 1)";
    videoTintBlend.setAttribute("in", "video-color");
    videoTintBlend.setAttribute("in2", "video-gray");
    videoTintBlend.setAttribute("mode", "multiply");
    videoTintFilter.append(videoTintGray, videoTintFlood, videoTintBlend);
    tintSvg.append(tintFilter, emojiTintFilter, songEmojiTintFilter, videoTintFilter);
    document.body.append(tintSvg);

    function isBlackScheme() {
      return root.dataset.colorScheme === "black";
    }

    function effectiveTextColor() {
      return isBlackScheme() ? textColorValue : "black";
    }

    const linearRgbChannel = (channel) => (
      channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4
    );

    const rgbRelativeLuminance = (red, green, blue) => (
      0.2126 * linearRgbChannel(red)
      + 0.7152 * linearRgbChannel(green)
      + 0.0722 * linearRgbChannel(blue)
    );

    const shuffledPalette = () => {
      const colors = [...COLOR_PALETTE];
      for (let index = colors.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [colors[index], colors[swapIndex]] = [colors[swapIndex], colors[index]];
      }
      return colors;
    };

    const hexChannels = (color) => {
      const match = /^#([0-9a-f]{6})$/i.exec(String(color || '').trim());
      if (!match) return [255, 255, 255];
      return [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16));
    };

    const colorHue = (color) => {
      const [redByte, greenByte, blueByte] = hexChannels(color);
      const red = redByte / 255;
      const green = greenByte / 255;
      const blue = blueByte / 255;
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      const delta = maximum - minimum;
      if (!delta) return 0;
      let hue;
      if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
      else if (maximum === green) hue = 60 * (((blue - red) / delta) + 2);
      else hue = 60 * (((red - green) / delta) + 4);
      return (hue + 360) % 360;
    };

    const withAccentSaturation = (color) => {
      const factor = Math.max(0, ACCENT_SATURATION_PERCENT) / 100;
      if (factor === 1) return color;
      const [redByte, greenByte, blueByte] = hexChannels(color);
      const red = redByte / 255;
      const green = greenByte / 255;
      const blue = blueByte / 255;
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      const delta = maximum - minimum;
      const lightness = (maximum + minimum) / 2;
      if (!delta) return color;

      const saturation = delta / (1 - Math.abs(2 * lightness - 1));
      const adjustedSaturation = Math.min(1, saturation * factor);
      const hue = colorHue(color);
      const chroma = (1 - Math.abs(2 * lightness - 1)) * adjustedSaturation;
      const segment = hue / 60;
      const secondary = chroma * (1 - Math.abs((segment % 2) - 1));
      const [redPart, greenPart, bluePart] = (
        segment < 1 ? [chroma, secondary, 0]
          : segment < 2 ? [secondary, chroma, 0]
            : segment < 3 ? [0, chroma, secondary]
              : segment < 4 ? [0, secondary, chroma]
                : segment < 5 ? [secondary, 0, chroma]
                  : [chroma, 0, secondary]
      );
      const match = lightness - chroma / 2;
      const toHex = (channel) => Math.round((channel + match) * 255)
        .toString(16)
        .padStart(2, '0');
      return `#${toHex(redPart)}${toHex(greenPart)}${toHex(bluePart)}`;
    };

    const colorLuminance = (color) => {
      const [red, green, blue] = hexChannels(color);
      return rgbRelativeLuminance(red / 255, green / 255, blue / 255);
    };

    const accentContrastScore = (pageColor, accentColor) => {
      const hueDistance = Math.abs(colorHue(pageColor) - colorHue(accentColor));
      const spectralDistance = Math.min(hueDistance, 360 - hueDistance) / 180;
      const luminanceDistance = Math.abs(
        colorLuminance(pageColor) - colorLuminance(accentColor)
      );
      return spectralDistance * 4 + luminanceDistance;
    };

    const accentForPage = (page) => {
      const recent = new Set(recentAccentColors);
      let candidates = COLOR_PALETTE.filter((color) => color !== page && !recent.has(color));
      if (!candidates.length) candidates = COLOR_PALETTE.filter((color) => color !== page);
      const accent = candidates.reduce((best, color) => (
        !best || accentContrastScore(page, color) > accentContrastScore(page, best)
          ? color
          : best
      ), '');
      recentAccentColors.push(accent);
      if (recentAccentColors.length > 2) recentAccentColors.shift();
      return accent;
    };

    const nextPalettePair = () => {
      if (!pageColorBag.length) pageColorBag = shuffledPalette();
      const page = pageColorBag.pop();
      return { page, accent: accentForPage(page) };
    };

    const nextDuoPair = () => {
      if (!duoThemeBag.length) {
        duoThemeBag = shuffledPalette().map((page) => ({
          page,
          accent: accentForPage(page),
        }));
      }
      return duoThemeBag.shift();
    };

    function syncAccColor() {
      const color = !isBlackScheme()
        ? effectiveTextColor()
        : (accentEnabled ? withAccentSaturation(accColorValue) : effectiveTextColor());
      root.dataset.accent = accentEnabled ? 'on' : 'off';
      root.style.setProperty("--vc-acc", color);
      document.dispatchEvent(new CustomEvent("vcardacccolorchange", {
        detail: { color }
      }));
    }

    function setAccent(enabled, { persist = true } = {}) {
      accentEnabled = Boolean(enabled);
      if (persist) {
        localStorage.setItem(ACCENT_STORAGE_KEY, accentEnabled ? "on" : "off");
      }
      syncAccColor();
      document.dispatchEvent(new CustomEvent("vcard:accent-state", {
        detail: { enabled: accentEnabled }
      }));
    }

    document.addEventListener("vcard:set-accent", (event) => {
      setAccent(Boolean(event.detail && event.detail.enabled));
    });


    function setMonoColor(enabled, { persist = true } = {}) {
      monoColorEnabled = Boolean(enabled);
      if (persist) {
        localStorage.setItem(MONO_COLOR_STORAGE_KEY, monoColorEnabled ? "on" : "off");
      }
      const monoActive = !isBlackScheme() || monoColorEnabled;
      syncAccColor();
      document.dispatchEvent(new CustomEvent("vcard:mono-color-state", {
        detail: { enabled: monoActive }
      }));
    }

    function setTextColor(color) {
      textColorValue = color;
      const effectiveColor = effectiveTextColor();
      root.style.setProperty("--vc-page", effectiveColor);
      root.dataset.authorCommentMuted = isBlackScheme() ? 'on' : 'off';
      tintFlood.setAttribute("flood-color", effectiveColor);
      const mutedColor = getComputedStyle(document.body).color || effectiveColor;
      emojiTintFlood.setAttribute("flood-color", mutedColor);
      songEmojiTintFlood.setAttribute("flood-color", effectiveColor);
      videoTintFlood.setAttribute("flood-color", effectiveColor);
      document.dispatchEvent(new CustomEvent("vcardtextcolorchange", {
        detail: { color: effectiveColor }
      }));
      syncAccColor();
    }

    function setPalette(text) {
      textColorValue = text;
      setTextColor(text);
    }

    function setPalettePair(page, accent) {
      textColorValue = page;
      accColorValue = accent;
      setTextColor(page);
    }

    function refreshPalette() {
      if (!isBlackScheme()) {
        setPalettePair("black", "black");
      } else {
        const pair = nextPalettePair();
        setPalettePair(pair.page, pair.accent);
      }
    }

    function publishPreset(key) {
      if (key) {
        root.dataset.colorPreset = key;
      } else {
        delete root.dataset.colorPreset;
      }
      document.querySelectorAll("[dd-preset]").forEach((link) => {
        const selected = Boolean(key) && link.getAttribute("dd-preset") === key;
        link.classList.toggle("is-selected", selected);
        link.setAttribute("aria-current", selected ? "true" : "false");
      });
      document.dispatchEvent(new CustomEvent("vcard:preset-state", {
        detail: { key }
      }));
    }

    function markCustomPreset() {
      localStorage.setItem(PRESET_STORAGE_KEY, "custom");
      publishPreset("");
    }

    function applyPreset(key, { randomizeDuo = false } = {}) {
      if (!['night', 'mono', 'duo', 'newspaper'].includes(key)) return;

      const cycleActiveDuo = key === 'duo' && root.dataset.colorPreset === 'duo';
      const useRandomDuo = randomizeDuo || cycleActiveDuo;
      localStorage.setItem(PRESET_STORAGE_KEY, key);
      document.documentElement.style.removeProperty("--vc-win");
      localStorage.removeItem("vcard-win-color");
      delete root.dataset.duoGray;
      if (key !== 'duo') duoInitialPreview = null;
      if (key === 'newspaper') {
        document.dispatchEvent(new CustomEvent("vcard:set-color-scheme", {
          detail: { key: "white" }
        }));
        setMonoColor(true);
        setPalettePair("black", "black");
        setAccent(false);
      } else if (key === 'mono') {
        const tone = nextPalettePair().page;
        document.dispatchEvent(new CustomEvent("vcard:set-color-scheme", {
          detail: { key: "black" }
        }));
        setMonoColor(true);
        setPalettePair(tone, tone);
        setAccent(false);
      } else if (key === 'duo') {
        const pair = useRandomDuo
          ? nextDuoPair()
          : { page: '#c0c0c0', accent: '#ffd400' };
        root.dataset.duoGray = useRandomDuo ? 'off' : 'on';
        if (!useRandomDuo) duoInitialPreview = currentColorPreview();
        document.dispatchEvent(new CustomEvent("vcard:set-color-scheme", {
          detail: { key: "black" }
        }));
        setMonoColor(true);
        setPalettePair(pair.page, pair.accent);
        setAccent(true);
      } else {
        document.dispatchEvent(new CustomEvent("vcard:set-color-scheme", {
          detail: { key: "black" }
        }));
        setMonoColor(false);
        const nightAccent = getComputedStyle(root)
          .getPropertyValue("--vc-night-accent")
          .trim() || "#ffd400";
        setPalettePair("white", nightAccent);
        setAccent(true);
      }
      publishPreset(key);
    }

    document.addEventListener("vcardcolorschemechange", () => {
      if (
        isBlackScheme()
        && textColorValue === "black"
      ) {
        textColorValue = "white";
        accColorValue = getComputedStyle(root)
          .getPropertyValue("--vc-night-accent")
          .trim() || "#ffd400";
      }
      setTextColor(textColorValue);
    });

    document.addEventListener("vcard:set-mono-color", (event) => {
      const enabled = Boolean(event.detail && event.detail.enabled);
      setMonoColor(enabled);
      if (!enabled) refreshPalette();
      markCustomPreset();
    });

    document.addEventListener("click", (event) => {
      const preset = event.target.closest("[dd-preset]");
      if (preset) {
        event.preventDefault();
        applyPreset(preset.getAttribute("dd-preset"));
        return;
      }


      if (event.target.closest("[data-color-scheme]")) return;
    });

    document.addEventListener('vcard:apply-preset', (event) => {
      applyPreset(event.detail && event.detail.preset);
    });

    document.addEventListener('vcard:song-start', (event) => {
      const currentPreview = (event.detail && event.detail.preview) || currentColorPreview();
      if (!currentPreview) return;
      if (!vcardSettingEnabled('vcard-random-color', 'random-color', 'on')) return;
      const preset = localStorage.getItem(PRESET_STORAGE_KEY);
      if (!['mono', 'duo'].includes(preset)) return;
      if (preset === 'duo' && root.dataset.duoGray === 'on') {
        if (!duoInitialPreview) {
          duoInitialPreview = currentPreview;
          return;
        }
        if (currentPreview === duoInitialPreview) return;
      }
      applyPreset(preset, { randomizeDuo: preset === 'duo' });
    });

    localStorage.removeItem("vcard-auto-color");
    localStorage.removeItem("vcard-win-color");
    vcardMedia.refresh();
    const storedPreset = localStorage.getItem(PRESET_STORAGE_KEY);
    const initialPreset = ['night', 'mono', 'duo', 'newspaper'].includes(storedPreset)
      ? storedPreset
      : 'duo';
    applyPreset(initialPreset);
    root.dataset.paletteReady = "on";
  })();
  (() => {
    const STORAGE_KEY = "vcard-song-scale";

    const fontSizes = {
      xs: "12px",
      s: "16px",
      m: "20px",
      l: "24px",
      xl: "28px"
    };

    const root = document.documentElement;
    const links = Array.from(document.querySelectorAll("[data-song-scale]"));
    const normalizeScale = (value) => ({
      '75%': 's',
      '100%': 'm',
      '125%': 'l',
      xs: 'xs',
      s: 's',
      m: 'm',
      l: 'l',
      xl: 'xl',
    })[String(value || '').toLowerCase()] || 'm';
    const storedScale = () => normalizeScale(vcardStoredSetting(
      STORAGE_KEY,
      'font-size',
      '100%'
    ));

    function applyScale(key) {
      if (!fontSizes[key]) key = "m";

      root.style.setProperty("--font-size", fontSizes[key]);
      localStorage.setItem(STORAGE_KEY, key);

      links.forEach((link) => {
        link.classList.toggle("is-active", link.dataset.songScale === key);
      });
      document.dispatchEvent(new CustomEvent("vcard:font-scale-state", {
        detail: { key }
      }));
    }

    document.addEventListener("vcard:set-font-scale", (event) => {
      applyScale(event.detail && event.detail.key);
    });

    document.addEventListener("vcard:request-font-scale-state", () => {
      document.dispatchEvent(new CustomEvent("vcard:font-scale-state", {
        detail: { key: storedScale() }
      }));
    });

    links.forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        applyScale(link.dataset.songScale);
      });
    });

    document.addEventListener("keydown", (event) => {
      if (!isVCardHotkey(event)) return;
      const key = event.key.toLowerCase();
      if (!fontSizes[key]) return;
      event.preventDefault();
      applyScale(key);
    });

    applyScale(storedScale());
  })();
