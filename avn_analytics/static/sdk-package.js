// The Unity SDK package: uploaded once by the admin on the Settings page, downloadable by anyone
// who can open the website (Settings and Event setup). Loaded before app.js.

const SDK_URL = '/v1/sdk';
const sdkDate = value => new Date(value).toLocaleDateString(undefined, {year: 'numeric', month: 'short', day: 'numeric'});

async function mountSdkPanel(root) {
  const canUpload = me.can_manage_team;
  const draw = async () => {
    const sdk = await request(SDK_URL);
    const row = (label, value) => `<li><span>${label}</span><strong>${value}</strong></li>`;
    root.innerHTML = `<div class="panel-header"><div><h2>Unity SDK</h2><p>The package every game imports, shared by all games on this server.</p></div>${icon('export', 17)}</div>
      <div class="panel-body">
        ${sdk.available
          ? `<ul class="status-list">${row('File', `<code>${escapeHTML(sdk.filename)}</code>`)}${sdk.version ? row('Version', escapeHTML(sdk.version)) : ''}${row('Size', fileSize(sdk.size))}${row('Uploaded', `${escapeHTML(sdkDate(sdk.uploaded_at))}${sdk.uploaded_by ? ` · ${escapeHTML(sdk.uploaded_by)}` : ''}`)}${row('SHA-256', `<code title="${escapeHTML(sdk.sha256)}">${escapeHTML(sdk.sha256.slice(0, 12))}…</code>`)}</ul>`
          : `<p class="muted">No package has been uploaded yet.${canUpload ? '' : ' Ask the admin to upload it.'}</p>`}
        ${canUpload ? `<div class="field sdk-version"><label for="sdk-version">Version label (optional)</label><input id="sdk-version" maxlength="40" placeholder="e.g. 1.2.0" value="${escapeHTML(sdk.version || '')}"></div>` : ''}
        <div class="error" role="alert"></div>
        <div class="sdk-actions">
          ${sdk.available ? `<a class="button primary" href="${SDK_URL}/download" download>${icon('export', 15)} Download</a>` : ''}
          ${canUpload ? `<label class="button" for="sdk-file">${icon('plus', 14)} ${sdk.available ? 'Replace package' : 'Upload package'}</label><input id="sdk-file" type="file" accept=".unitypackage" hidden>${sdk.available ? '<button type="button" class="button danger-text" data-sdk-remove>Remove</button>' : ''}` : ''}
        </div>
      </div>`;
    const fail = problem => { root.querySelector('.error').textContent = problem.message; };
    root.querySelector('#sdk-file')?.addEventListener('change', async event => {
      const file = event.target.files[0]; if (!file) return;
      const version = root.querySelector('#sdk-version').value.trim();
      try {
        await request(`${SDK_URL}?version=${encodeURIComponent(version)}`, {method: 'PUT', body: file, headers: {'Content-Type': 'application/octet-stream'}});
        toast('Unity SDK package uploaded.'); await draw();
      } catch (problem) { fail(problem); }
    });
    root.querySelector('[data-sdk-remove]')?.addEventListener('click', async () => {
      confirmDialog('Remove the Unity SDK package?', 'Nobody can download it until you upload one again. Games that already use the SDK are not affected.', 'Remove package', async () => { await request(SDK_URL, {method: 'DELETE'}); toast('Package removed.'); await draw(); });
    });
  };
  try { await draw(); } catch (problem) { root.innerHTML = `<div class="panel-body"><p class="error">${escapeHTML(problem.message)}</p></div>`; }
}

// A download button for the Event setup page; empty until a package has been uploaded.
async function sdkDownloadButton() {
  try {
    const sdk = await request(SDK_URL);
    return sdk.available ? `<a class="button" href="${SDK_URL}/download" download>${icon('export', 15)} Download Unity SDK${sdk.version ? ` ${escapeHTML(sdk.version)}` : ''}</a>` : '';
  } catch { return ''; }
}
