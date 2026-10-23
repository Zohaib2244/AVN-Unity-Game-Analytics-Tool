// The Unity SDK package shipped with the app, offered on the Settings page and next to the setup files on
// Event setup.
import type { ReactElement } from 'react';
import { useRead } from '@/api';
import { fileSize } from '@/lib/format';
import type { SdkInfo } from '@/lib/types';
import { QueryRegion, Skeleton } from '@/components/feedback';
import { Ico } from '@/components/icons';

export const SDK_URL = '/v1/sdk';

export function SdkPanel(): ReactElement {
  const query = useRead<SdkInfo>(SDK_URL);
  return (
    <section className="panel" id="sdk-panel">
      <QueryRegion query={query} path={SDK_URL} skeleton={<Skeleton rows={3} columns={2} />} note={false}>{(sdk) => (
        <>
          <div className="panel-header"><div><h2>Unity SDK</h2><p>The package every game imports, shared by all games on this server.</p></div><Ico name="export" size={17} /></div>
          <div className="panel-body">
            <ul className="status-list">
              <li><span>File</span><strong><code>{sdk.filename}</code></strong></li>
              <li><span>Size</span><strong>{fileSize(sdk.size)}</strong></li>
              <li><span>SHA-256</span><strong><code title={sdk.sha256}>{sdk.sha256.slice(0, 12)}…</code></strong></li>
            </ul>
            <div className="sdk-actions"><a className="button primary" href={`${SDK_URL}/download`} download><Ico name="export" size={15} /> Download</a></div>
          </div>
        </>
      )}</QueryRegion>
    </section>
  );
}

/** The plain download link other pages (Event setup) put next to their files. */
export const SdkDownloadButton = (): ReactElement => <a className="button" href={`${SDK_URL}/download`} download><Ico name="export" size={15} /> Download Unity SDK</a>;
