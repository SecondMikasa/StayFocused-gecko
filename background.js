// ============================================================
// Stay Focused – Background Script
// Storage is the single source of truth. On every startup we
// read browser.storage.local and configure the extension from
// there. In-memory objects are only a cache – storage wins.
// ============================================================

const DEFAULT_SETTINGS = {
    focusTime:    25,
    breakTime:     5,
    longBreakTime: 15,
    sessionsCount:  4,
    autoStart:  false,
    blockingMode: 'focus-only',   // 'focus-only' | 'always'
    overrideTime:   1,            // minutes
    blockedSites:  [],
};

const DEFAULT_TIMER = {
    isRunning:      false,
    isPaused:       false,
    currentSession:     1,
    totalSessions:      4,
    currentPhase:  'focus',  // 'focus' | 'shortBreak' | 'longBreak'
    timeLeft:      25 * 60,
};

// ─── small helpers ────────────────────────────────────────────

function normalizeHostname(url) {
    if (!url || typeof url !== 'string') return null;
    try {
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch { return null; }
}

function isUrlBlocked(url, blockedSites) {
    if (!url || !blockedSites || !blockedSites.length) return false;
    try {
        const obj  = new URL(url);
        const host = obj.hostname.toLowerCase().replace(/^www\./, '');
        return blockedSites.some(site => {
            if (!site) return false;
            const [domain, ...parts] = site.split('/');
            const siteHost = domain.replace(/^www\./, '').toLowerCase();
            const sitePath = parts.length ? '/' + parts.join('/') : '';
            if (!host.endsWith(siteHost)) return false;
            if (sitePath && !obj.pathname.startsWith(sitePath)) return false;
            return true;
        });
    } catch { return false; }
}

function isHttpUrl(url) {
    return Boolean(url) && /^https?:\/\//i.test(url);
}

// ─── storage helpers ──────────────────────────────────────────

const STORAGE_KEYS = [
    ...Object.keys(DEFAULT_SETTINGS),
    ...Object.keys(DEFAULT_TIMER),
    'overrideUntil', 'overrideStartTime', 'overrideDuration', 'overrideDomain',
];

async function readStorage() {
    const raw = await browser.storage.local.get(STORAGE_KEYS);

    const settings = {};
    for (const k of Object.keys(DEFAULT_SETTINGS))
        settings[k] = raw[k] !== undefined ? raw[k] : DEFAULT_SETTINGS[k];

    const timer = {};
    for (const k of Object.keys(DEFAULT_TIMER))
        timer[k] = raw[k] !== undefined ? raw[k] : DEFAULT_TIMER[k];
    timer.totalSessions = settings.sessionsCount; // keep in sync

    const override = {
        overrideUntil:     raw.overrideUntil     || null,
        overrideStartTime: raw.overrideStartTime || null,
        overrideDuration:  raw.overrideDuration  || null,
        overrideDomain:    raw.overrideDomain    || null,
    };

    return { settings, timer, override };
}

async function writeStorage(data) {
    await browser.storage.local.set({ ...data, lastSaved: Date.now() });
}

// ─── main class ───────────────────────────────────────────────

class PomodoroBackground {
    constructor() {
        this.settings = { ...DEFAULT_SETTINGS };
        this.timer    = { ...DEFAULT_TIMER };
        this.override = { overrideUntil: null, overrideStartTime: null,
                          overrideDuration: null, overrideDomain: null };
        this.isAndroid = false;

        // Created ONCE – never recreated. Recreating breaks hasListener() because
        // the old function reference stays attached as an invisible ghost listener.
        this._blockingFn = this._makeBlockingListener();

        this._init();
    }

    // ── startup ──────────────────────────────────────────────

    async _init() {
        try {
            await this._detectPlatform();
            await this._reloadCache();          // populate caches from storage
            await this._expireStaleOverride();  // clean up from previous session
            this._applyBlocking();              // set up webRequest listener
            this._setupAlarms();
            this._setupMessages();
            this._setupStorageWatcher();        // react to any storage writes
            this._setupNavigation();
            this._setupLifecycle();
            this._setupPeriodicCheck();
            console.log('[BG] Initialized — blockingMode:', this.settings.blockingMode,
                        'sites:', this.settings.blockedSites.length,
                        'isRunning:', this.timer.isRunning);
        } catch (err) {
            console.error('[BG] Init failed, retrying in 2 s:', err);
            setTimeout(() => this._init(), 2000);
        }
    }

    async _detectPlatform() {
        try {
            const info = await browser.runtime.getPlatformInfo();
            this.isAndroid = info.os === 'android';
        } catch { this.isAndroid = false; }
        console.log('[BG] Platform:', this.isAndroid ? 'Android' : 'Desktop');
    }

    // Reload in-memory cache from storage. Call this before any decision.
    async _reloadCache() {
        const { settings, timer, override } = await readStorage();
        this.settings = settings;
        this.timer    = timer;
        this.override = override;
    }

    async _expireStaleOverride() {
        if (this.override.overrideUntil && Date.now() >= this.override.overrideUntil) {
            console.log('[BG] Clearing expired override from previous session');
            await this._clearOverride();
        }
    }

    // ── webRequest blocking ───────────────────────────────────

    // Should the listener be attached right now?
    _wantBlocking() {
        if (this.isAndroid) return false;
        if (!this.settings.blockedSites.length) return false;
        if (this.override.overrideUntil && Date.now() < this.override.overrideUntil) return false;

        switch (this.settings.blockingMode) {
            case 'always':     return true;
            case 'focus-only': return this.timer.isRunning && this.timer.currentPhase === 'focus';
            default:           return this.timer.isRunning && this.timer.currentPhase === 'focus';
        }
    }

    // Reconcile listener state with _wantBlocking(). Only place we touch the listener.
    _applyBlocking() {
        const want = this._wantBlocking();
        let has = false;
        try { has = browser.webRequest.onBeforeRequest.hasListener(this._blockingFn); }
        catch { has = false; }

        if (want && !has) {
            try {
                browser.webRequest.onBeforeRequest.addListener(
                    this._blockingFn,
                    { urls: ['<all_urls>'], types: ['main_frame'] },
                    ['blocking']
                );
                console.log('[BG] Blocking listener → ON');
            } catch (err) { console.error('[BG] addListener failed:', err); }
        } else if (!want && has) {
            try {
                browser.webRequest.onBeforeRequest.removeListener(this._blockingFn);
                console.log('[BG] Blocking listener → OFF');
            } catch (err) { console.error('[BG] removeListener failed:', err); }
        }
    }

    // The interceptor. Uses the in-memory cache (kept fresh by _reloadCache).
    _makeBlockingListener() {
        return (details) => {
            // Inline override check — state may have changed since _applyBlocking ran
            if (this.override.overrideUntil && Date.now() < this.override.overrideUntil) return;
            if (!isUrlBlocked(details.url, this.settings.blockedSites)) return;

            const { blockingMode } = this.settings;
            const { isRunning, currentPhase } = this.timer;

            let block = false;
            if (blockingMode === 'always') block = true;
            else if (blockingMode === 'focus-only') block = isRunning && currentPhase === 'focus';

            if (!block) return;

            const qs = new URLSearchParams({
                url: details.url, mode: blockingMode,
                timerRunning: String(isRunning), phase: currentPhase,
            });
            console.log('[BG] Blocking:', details.url);
            return { redirectUrl: browser.runtime.getURL('resources/blocked.html?' + qs) };
        };
    }

    // ── storage watcher ───────────────────────────────────────
    // Any write to storage (from popup, options page, or here) triggers a reload
    // and a blocking re-evaluation. This is the primary sync mechanism.

    _setupStorageWatcher() {
        browser.storage.onChanged.addListener(async (changes, area) => {
            if (area !== 'local') return;
            await this._reloadCache();
            this._applyBlocking();
        });
    }

    // ── periodic verification ─────────────────────────────────
    // Belt-and-suspenders: re-read storage + re-apply every 30 s and on tab focus.

    _setupPeriodicCheck() {
        browser.alarms.create('blockingCheck', { periodInMinutes: 0.5 });

        browser.tabs.onActivated.addListener(() =>
            setTimeout(() => this._verify(), 400));

        browser.windows.onFocusChanged.addListener((wid) => {
            if (wid !== browser.windows.WINDOW_ID_NONE)
                setTimeout(() => this._verify(), 300);
        });
    }

    async _verify() {
        try {
            await this._reloadCache();
            this._applyBlocking();
        } catch (err) {
            console.warn('[BG] Verify error:', err);
        }
    }

    // ── alarms ───────────────────────────────────────────────

    _setupAlarms() {
        browser.alarms.onAlarm.addListener((alarm) => {
            switch (alarm.name) {
                case 'pomodoroTick':  this._tick();                 break;
                case 'overrideCheck': this._checkOverrideExpiry();  break;
                case 'blockingCheck': this._verify();               break;
            }
        });
    }

    // ── navigation (Android + desktop floating-timer re-inject) ──

    _setupNavigation() {
        browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
            if (!tab.url || !isHttpUrl(tab.url)) return;
            if (changeInfo.status !== 'complete') return;

            if (this.override.overrideUntil && Date.now() < this.override.overrideUntil) {
                if (!this.isAndroid && this._isSameOverrideDomain(tab.url)) {
                    const elapsed    = Date.now() - this.override.overrideStartTime;
                    const remaining  = Math.max(0, Math.ceil(
                        (this.override.overrideDuration - elapsed) / 1000));
                    if (remaining > 0) this._injectFloatingTimer(tabId, remaining);
                }
                return;
            }

            if (this.isAndroid) this._androidBlock(tabId, tab.url);
        });

        browser.tabs.onActivated.addListener(async ({ tabId }) => {
            if (!this.isAndroid) return;
            if (this.override.overrideUntil && Date.now() < this.override.overrideUntil) return;
            try {
                const tab = await browser.tabs.get(tabId);
                if (tab?.url) this._androidBlock(tabId, tab.url);
            } catch { /* tab gone */ }
        });
    }

    _androidBlock(tabId, url) {
        if (!isUrlBlocked(url, this.settings.blockedSites)) return;
        const { blockingMode } = this.settings;
        const { isRunning, currentPhase } = this.timer;

        let block = blockingMode === 'always' ? true
                  : blockingMode === 'focus-only' ? (isRunning && currentPhase === 'focus')
                  : false;
        if (!block) return;

        const qs = new URLSearchParams({
            url, mode: blockingMode,
            timerRunning: String(isRunning), phase: currentPhase,
        });
        browser.tabs.update(tabId, {
            url: browser.runtime.getURL('resources/blocked.html?' + qs),
        }).catch(() => {});
    }

    // ── lifecycle ─────────────────────────────────────────────

    _setupLifecycle() {
        browser.runtime.onStartup.addListener(() => this._verify());
        browser.runtime.onInstalled.addListener(() => this._verify());
    }

    // ── message handler ───────────────────────────────────────

    _setupMessages() {
        browser.runtime.onMessage.addListener((msg, _sender, respond) => {
            this._onMessage(msg, respond);
            return true; // keep channel open for async
        });
    }

    async _onMessage(msg, respond) {
        try {
            switch (msg.action) {
                case 'startTimer':   await this._startTimer();  respond({ success: true }); break;
                case 'pauseTimer':   await this._pauseTimer();  respond({ success: true }); break;
                case 'resetTimer':   await this._resetTimer();  respond({ success: true }); break;

                case 'updateSettings': {
                    // Popup wrote to storage already; re-read and re-apply
                    await writeStorage(msg.settings);
                    await this._reloadCache();
                    this._applyBlocking();
                    this._updateBadge();
                    respond({ success: true });
                    break;
                }

                // updateBlocklist & updateBlockingMode: popup already updated storage.
                // The storage watcher will fire, but we also handle the message for
                // immediate feedback to the popup.
                case 'updateBlocklist':
                case 'updateBlockingMode': {
                    if (msg.blockingMode) await writeStorage({ blockingMode: msg.blockingMode });
                    await this._reloadCache();
                    this._applyBlocking();
                    respond({ success: true });
                    break;
                }

                case 'overrideBlock': {
                    const result = await this._grantOverride(msg.originalUrl);
                    respond(result);
                    break;
                }

                case 'timerTick':        this._handleTimerTick(msg.tabId, msg.timeRemaining); respond({ success: true }); break;
                case 'timerExpired':     await this._forceRefreshTab(msg.tabId); respond({ success: true }); break;
                case 'requestTimerSync': this._handleTimerSync(msg.tabId, msg.currentTime);   respond({ success: true }); break;

                case 'getCurrentTabId': {
                    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
                    respond({ tabId: tabs[0]?.id ?? null });
                    break;
                }

                default: respond({ success: false, error: 'Unknown action' });
            }
        } catch (err) {
            console.error('[BG] Message error:', err);
            respond({ success: false, error: err.message });
        }
    }

    // ── timer ─────────────────────────────────────────────────

    async _startTimer() {
        if (this.timer.isRunning) return;
        this.timer.isRunning = true;
        this.timer.isPaused  = false;
        await writeStorage(this.timer);
        browser.alarms.create('pomodoroTick', { periodInMinutes: 1 / 60 });
        this._applyBlocking();
        this._updateBadge();
        this._notify('Focus session started!',
            `Session ${this.timer.currentSession} of ${this.timer.totalSessions}`);
    }

    async _pauseTimer() {
        if (!this.timer.isRunning) return;
        this.timer.isRunning = false;
        this.timer.isPaused  = true;
        await writeStorage(this.timer);
        browser.alarms.clear('pomodoroTick');
        this._applyBlocking();
        this._updateBadge();
        this._notify('Timer paused', 'Click to resume when ready');
    }

    async _resetTimer() {
        this.timer = {
            ...this.timer,
            isRunning: false, isPaused: false,
            currentSession: 1, currentPhase: 'focus',
            timeLeft: this.settings.focusTime * 60,
        };
        await writeStorage(this.timer);
        browser.alarms.clear('pomodoroTick');
        await this._clearOverride();
        this._applyBlocking();
        this._updateBadge();
        this._notify('Timer reset', 'Ready for a new session');
    }

    async _tick() {
        // Always re-read storage before mutating — alarms can fire while the
        // popup is also writing, so we must work with the freshest state.
        await this._reloadCache();
        if (!this.timer.isRunning) return;

        this.timer.timeLeft--;
        await writeStorage({ timeLeft: this.timer.timeLeft });
        this._updateBadge();

        if (this.timer.timeLeft <= 0) await this._advancePhase();
    }

    async _advancePhase() {
        browser.alarms.clear('pomodoroTick');

        if (this.timer.currentPhase === 'focus') {
            this._notify('🎉 Focus session complete!',
                `Session ${this.timer.currentSession} done.`);
            const longBreak = this.timer.currentSession % 4 === 0;
            this.timer.currentPhase = longBreak ? 'longBreak' : 'shortBreak';
            this.timer.timeLeft = longBreak
                ? this.settings.longBreakTime * 60
                : this.settings.breakTime * 60;
        } else {
            this._notify('Break over!', 'Ready for the next session?');
            this.timer.currentSession++;
            if (this.timer.currentSession > this.timer.totalSessions) {
                this._notify('🏆 All sessions complete!',
                    `${this.timer.totalSessions} sessions done!`);
                await this._resetTimer();
                return;
            }
            this.timer.currentPhase = 'focus';
            this.timer.timeLeft = this.settings.focusTime * 60;
        }

        this.timer.isRunning = false;
        await writeStorage(this.timer);

        if (this.settings.autoStart) await this._startTimer();
        else { this._applyBlocking(); this._updateBadge(); }
    }

    // ── override (temporary access) ───────────────────────────

    async _grantOverride(originalUrl) {
        if (this.override.overrideUntil && Date.now() < this.override.overrideUntil) {
            return { success: true,
                     overrideSeconds: Math.ceil((this.override.overrideUntil - Date.now()) / 1000) };
        }

        const minutes    = this.settings.overrideTime || 1;
        const durationMs = minutes * 60 * 1000;
        const now        = Date.now();

        this.override = {
            overrideUntil:     now + durationMs,
            overrideStartTime: now,
            overrideDuration:  durationMs,
            overrideDomain:    normalizeHostname(originalUrl),
        };

        // Persist so _expireStaleOverride() works after a browser restart
        await writeStorage(this.override);
        this._applyBlocking(); // removes webRequest listener

        browser.alarms.create('overrideCheck', { periodInMinutes: 6 / 60 }); // every 6 s

        const timeText = minutes === 1 ? '1 minute' : `${minutes} minutes`;
        this._notify('Temporary Access Granted', `Blocking paused for ${timeText}`);

        if (!this.isAndroid) {
            setTimeout(() => this._injectTimerOnOverrideDomain(minutes * 60), 2000);
        }

        return { success: true, overrideSeconds: minutes * 60 };
    }

    async _checkOverrideExpiry() {
        if (!this.override.overrideUntil) {
            browser.alarms.clear('overrideCheck');
            return;
        }
        if (Date.now() < this.override.overrideUntil) return;

        console.log('[BG] Override expired');
        const domain = this.override.overrideDomain;
        await this._clearOverride();
        this._applyBlocking();
        browser.alarms.clear('overrideCheck');
        this._notify('Temporary Access Ended', 'Blocking is active again.');
        this._refreshTabsOnDomain(domain);
    }

    async _clearOverride() {
        this.override = {
            overrideUntil: null, overrideStartTime: null,
            overrideDuration: null, overrideDomain: null,
        };
        await browser.storage.local.remove([
            'overrideUntil', 'overrideStartTime', 'overrideDuration', 'overrideDomain',
        ]);
    }

    _isSameOverrideDomain(url) {
        if (!this.override.overrideDomain) return false;
        const h = normalizeHostname(url);
        return h === this.override.overrideDomain ||
               (h != null && h.endsWith('.' + this.override.overrideDomain));
    }

    // ── floating timer injection (desktop) ────────────────────

    async _injectTimerOnOverrideDomain(totalSeconds) {
        if (!this.override.overrideDomain) return;
        const tabs = await browser.tabs.query({});
        for (const tab of tabs) {
            if (!tab.url || !this._isSameOverrideDomain(tab.url)) continue;
            const elapsed   = Date.now() - this.override.overrideStartTime;
            const remaining = Math.max(0,
                Math.ceil((this.override.overrideDuration - elapsed) / 1000));
            if (remaining > 0) await this._injectFloatingTimer(tab.id, remaining);
        }
    }

    async _injectFloatingTimer(tabId, timeRemaining) {
        try {
            const tab = await browser.tabs.get(tabId);
            if (!tab?.url || !isHttpUrl(tab.url)) return;
            if (tab.status === 'loading') await this._waitForTab(tabId, 3000);

            await browser.scripting.insertCSS({
                target: { tabId }, files: ['resources/floating-timer.css'],
            }).catch(() => {});

            await browser.scripting.executeScript({
                target: { tabId }, files: ['resources/floating-timer.js'],
            });
            await new Promise(r => setTimeout(r, 500));
            await browser.tabs.sendMessage(tabId,
                { action: 'startTimer', initialTime: timeRemaining });
        } catch (err) {
            console.warn('[BG] Floating timer injection failed:', err.message);
            const mins = Math.ceil(timeRemaining / 60);
            this._notify('Temporary Access', `Access granted for ${mins} min.`);
        }
    }

    _waitForTab(tabId, timeout) {
        return new Promise((resolve, reject) => {
            const deadline = Date.now() + timeout;
            const poll = () => browser.tabs.get(tabId)
                .then(t => {
                    if (t.status === 'complete') return resolve();
                    if (Date.now() > deadline) return reject(new Error('Tab load timeout'));
                    setTimeout(poll, 150);
                }).catch(reject);
            poll();
        });
    }

    // ── override timer sync ───────────────────────────────────

    _handleTimerTick(tabId, contentTime) {
        if (!this.override.overrideUntil) return;
        const elapsed = Date.now() - this.override.overrideStartTime;
        const auth    = Math.max(0, Math.ceil((this.override.overrideDuration - elapsed) / 1000));
        if (auth <= 0) { this._forceRefreshTab(tabId); return; }
        if (Math.abs(contentTime - auth) > 2)
            browser.tabs.sendMessage(tabId, { action: 'syncTimer', timeRemaining: auth }).catch(() => {});
    }

    _handleTimerSync(tabId, contentTime) {
        if (!this.override.overrideUntil) return;
        const elapsed = Date.now() - this.override.overrideStartTime;
        const auth    = Math.max(0, Math.ceil((this.override.overrideDuration - elapsed) / 1000));
        browser.tabs.sendMessage(tabId, { action: 'syncTimer', timeRemaining: auth }).catch(() => {});
        if (auth <= 0) this._forceRefreshTab(tabId);
    }

    async _forceRefreshTab(tabId) {
        await this._clearOverride();
        this._applyBlocking();
        try { await browser.tabs.reload(tabId); } catch { /* tab may be gone */ }
        this._notify('Temporary Access Ended', 'Website is blocked again.');
    }

    async _refreshTabsOnDomain(domain) {
        if (!domain) return;
        const tabs = await browser.tabs.query({});
        for (const tab of tabs) {
            if (!tab.url) continue;
            const h = normalizeHostname(tab.url);
            if (h === domain || (h && h.endsWith('.' + domain)))
                browser.tabs.reload(tab.id).catch(() => {});
        }
    }

    // ── badge ─────────────────────────────────────────────────

    _updateBadge() {
        const { isRunning, isPaused, currentPhase, timeLeft } = this.timer;
        const mins = Math.floor(timeLeft / 60);
        const secs = timeLeft % 60;

        let text = '▶', color = '#3498db';
        if (isRunning) {
            color = currentPhase === 'focus' ? '#e74c3c' : '#27ae60';
            text  = (mins > 9 ? String(mins) : mins > 0 ? `${mins}m` : String(secs)).slice(0, 2);
        } else if (isPaused) {
            color = '#f39c12'; text = '❚❚';
        }

        browser.action.setBadgeText({ text });
        browser.action.setBadgeBackgroundColor({ color });
    }

    // ── notifications ─────────────────────────────────────────

    _notify(title, message) {
        browser.notifications.create('sf-notify', {
            type: 'basic',
            iconUrl: browser.runtime.getURL('icons/timer-48.png'),
            title, message,
        });
    }
}

new PomodoroBackground();