const modeKey = 'takuwae-ledger-mode-v21';
const hasLegacy = localStorage.getItem('takuwae-v1') !== null;
const callback = Boolean(location.hash || location.search);
if (hasLegacy && !callback && localStorage.getItem(modeKey) !== 'cloud') {
  location.replace('./ledger.html');
} else {
  if (hasLegacy) {
    const back = document.getElementById('return-local');
    back.hidden = false;
    back.onclick = () => {
      localStorage.setItem(modeKey, 'local');
      location.assign('./');
    };
  }
  await import('./sync-app.js');
}
