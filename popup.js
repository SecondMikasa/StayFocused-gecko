// ============================================================
// Stay Focused – Popup Script
// Rule: always write preferences to browser.storage.local first.
// The background's storage.onChanged watcher picks up every
// change automatically, so sendMessage() is optional / best-effort.
// ============================================================

class PomodoroTimer {
    constructor() {
        this._initElements();
        this._loadAll();           // read everything from storage once
        this._setupEvents();

        // Keep display and block-list fresh while popup is open
        setInterval(() => this._refreshDisplay(), 1000);
        setInterval(() => this._refreshBlockList(), 5000);

        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) this._loadAll();
        });
    }

    // ── element refs ─────────────────────────────────────────

    _initElements() {
        this.timeDisplay   = document.getElementById('timeDisplay');
        this.sessionInfo   = document.getElementById('sessionInfo');
        this.statusDisplay = document.getElementById('statusDisplay');

        this.startBtn      = document.getElementById('startBtn');
        this.pauseBtn      = document.getElementById('pauseBtn');
        this.resetBtn      = document.getElementById('resetBtn');

        this.focusTimeInput    = document.getElementById('focusTime');
        this.breakTimeInput    = document.getElementById('breakTime');
        this.longBreakInput    = document.getElementById('longBreakTime');
        this.sessionsInput     = document.getElementById('sessionsCount');
        this.autoStartInput    = document.getElementById('autoStart');
        this.saveSettingsBtn   = document.getElementById('saveSettings');

        this.blockedSiteInput  = document.getElementById('blockedSiteInput');
        this.addSiteBtn        = document.getElementById('addSiteBtn');
        this.blockList         = document.getElementById('blockList');
        this.blockingModeChk   = document.getElementById('blockingModeCheckbox');
        this.overrideTimeInput = document.getElementById('overrideTime');
    }

    // ── load everything from storage ─────────────────────────

    _loadAll() {
        browser.storage.local.get([
            'focusTime', 'breakTime', 'longBreakTime', 'sessionsCount',
            'autoStart', 'blockingMode', 'overrideTime', 'blockedSites',
            'isRunning', 'isPaused', 'timeLeft', 'currentSession',
            'totalSessions', 'currentPhase',
        ]).then(r => {
            // Settings
            this.focusTimeInput.value    = r.focusTime    ?? 25;
            this.breakTimeInput.value    = r.breakTime    ?? 5;
            this.longBreakInput.value    = r.longBreakTime ?? 15;
            this.sessionsInput.value     = r.sessionsCount ?? 4;
            this.autoStartInput.checked  = r.autoStart    ?? false;
            this.overrideTimeInput.value = r.overrideTime  ?? 1;

            const blockingMode = r.blockingMode || 'focus-only';
            this.blockingModeChk.checked = (blockingMode === 'focus-only');

            // Timer state
            this._applyTimerState(r);

            // Block list
            this._renderBlockList(r.blockedSites || []);
        });
    }

    _applyTimerState(r) {
        const timeLeft      = r.timeLeft       ?? (this.focusTimeInput.value * 60);
        const session       = r.currentSession ?? 1;
        const totalSessions = r.totalSessions  ?? +this.sessionsInput.value;
        const phase         = r.currentPhase   ?? 'focus';
        const isRunning     = r.isRunning      ?? false;
        const isPaused      = r.isPaused       ?? false;

        const mins = Math.floor(timeLeft / 60);
        const secs = timeLeft % 60;
        this.timeDisplay.textContent  = `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
        this.sessionInfo.textContent  = `Session ${session} of ${totalSessions}`;

        let status = '▶️ Ready to start', cls = '';
        if (isRunning) {
            if      (phase === 'focus')      { status = '🎯 Focus Time - Stay concentrated!'; cls = 'working'; }
            else if (phase === 'shortBreak') { status = '☕ Short Break - Relax a bit!';      cls = 'break';   }
            else if (phase === 'longBreak')  { status = '🌟 Long Break - Well deserved!';     cls = 'break';   }
        } else if (isPaused) {
            status = '⏸️ Paused'; cls = 'paused';
        }
        this.statusDisplay.textContent = status;
        this.statusDisplay.className   = `status ${cls}`;

        this._isRunning = isRunning;
        this._isPaused  = isPaused;
        this._updateButtons();
    }

    _refreshDisplay() {
        browser.storage.local.get([
            'isRunning', 'isPaused', 'timeLeft',
            'currentSession', 'totalSessions', 'currentPhase',
        ]).then(r => this._applyTimerState(r));
    }

    _refreshBlockList() {
        browser.storage.local.get('blockedSites').then(r =>
            this._renderBlockList(r.blockedSites || []));
    }

    // ── events ───────────────────────────────────────────────

    _setupEvents() {
        this.startBtn.addEventListener('click',    () => this._startTimer());
        this.pauseBtn.addEventListener('click',    () => this._pauseTimer());
        this.resetBtn.addEventListener('click',    () => this._resetTimer());
        this.saveSettingsBtn.addEventListener('click', () => this._saveSettings());

        this.addSiteBtn.addEventListener('click',  () => this._addSite());
        this.blockedSiteInput.addEventListener('keypress', e => {
            if (e.key === 'Enter') this._addSite();
        });

        this.blockList.addEventListener('click', e => {
            if (e.target.classList.contains('remove-site-btn'))
                this._removeSite(e.target.dataset.site);
        });

        // Write to storage immediately; background storage watcher will apply changes.
        this.blockingModeChk.addEventListener('change',   () => this._saveBlockingMode());
        this.overrideTimeInput.addEventListener('change', () => this._saveOverrideTime());

        this._setupCollapsible();
    }

    _setupCollapsible() {
        document.querySelectorAll('.section-header').forEach(header => {
            header.addEventListener('click', () =>
                header.parentElement.classList.toggle('collapsed'));
        });

        document.querySelector('[data-section="settings"]')
            ?.parentElement?.classList.remove('collapsed');
        document.querySelector('[data-section="blocker"]')
            ?.parentElement?.classList.add('collapsed');
    }

    // ── timer controls ────────────────────────────────────────

    _startTimer() {
        browser.runtime.sendMessage({ action: 'startTimer' }).then(r => {
            if (r?.success) { this._isRunning = true; this._isPaused = false; this._updateButtons(); }
        });
    }

    _pauseTimer() {
        browser.runtime.sendMessage({ action: 'pauseTimer' }).then(r => {
            if (r?.success) { this._isRunning = false; this._isPaused = true; this._updateButtons(); }
        });
    }

    _resetTimer() {
        browser.runtime.sendMessage({ action: 'resetTimer' }).then(r => {
            if (r?.success) {
                this._isRunning = false; this._isPaused = false;
                this._updateButtons();
                this._refreshDisplay();
            }
        });
    }

    _updateButtons() {
        if (this._isRunning) {
            this.startBtn.disabled    = true;
            this.pauseBtn.disabled    = false;
            this.startBtn.textContent = 'Running';
        } else if (this._isPaused) {
            this.startBtn.disabled    = false;
            this.pauseBtn.disabled    = true;
            this.startBtn.textContent = 'Resume';
        } else {
            this.startBtn.disabled    = false;
            this.pauseBtn.disabled    = true;
            this.startBtn.textContent = 'Start';
        }
    }

    // ── settings ─────────────────────────────────────────────

    _saveSettings() {
        const s = {
            focusTime:    +this.focusTimeInput.value,
            breakTime:    +this.breakTimeInput.value,
            longBreakTime:+this.longBreakInput.value,
            sessionsCount:+this.sessionsInput.value,
            autoStart:     this.autoStartInput.checked,
        };

        // Write to storage → background storage watcher reacts automatically
        browser.storage.local.set(s).then(() => {
            this._toast('Settings saved!');
            // Also tell background directly so it can update timeLeft while not running
            browser.runtime.sendMessage({ action: 'updateSettings', settings: s }).catch(() => {});
        }).catch(() => this._toast('Error saving settings'));
    }

    // ── blocking mode ─────────────────────────────────────────
    // Write to storage. The background's storage.onChanged watcher applies it.
    // sendMessage is fire-and-forget for extra speed on the background side.

    _saveBlockingMode() {
        const mode = this.blockingModeChk.checked ? 'focus-only' : 'always';

        browser.storage.local.set({ blockingMode: mode }).then(() => {
            const label = mode === 'focus-only' ? 'focus sessions only' : 'always';
            this._toast(`Blocking: ${label}`);
            // Optional direct message — background already got it via storage watcher
            browser.runtime.sendMessage({ action: 'updateBlockingMode', blockingMode: mode })
                .catch(() => {}); // silently ignore if background is busy
        }).catch(() => this._toast('Error saving blocking mode'));
    }

    _saveOverrideTime() {
        const v = parseInt(this.overrideTimeInput.value);
        if (isNaN(v) || v < 1 || v > 60) {
            this._toast('Override time must be 1–60 minutes');
            this.overrideTimeInput.value = 1;
            return;
        }
        browser.storage.local.set({ overrideTime: v }).then(() =>
            this._toast(`Override duration: ${v} min`))
        .catch(() => this._toast('Error saving override time'));
    }

    // ── block list ────────────────────────────────────────────

    _addSite() {
        const raw = this.blockedSiteInput.value.trim();
        if (!raw) return;

        let site = raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
        if (site.endsWith('/')) site = site.slice(0, -1);
        if (!site) return;

        browser.storage.local.get('blockedSites').then(r => {
            const list = r.blockedSites || [];
            if (list.includes(site)) {
                this._toast(`${site} is already blocked`);
                this.blockedSiteInput.value = '';
                return;
            }
            list.push(site);
            // Write to storage → background storage watcher re-enables blocking if needed
            browser.storage.local.set({ blockedSites: list }).then(() => {
                this._renderBlockList(list);
                this.blockedSiteInput.value = '';
                this._toast(`Blocked: ${site}`);
                browser.runtime.sendMessage({ action: 'updateBlocklist' }).catch(() => {});
            });
        });
    }

    _removeSite(site) {
        browser.storage.local.get('blockedSites').then(r => {
            const list = (r.blockedSites || []).filter(s => s !== site);
            browser.storage.local.set({ blockedSites: list }).then(() => {
                this._renderBlockList(list);
                this._toast(`Unblocked: ${site}`);
                browser.runtime.sendMessage({ action: 'updateBlocklist' }).catch(() => {});
            });
        });
    }

    _renderBlockList(sites) {
        this.blockList.replaceChildren();
        if (!sites.length) {
            const p = document.createElement('p');
            p.className   = 'blocker-info';
            p.textContent = 'No sites blocked yet.';
            this.blockList.appendChild(p);
            return;
        }
        for (const site of sites) {
            const div  = document.createElement('div');
            div.className = 'blocked-site';

            const span = document.createElement('span');
            span.textContent = site;

            const btn  = document.createElement('button');
            btn.className = 'remove-site-btn';
            btn.dataset.site = site;
            btn.title    = `Remove ${site}`;
            btn.textContent = '×';

            div.append(span, btn);
            this.blockList.appendChild(div);
        }
    }

    // ── toast notification ────────────────────────────────────

    _toast(msg) {
        const el = document.createElement('div');
        el.textContent = msg;
        el.style.cssText = [
            'position:fixed', 'top:10px', 'right:10px',
            'background:#27ae60', 'color:#fff',
            'padding:10px 15px', 'border-radius:5px',
            'font-size:12px', 'z-index:9999',
        ].join(';');
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 2000);
    }
}

document.addEventListener('DOMContentLoaded', () => new PomodoroTimer());