const HARRY_POTTER_BOOK_PATTERN = /^[1-7] HARRY POTTER (?:AND|ANND) .+$/i;
const TICKS_PER_SECOND = 10_000_000;

export function normalizeServerUrl(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error('Jellyfin server URL must be a valid HTTP(S) URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Jellyfin server URL must use HTTPS');
  }
  if (!url.hostname || url.origin === 'null') throw new Error('Jellyfin server URL must have a network origin');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Jellyfin server URL must not contain credentials, a base path, query parameters or a fragment');
  }
  return url.href.replace(/\/$/, '');
}

const quoteHeaderValue = value => {
  const text = String(value ?? '');
  if (!text || /[\r\n\0]/.test(text)) throw new Error('Invalid MediaBrowser header value');
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};

export function buildMediaBrowserHeader({ client, device, deviceId, version, userId, token }) {
  if (!token || !userId) throw new Error('Jellyfin user and access token are required');
  const fields = [
    ['Client', client], ['Device', device], ['DeviceId', deviceId], ['Version', version],
    ['UserId', userId], ['Token', token],
  ];
  return `MediaBrowser ${fields.map(([key, value]) => `${key}=${quoteHeaderValue(value)}`).join(', ')}`;
}

export function buildApiUrl(serverUrl, path, params = {}) {
  const base = normalizeServerUrl(serverUrl);
  if (!String(path).startsWith('/') || String(path).startsWith('//')) throw new Error('Jellyfin API path must stay on the configured server');
  const url = new URL(`${base}${path}`);
  if(url.origin !== new URL(base).origin || url.pathname !== path) throw new Error('Jellyfin API path must stay on the configured server');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.href;
}

export function findAudiobooksLibrary(views) {
  return (Array.isArray(views) ? views : []).find(view =>
    view?.Name === 'Audiobooks' && view?.Type === 'CollectionFolder' && view?.CollectionType === 'books'
  ) ?? null;
}

export function isHarryPotterBookFolder(name) {
  return HARRY_POTTER_BOOK_PATTERN.test(String(name ?? '').trim());
}

