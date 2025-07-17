class PomodoroBackground {
    constructor() {
        // Bind the listener method to 'this' to maintain context
        //FIXME: NO CLUE WHAT IT DOES (THANK THE AI GOD THAT MADE IT WORK)
        this.blockingListener = this.blockingListener.bind(this);

        this.initializeTimer();
        this.setupMessageListener();
        this.setupAlarmListener();
        this.loadBlockedSites(); 
    }

    initializeTimer() {
        browser.storage.local.get([
            'focusTime', 'breakTime', 'longBreakTime', 'sessionsCount',
            'currentSession', 'totalSessions', 'timeLeft', 'currentPhase',
            'isRunning', 'isPaused', 'autoStart'
        ]).then(result => {
            this.settings = {
                focusTime: result.focusTime || 25,
                breakTime: result.breakTime || 5,
                longBreakTime: result.longBreakTime || 15,
                sessionsCount: result.sessionsCount || 4,
                autoStart: result.autoStart || false
            };
            this.state = {
                currentSession: result.currentSession || 1,
                totalSessions: result.totalSessions || this.settings.sessionsCount,
                timeLeft: result.timeLeft || (this.settings.focusTime * 60),
                currentPhase: result.currentPhase || 'focus',
                isRunning: result.isRunning || false,
                isPaused: result.isPaused || false
            };
            this.saveState();
        });
    }

    setupMessageListener() {
        browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
            switch (request.action) {
                case 'startTimer':
                    this.startTimer();
                    return Promise.resolve({ success: true });
                case 'pauseTimer':
                    this.pauseTimer();
                    return Promise.resolve({ success: true });
                case 'resetTimer':
                    this.resetTimer();
                    return Promise.resolve({ success: true });
                case 'updateSettings':
                    this.updateSettings(request.settings);
                    return Promise.resolve({ success: true });
                case 'updateBlocklist':
                    this.loadBlockedSites(); 
                    return Promise.resolve({ success: true });
                case 'overrideBlock':
                    this.state.overrideUntil = Date.now() + 60000; 
                    this.saveState();
                    return Promise.resolve({ success: true });
            }
        });
    }

    setupAlarmListener() {
        browser.alarms.onAlarm.addListener((alarm) => {
            if (alarm.name === 'pomodoroTick') {
                this.tick();
            }
        });
    }

    async loadBlockedSites() {
        const { blockedSites } = await browser.storage.local.get('blockedSites');
        this.blockedSites = blockedSites || [];
        this.updateBlocking(); // Check if we need to change blocking state
    }

    blockingListener(details) {
        // If override is active, do nothing
        if (this.state.overrideUntil && Date.now() < this.state.overrideUntil) {
            return;
        }

        // Check if the requested URL contains any of the blocked domains
        const isBlocked = this.blockedSites.some(site => details.url.includes(site));

        if (isBlocked) {
            return {
                redirectUrl: browser.runtime.getURL("blocked.html")
            };
        }
    }

    enableBlocking() {
        if (!browser.webRequest.onBeforeRequest.hasListener(this.blockingListener)) {
            browser.webRequest.onBeforeRequest.addListener(
                this.blockingListener,
                { urls: ["<all_urls>"], types: ["main_frame"] },
                ["blocking"]
            );
        }
    }

    disableBlocking() {
        if (browser.webRequest.onBeforeRequest.hasListener(this.blockingListener)) {
            browser.webRequest.onBeforeRequest.removeListener(this.blockingListener);
        }
    }
    
    updateBlocking() {
        if (this.state.isRunning && this.state.currentPhase === 'focus' && this.blockedSites.length > 0) {
            this.enableBlocking();
        } else {
            this.disableBlocking();
        }
    }

    startTimer() {
        if (!this.state.isRunning) {
            this.state.isRunning = true;
            this.state.isPaused = false;
            if (this.state.overrideUntil && Date.now() > this.state.overrideUntil) {
                delete this.state.overrideUntil;
            }
            browser.alarms.create('pomodoroTick', { periodInMinutes: 1 / 60 });
            this.updateBadge();
            this.saveState();
            // Enable blocking if it's a focus session
            this.updateBlocking();
            const phaseText = this.state.currentPhase === 'focus' ? 'Focus session' : 'Break time';
            this.showNotification(`${phaseText} started!`, `Session ${this.state.currentSession} of ${this.state.totalSessions}`);
        }
    }

    pauseTimer() {
        if (this.state.isRunning) {
            this.state.isRunning = false;
            this.state.isPaused = true;
            browser.alarms.clear('pomodoroTick');
            this.updateBadge();
            this.saveState();
            this.updateBlocking(); 
            this.showNotification('Timer paused', 'Click to resume when ready');
        }
    }

    resetTimer() {
        this.state.isRunning = false;
        this.state.isPaused = false;
        this.state.currentSession = 1;
        this.state.currentPhase = 'focus';
        this.state.timeLeft = this.settings.focusTime * 60;
        delete this.state.overrideUntil; 
        browser.alarms.clear('pomodoroTick');
        this.updateBadge();
        this.saveState();
        this.updateBlocking(); 
        this.showNotification('Timer reset', 'Ready for a new session');
    }

    tick() {
        if (!this.state.isRunning) return;
        this.state.timeLeft--;
        this.updateBadge();
        this.saveState();
        if (this.state.timeLeft <= 0) {
            this.handlePhaseComplete();
        }
    }

    handlePhaseComplete() {
        browser.alarms.clear('pomodoroTick');
        if (this.state.currentPhase === 'focus') {
            this.showNotification('🎉 Focus session completed!', `Great job! Session ${this.state.currentSession} done.`);
            const isLongBreak = this.state.currentSession % 4 === 0;
            this.state.currentPhase = isLongBreak ? 'longBreak' : 'shortBreak';
            this.state.timeLeft = isLongBreak ? this.settings.longBreakTime * 60 : this.settings.breakTime * 60;
        } else {
            const breakType = this.state.currentPhase === 'longBreak' ? 'Long break' : 'Short break';
            this.showNotification(`${breakType} finished!`, 'Ready for the next session?');
            this.state.currentSession++;
            if (this.state.currentSession > this.state.totalSessions) {
                this.showNotification('🏆 All sessions completed!', `Congratulations! You completed ${this.state.totalSessions} focus sessions.`);
                this.resetTimer();
                return;
            }
            this.state.currentPhase = 'focus';
            this.state.timeLeft = this.settings.focusTime * 60;
        }

        if (this.settings.autoStart) {
            this.startTimer();
        } else {
            this.state.isRunning = false;
            const nextPhase = this.state.currentPhase === 'focus' ? 'next focus session' : 'break';
            this.showNotification(`Time for your ${nextPhase}!`, 'Click start when ready');
        }
        this.updateBadge();
        this.saveState();
        this.updateBlocking(); 
    }

    updateSettings(newSettings) {
        this.settings = { ...this.settings, ...newSettings };
        this.state.totalSessions = this.settings.sessionsCount;

        if (!this.state.isRunning) {
            if (this.state.currentPhase === 'focus') {
                this.state.timeLeft = newSettings.focusTime * 60;
            } else if (this.state.currentPhase === 'shortBreak') {
                this.state.timeLeft = newSettings.breakTime * 60;
            } else if (this.state.currentPhase === 'longBreak') {
                this.state.timeLeft = newSettings.longBreakTime * 60;
            }
        }

        if (this.state.currentSession > this.settings.sessionsCount) {
            this.state.currentSession = this.settings.sessionsCount;
        }

        browser.storage.local.set({ ...this.settings, totalSessions: this.state.totalSessions });
        this.updateBadge();
        this.saveState();
        this.showNotification('Settings updated!', 'Timer has been updated with new settings');
    }

    updateBadge() {
        const timeLeft = this.state.timeLeft;
        const minutes = Math.floor(timeLeft / 60);
        const seconds = timeLeft % 60;

        let badgeColor = '#3498db';
        let badgeText = '';

        if (this.state.isRunning) {
            badgeColor = (this.state.currentPhase === 'focus') ? '#e74c3c' : '#27ae60';

            if (minutes > 9) {
                badgeText = `${minutes}`; 
            } else if (minutes > 0) {
                badgeText = `${minutes}m`; 
            } else {
                badgeText = `${seconds}`; 
            }

            badgeText = badgeText.substring(0, 2);
        }
        else if (this.state.isPaused) {
            badgeColor = '#f39c12';
            badgeText = '❚❚';
        }
        else {
            badgeText = '▶';
        }

        browser.action.setBadgeText({ text: badgeText });
        browser.action.setBadgeBackgroundColor({ color: badgeColor });
    }

    showNotification(title, message) {
        browser.notifications.create({
            type: 'basic',
            iconUrl: browser.runtime.getURL('icons/timer-48.png'),
            title: title,
            message: message
        });
    }

    saveState() {
        browser.storage.local.set({
            ...this.state,
            ...this.settings
        });
    }
}

new PomodoroBackground();