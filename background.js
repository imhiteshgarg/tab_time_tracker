let activeDomain = null;
let domainTimers = {}; // { domain: { totalTime, lastStart } }

// Restore timers from storage on startup
chrome.storage.local.get('domainTimers', (result) => {
    if (result.domainTimers) {
        domainTimers = result.domainTimers;
    }
});

function saveDomainTimers() {
    chrome.storage.local.set({ domainTimers });
}

function startTracking(domain) {
    if (!domainTimers[domain]) {
        domainTimers[domain] = { totalTime: 0, lastStart: null };
        log('Created new timer for domain:', domain);
    }
    if (!domainTimers[domain].lastStart) {
        domainTimers[domain].lastStart = Date.now();
        log('Started/resumed timer for domain:', domain);
    }
    activeDomain = domain;
}

function stopTracking(domain) {
    if (domainTimers[domain] && domainTimers[domain].lastStart) {
        const now = Date.now();
        const elapsed = Math.floor((now - domainTimers[domain].lastStart) / 1000);
        domainTimers[domain].totalTime += elapsed;
        domainTimers[domain].lastStart = null;
        log('Stopped timer for domain:', domain, 'Elapsed:', elapsed, 'Total:', domainTimers[domain].totalTime);
        saveDomainTimers();
    }
    if (domain === activeDomain) {
        activeDomain = null;
    }
}

// Helper to get disabled domains
function getDisabledDomainsBG(callback) {
    chrome.storage.local.get('disabledDomains', (result) => {
        callback(result.disabledDomains || []);
    });
}

// Check if a domain is disabled
function isDomainDisabled(domain, callback) {
    getDisabledDomainsBG((disabledDomains) => {
        callback(disabledDomains.includes(domain));
    });
}

async function handleTabActivated(tabId) {
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab.url || !tab.url.startsWith("http")) return;
        const domain = new URL(tab.url).hostname;
        isDomainDisabled(domain, (disabled) => {
            if (disabled) {
                stopTracking(domain);
                activeDomain = null;
                chrome.action.setBadgeText({ text: '' });
                log('Switched to disabled domain:', domain);
                return;
            }
            if (activeDomain !== null && activeDomain !== domain) {
                stopTracking(activeDomain);
            }
            if (activeDomain !== domain) {
                startTracking(domain);
            }
        });
    } catch (e) {
        error('handleTabActivated error:', e);
    }
}

// Tab activated
chrome.tabs.onActivated.addListener(({ tabId }) => {
    handleTabActivated(tabId);
});

// Tab updated
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab.active && changeInfo.status === "complete") {
        handleTabActivated(tabId);
    }
});

// Window focus changed
chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
        if (activeDomain !== null) stopTracking(activeDomain);
    } else if (activeDomain !== null) {
        // Resume timer for the active domain in the focused window
        startTracking(activeDomain);
    }
});

// Periodically save timers using alarms
chrome.runtime.onInstalled.addListener(() => {
    if (chrome.alarms && chrome.alarms.create) {
        chrome.alarms.create('saveTimers', { periodInMinutes: 1 });
    } else {
        console.error('chrome.alarms API is not available');
    }
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'saveTimers') {
        // If a domain is active, update its totalTime up to now
        if (activeDomain && domainTimers[activeDomain] && domainTimers[activeDomain].lastStart) {
            const now = Date.now();
            const elapsed = Math.floor((now - domainTimers[activeDomain].lastStart) / 1000);
            domainTimers[activeDomain].totalTime += elapsed;
            domainTimers[activeDomain].lastStart = now;
        }
        saveDomainTimers();
    }
});