function chapterNumber(path) {
  const match = String(path ?? '').split('/').at(-1)?.match(/^CH(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

export function genericNormalizeChapters(items) {
  const chapters = (Array.isArray(items) ? items : [])
    .filter(item => item?.Type === 'AudioBook' && typeof item.Id === 'string' && item.Id)
    .map((item, index) => ({
      id: item.Id,
      title: String(item.Name ?? ''),
      path: String(item.Path ?? ''),
      chapterNumber: chapterNumber(item.Path) || item.IndexNumber || (index + 1),
      runTimeTicks: Number.isFinite(Number(item.RunTimeTicks)) ? Number(item.RunTimeTicks) : 0,
      positionTicks: Number.isFinite(Number(item.UserData?.PlaybackPositionTicks))
        ? Number(item.UserData.PlaybackPositionTicks) : 0,
      played: item.UserData?.Played === true,
      lastPlayedDate: typeof item.UserData?.LastPlayedDate === 'string' ? item.UserData.LastPlayedDate : '',
      mediaSourceId: item.MediaSources?.[0]?.Id ?? item.Id,
      container: item.MediaSources?.[0]?.Container ?? '',
    }))
    .sort((a, b) => a.chapterNumber - b.chapterNumber || a.path.localeCompare(b.path));
  return { chapters, missingChapterNumbers: [], duplicateChapterNumbers: [] };
}

export function normalizeChapters(items, bookFolderName) {
  if (!isHarryPotterBookFolder(bookFolderName)) {
    return genericNormalizeChapters(items);
  }
  const chapters = (Array.isArray(items) ? items : [])
    .filter(item => item?.Type === 'AudioBook' && typeof item.Id === 'string' && item.Id)
    .filter(item => String(item.Path ?? '').split('/').slice(-2, -1)[0] === bookFolderName)
    .map(item => ({
      id: item.Id,
      title: String(item.Name ?? ''),
      path: String(item.Path ?? ''),
      chapterNumber: chapterNumber(item.Path),
      runTimeTicks: Number.isFinite(Number(item.RunTimeTicks)) ? Number(item.RunTimeTicks) : 0,
      positionTicks: Number.isFinite(Number(item.UserData?.PlaybackPositionTicks))
        ? Number(item.UserData.PlaybackPositionTicks) : 0,
      played: item.UserData?.Played === true,
      lastPlayedDate: typeof item.UserData?.LastPlayedDate === 'string' ? item.UserData.LastPlayedDate : '',
      mediaSourceId: item.MediaSources?.[0]?.Id ?? item.Id,
      container: item.MediaSources?.[0]?.Container ?? '',
    }))
    .filter(chapter => Number.isInteger(chapter.chapterNumber) && chapter.chapterNumber > 0)
    .sort((a, b) => a.chapterNumber - b.chapterNumber || a.path.localeCompare(b.path));

  const counts = new Map();
  for (const chapter of chapters) counts.set(chapter.chapterNumber, (counts.get(chapter.chapterNumber) ?? 0) + 1);
  const maxChapter = chapters.at(-1)?.chapterNumber ?? 0;
  const missingChapterNumbers = Array.from({ length: maxChapter }, (_, index) => index + 1)
    .filter(number => !counts.has(number));
  const duplicateChapterNumbers = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([number]) => number);
  return { chapters, missingChapterNumbers, duplicateChapterNumbers };
}

export function ticksToSeconds(ticks) {
  if (ticks === null || ticks === undefined || ticks === '') return null;
  const value = Number(ticks);
  if (!Number.isFinite(value) || value < 0) return null;
  return value / TICKS_PER_SECOND;
}

export function secondsToTicks(seconds) {
  if (seconds === null || seconds === undefined || seconds === '') return null;
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * TICKS_PER_SECOND);
}

export function nextChapter(chapters, currentId) {
  if (!Array.isArray(chapters)) return null;
  const index = chapters.findIndex(chapter => chapter.id === currentId);
  if(index < 0 || index + 1 >= chapters.length) return null;
  const current = chapters[index], next = chapters[index + 1];
  return next.chapterNumber === current.chapterNumber + 1 ? next : null;
}

export function buildStreamUrl(serverUrl, itemId, mediaSourceId = itemId) {
  if (!itemId || !mediaSourceId || /[\\/?#]/.test(String(itemId)) || /[\r\n\0]/.test(String(mediaSourceId))) throw new Error('Jellyfin item and media source IDs are required');
  const url = new URL(`${normalizeServerUrl(serverUrl)}/Audio/${encodeURIComponent(itemId)}/stream`);
  url.searchParams.set('static', 'true');
  url.searchParams.set('mediaSourceId', mediaSourceId);
  return url.href;
}

export function buildPlaybackReport({
  itemId, mediaSourceId, playSessionId, positionSeconds, isPaused,
  playMethod = 'DirectPlay', volumeLevel = 100,
}) {
  if (!itemId || !mediaSourceId) throw new Error('Playback report requires item and media source IDs');
  if (!playSessionId) throw new Error('Playback report requires the real PlaySessionId from PlaybackInfo');
  const report = {
    ItemId: itemId,
    MediaSourceId: mediaSourceId,
    PlaySessionId: playSessionId,
    IsPaused: Boolean(isPaused),
    PlayMethod: playMethod,
    CanSeek: true,
    VolumeLevel: volumeLevel,
    RepeatMode: 'RepeatNone',
    PlaybackOrder: 'Default',
  };
  const positionTicks = secondsToTicks(positionSeconds);
  if (positionTicks !== null) report.PositionTicks = positionTicks;
  return report;
}

function parseJsonResponse(text, status) {
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { throw new Error(`Jellyfin returned invalid JSON (HTTP ${status})`); }
}

const jellyfinHttpError = status => {
  if(status === 401 || status === 403) return new Error('Jellyfin sign-in expired or this account lacks access');
  if(status === 404) return new Error('Jellyfin item was not found');
  return new Error(`Jellyfin request failed (HTTP ${status})`);
};

const jellyfinNetworkError = () => new Error(
  "Couldn't read a response from Jellyfin. Check the server URL and network, and allow https://jalamb5.github.io in Jellyfin's CORS settings."
);

function requireSuccess(response) {
  if(!response.ok) throw jellyfinHttpError(response.status);
  return response;
}

export class JellyfinClient {
  constructor({ serverUrl, userId, accessToken, deviceId, fetchImpl = fetch }) {
    this.serverUrl = normalizeServerUrl(serverUrl);
    this.userId = userId;
    this.accessToken = accessToken;
    this.deviceId = deviceId;
    this.fetchImpl = (...args) => fetchImpl(...args);
  }

  static async checkServer({ serverUrl, fetchImpl = fetch }) {
    const base = normalizeServerUrl(serverUrl);
    try {
      const response = await fetchImpl(`${base}/System/Info/Public`, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return true;
    } catch {
      throw new Error("Could not read Jellyfin's public server status. Check the URL, network, and server CORS settings.");
    }
  }

  static async authenticate({ serverUrl, username, password, deviceId, fetchImpl = fetch }) {
    const base = normalizeServerUrl(serverUrl);
    if (!String(username ?? '').trim()) throw new Error('Enter your Jellyfin username');
    if (typeof password !== 'string' || password.length === 0) throw new Error('Enter your Jellyfin password');
    const authHeader = `MediaBrowser ${[
      `Client=${quoteHeaderValue('Caster')}`,
      `Device=${quoteHeaderValue('Web browser')}`,
      `DeviceId=${quoteHeaderValue(deviceId)}`,
      `Version=${quoteHeaderValue('0.1')}`,
    ].join(', ')}`;
    let response;
    try {
      response = await fetchImpl(buildApiUrl(base, '/Users/AuthenticateByName'), {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ Username: username, Pw: password }),
      });
    } catch {
      throw jellyfinNetworkError();
    }
    if (!response.ok) throw response.status === 401 ? new Error('Jellyfin sign-in failed') : jellyfinHttpError(response.status);
    let result;
    try { result = parseJsonResponse(await response.text(), response.status); }
    catch { throw new Error('Jellyfin returned an invalid sign-in response'); }
    if (!result.User?.Id || !result.AccessToken) throw new Error('Jellyfin sign-in response is missing the user or access token');
    return new JellyfinClient({ serverUrl: base, userId: result.User.Id, accessToken: result.AccessToken, deviceId, fetchImpl });
  }

  authHeaders(extra = {}) {
    return {
      ...extra,
      Authorization: buildMediaBrowserHeader({
        client: 'Caster', device: 'Web browser', deviceId: this.deviceId, version: '0.1',
        userId: this.userId, token: this.accessToken,
      }),
    };
  }

  async request(path, { method = 'GET', params = {}, body, headers = {} } = {}) {
    if (!String(path).startsWith('/') || String(path).startsWith('//') || String(path).includes('\\') || /%2f|%5c/i.test(String(path))) throw new Error('Jellyfin API path must stay on the configured server');
    let response;
    try {
      response = await this.fetchImpl(buildApiUrl(this.serverUrl, path, { userId: this.userId, ...params }), {
        method,
        headers: this.authHeaders({ Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw jellyfinNetworkError();
    }
    requireSuccess(response);
    const text = await response.text();
    return parseJsonResponse(text, response.status);
  }

  async getHarryPotterBooks() {
    // Retained for backward compatibility — uses generic browsing underneath
    const { libraryId } = await this.getAudiobooksCatalogue();
    const roots = await this.getFolderItems(libraryId);
    for (const candidate of roots.Items ?? []) {
      if(candidate?.Type !== 'Folder' || !candidate.Id) continue;
      const children = await this.getFolderItems(candidate.Id);
      const numbered = (children.Items ?? [])
        .filter(item => item.Type === 'Folder' && isHarryPotterBookFolder(item.Name))
        .sort((a, b) => Number(a.Name[0]) - Number(b.Name[0]));
      if (numbered.length === 7 && numbered.every((folder,index) => Number(folder.Name[0]) === index+1)) {
        const books = [];
        for (const folder of numbered) {
          const chResult = await this.getFolderItems(folder.Id);
          const normalized = normalizeChapters(chResult.Items, folder.Name);
          if (!normalized.chapters.length) throw new Error(`No playable chapters found for ${folder.Name}`);
          books.push({
            id: folder.Id,
            title: folder.Name.replace(/^\d\s+/, '').replace(/\bANND\b/i, 'AND'),
            chapters: normalized.chapters,
            missingChapterNumbers: normalized.missingChapterNumbers,
            duplicateChapterNumbers: normalized.duplicateChapterNumbers,
          });
        }
        return { rootId: candidate.Id, books };
      }
    }
    throw new Error('Could not identify a Harry Potter series folder in the Audiobooks library');
  }

  async getAudiobooksCatalogue() {
    const views = await this.request('/UserViews');
    const library = findAudiobooksLibrary(views.Items);
    if (!library?.Id) throw new Error('Audiobooks library was not found');
    return { libraryId: library.Id, libraryName: library.Name };
  }

  async getFolderItems(folderId) {
    return this.request('/Items', {
      params: { ParentId: folderId, Recursive: false, Fields: 'Path,MediaSources,RunTimeTicks,UserData', Limit: 1000 },
    });
  }

  getPlaybackInfo(chapter) {
    return this.request(`/Items/${encodeURIComponent(chapter.id)}/PlaybackInfo`, {
      method: 'POST',
      params: { IsPlayback: true, AutoOpenLiveStream: false },
      body: { UserId: this.userId, IsPlayback: true, AutoOpenLiveStream: false },
    });
  }

  reportStarted(chapter, session) {
    if(!chapter?.id || !session?.playSessionId || !session?.mediaSourceId) return Promise.reject(new Error('Cannot report playback started without real PlaybackInfo session details'));
    return this.request('/Sessions/Playing', {
      method: 'POST',
      body: {
        ItemId: chapter.id,
        MediaSourceId: session.mediaSourceId,
        PlaySessionId: session.playSessionId,
        ...(Number.isFinite(Number(chapter.positionTicks)) && Number(chapter.positionTicks)>0 ? {PositionTicks:Number(chapter.positionTicks)} : {}),
        IsPaused: false,
        PlayMethod: 'DirectPlay',
        CanSeek: true,
        RepeatMode: 'RepeatNone',
        PlaybackOrder: 'Default',
      },
    });
  }

  reportProgress(chapter, session, positionSeconds, isPaused) {
    return this.request('/Sessions/Playing/Progress', {
      method: 'POST',
      body: buildPlaybackReport({
        itemId: chapter.id, mediaSourceId: session.mediaSourceId,
        playSessionId: session.playSessionId, positionSeconds, isPaused,
      }),
    });
  }

  reportStopped(chapter, session, positionSeconds) {
    if (!chapter?.id || !session?.playSessionId || !session?.mediaSourceId) {
      return Promise.reject(new Error('Cannot report playback stopped without real PlaybackInfo session details'));
    }
    const body = {
      ItemId: chapter.id,
      MediaSourceId: session.mediaSourceId,
      PlaySessionId: session.playSessionId,
    };
    const positionTicks = secondsToTicks(positionSeconds);
    if (positionTicks !== null) body.PositionTicks = positionTicks;
    return this.request('/Sessions/Playing/Stopped', { method: 'POST', body });
  }
}

export function createDeviceId() {
  return globalThis.crypto?.randomUUID?.() ?? `caster-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

