function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  let result = "";
  if (mins > 0) result += `${mins}m `;
  result += `${secs}s`;
  return result;
}

let intervalId;

function getSiteName(domain) {
  // Strip www. and TLDs like .com, .org, .net, etc.
  let cleaned = domain.replace(/^www\./, '').split('.')[0];
  // Capitalize first letter
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

async function updatePopup() {
  clearInterval(intervalId); // Clear any previous interval immediately

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url.startsWith("http")) return;

  chrome.runtime.sendMessage({ type: "GET_CURRENT_TAB_TIMER" }, (response) => {
    if (!response) return;

    const { domain, time, disabled } = response;
    const siteName = getSiteName(domain);
    document.getElementById("heading").textContent = `Time on ${siteName}`;

    const timerElem = document.getElementById("timer");
    if (disabled) {
      timerElem.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 18 18" style="vertical-align:middle;">
          <rect x="3" y="3" width="4" height="12" rx="1.5" fill="#00f6ff"/>
          <rect x="11" y="3" width="4" height="12" rx="1.5" fill="#00f6ff"/>
        </svg>
        <span style="font-size:15px;vertical-align:middle;"> Timer disabled</span>`;
      return;
    }

    let seconds = time;
    timerElem.textContent = formatTime(seconds);

    intervalId = setInterval(() => {
      seconds++;
      timerElem.textContent = formatTime(seconds);
    }, 1000);
  });
}

// Function to send reset timer request to background
function resetActiveTabTimer() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.url) return;
    const domain = new URL(tab.url).hostname;
    chrome.runtime.sendMessage({ type: 'RESET_DOMAIN_TIMER', domain });
  });
}

// New function to reset the timer and update the popup UI
function resetActiveTabTimerAndUpdateUI() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.url) return;
    const domain = new URL(tab.url).hostname;
    chrome.runtime.sendMessage({ type: 'RESET_DOMAIN_TIMER', domain }); // No callback needed
    updatePopup();
  });
}

// Attach the new function to the button
const resetBtn = document.getElementById('reset-timer-btn');
if (resetBtn) {
  resetBtn.removeEventListener('click', resetActiveTabTimer); // Remove old handler if present
  resetBtn.addEventListener('click', resetActiveTabTimerAndUpdateUI);
}

// Get disabled domains from storage
function getDisabledDomains(callback) {
  chrome.storage.local.get('disabledDomains', (result) => {
    callback(result.disabledDomains || []);
  });
}

// Set disabled domains in storage
function setDisabledDomains(domains, callback) {
  chrome.storage.local.set({ disabledDomains: domains }, callback);
}

// Update toggle state on popup load
function updateDisableToggle() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.url) return;
    const domain = new URL(tab.url).hostname;
    getDisabledDomains((disabledDomains) => {
      const toggle = document.getElementById('disable-timer-toggle');
      if (toggle) toggle.checked = disabledDomains.includes(domain);
    });
  });
}

// Handle toggle change
function handleDisableToggleChange() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.url) return;
    const domain = new URL(tab.url).hostname;
    getDisabledDomains((disabledDomains) => {
      const toggle = document.getElementById('disable-timer-toggle');
      let updated = [...disabledDomains];
      if (toggle && toggle.checked) {
        if (!updated.includes(domain)) updated.push(domain);
        // Send message to background to remove timer when disabling
        chrome.runtime.sendMessage({ type: 'DISABLE_DOMAIN_TIMER', domain });
      } else {
        updated = updated.filter(d => d !== domain);
        // Send message to background to reset timer when re-enabling
        chrome.runtime.sendMessage({ type: 'ENABLE_DOMAIN_TIMER', domain });
      }
      setDisabledDomains(updated);
      // Optionally update popup UI
      updatePopup();
    });
  });
}

// Attach event listener to toggle
const disableToggle = document.getElementById('disable-timer-toggle');
if (disableToggle) {
  disableToggle.addEventListener('change', handleDisableToggleChange);
}

// Update toggle on popup load
updateDisableToggle();

updatePopup();