// Respond to popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "GET_CURRENT_TAB_TIMER") {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tab = tabs[0];
            if (!tab || !tab.url) {
                sendResponse({ domain: '', time: 0, disabled: false });
                return;
            }
            const domain = new URL(tab.url).hostname;
            isDomainDisabled(domain, (disabled) => {
                if (disabled) {
                    sendResponse({ domain, time: 0, disabled: true });
                    return;
                }
                const timerData = domainTimers[domain];
                let time = 0;
                if (timerData) {
                    time = timerData.totalTime || 0;
                    if (timerData.lastStart) {
                        time += Math.floor((Date.now() - timerData.lastStart) / 1000);
                    }
                }
                sendResponse({ domain, time, disabled: false });
            });
        });
        return true;
    }
    // Handle reset timer message from popup
    if (msg.type === "RESET_DOMAIN_TIMER" && msg.domain) {
        if (domainTimers[msg.domain]) {
            domainTimers[msg.domain] = { totalTime: 0, lastStart: domainTimers[msg.domain].lastStart ? Date.now() : null };
            saveDomainTimers();
        }
    }
    // Listen for domain re-enable and remove from domainTimers
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.type === "ENABLE_DOMAIN_TIMER" && msg.domain) {
            // Remove the timer for this domain when enabling
            if (domainTimers[msg.domain]) {
                delete domainTimers[msg.domain];
                log('Removed timer for domain (enabled):', msg.domain);
                saveDomainTimers();
            }
            // If the enabled domain is the current active tab, start tracking and update badge
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const tab = tabs[0];
                if (tab && tab.url && new URL(tab.url).hostname === msg.domain) {
                    startTracking(msg.domain);
                }
            });
        }
        if (msg.type === "DISABLE_DOMAIN_TIMER" && msg.domain) {
            // Remove the timer for this domain when disabling
            if (domainTimers[msg.domain]) {
                delete domainTimers[msg.domain];
                log('Removed timer for domain (disabled):', msg.domain);
                saveDomainTimers();
            }
        }
    });
});

// Tab closed: reset timer if no tabs for the domain remain
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    try {
        // Get all open tabs
        const tabs = await chrome.tabs.query({});
        // Build a set of all open domains
        const openDomains = new Set();
        for (const tab of tabs) {
            if (tab.url && tab.url.startsWith('http')) {
                openDomains.add(new URL(tab.url).hostname);
            }
        }
        // Find domains in domainTimers that are no longer open
        for (const domain in domainTimers) {
            if (!openDomains.has(domain)) {
                delete domainTimers[domain];
                saveDomainTimers();
            }
        }
    } catch (e) {
        console.error('Error in onRemoved:', e);
    }
});

// Helper to format seconds as mm:ss
function formatBadgeTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}:${s.toString().padStart(2, '0')}` : `${s}`;
}

// Show banner notification for multiples of 30 minutes
function notifyOn30MinuteMultiples(domain, time) {
    if (!notifyOn30MinuteMultiples.lastNotified) notifyOn30MinuteMultiples.lastNotified = {};
    const minutes = Math.floor(time / 60);
    if (minutes > 0 && minutes % 30 === 0 && notifyOn30MinuteMultiples.lastNotified[domain] !== minutes) {
        // console.log('Triggering notification for', domain, minutes);
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icon.png',
          title: 'Time Tracker',
          message: `It has been ${minutes} minutes since you are using ${domain}. Consider taking a break!`,
        });
        notifyOn30MinuteMultiples.lastNotified[domain] = minutes;
    }
}

// In badge/timer interval, skip if domain is disabled
let timerBadgeInterval = setInterval(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (!tab || !tab.url || !tab.url.startsWith('http')) {
            chrome.action.setBadgeText({ text: '' });
            return;
        }
        const domain = new URL(tab.url).hostname;
        if (!domain) {
            chrome.action.setBadgeText({ text: '' });
            return;
        }
        isDomainDisabled(domain, (disabled) => {
            if (disabled) {
                chrome.action.setBadgeText({ text: '' });
                return;
            }
            let time = 0;
            const timerData = domainTimers[domain];
            if (timerData) {
                time = timerData.totalTime || 0;
                if (timerData.lastStart) {
                    time += Math.floor((Date.now() - timerData.lastStart) / 1000);
                }
            }
            chrome.action.setBadgeText({ text: formatBadgeTime(time) });
            chrome.action.setBadgeBackgroundColor({ color: '#4688F1' });
            notifyOn30MinuteMultiples(domain, time);
        });
    });
}, 1000);

// Logging functions
function log(...args) {
    console.log('[TimeTracker]', ...args);
}
function warn(...args) {
    console.warn('[TimeTracker]', ...args);
}
function error(...args) {
    console.error('[TimeTracker]', ...args);
}
