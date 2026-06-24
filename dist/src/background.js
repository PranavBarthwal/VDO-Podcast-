chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set({
    speechSettings: {
      rate: 1,
      pitch: 1,
      voiceURI: ""
    }
  });
});
