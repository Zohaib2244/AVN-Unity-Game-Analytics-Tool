// The Unity SDK package shipped with the app, offered on the Settings page and next to the setup
// files on Event setup. Loaded before app.js.

const SDK_URL = '/v1/sdk';

async function mountSdkPanel(root) {
  try {
    const sdk = await request(SDK_URL);
    const row = (label, value) => `<li><span>${label}</span><strong>${value}</strong></li>`;
    root.innerHTML = `<div class="panel-header"><div><h2>Unity SDK</h2><p>The package every game imports, shared by all games on this server.</p></div>${icon('export', 17)}</div>
      <div class="panel-body">
        <ul class="status-list">${row('File', `<code>${escapeHTML(sdk.filename)}</code>`)}${row('Size', fileSize(sdk.size))}${row('SHA-256', `<code title="${escapeHTML(sdk.sha256)}">${escapeHTML(sdk.sha256.slice(0, 12))}…</code>`)}</ul>
        <div class="sdk-actions"><a class="button primary" href="${SDK_URL}/download" download>${icon('export', 15)} Download</a></div>
      </div>`;
  } catch (problem) { root.innerHTML = `<div class="panel-body"><p class="error">${escapeHTML(problem.message)}</p></div>`; }
}

const sdkDownloadButton = () => `<a class="button" href="${SDK_URL}/download" download>${icon('export', 15)} Download Unity SDK</a>`;
