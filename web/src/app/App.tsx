import { StrictMode, type ReactElement } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { MotionConfig } from 'motion/react';
import { DefinitionGroup, ToastProvider } from '@avn/ui';
import { queryClient } from '@/api';
import { router } from './router';
import { SessionProvider } from './session';
import { NutBotProvider } from './nutbot';
import { Skeleton, LoadError } from '@/components/feedback';
import { BootScreen } from '@/components/flavour';
import { errorStatus } from '@/api';

function Boot({ children }: { children?: ReactElement }): ReactElement {
  return <main id="main" className="boot-loading">{children ?? <><Skeleton kind="stats" /><Skeleton rows={8} /></>}</main>;
}

export function App(): ReactElement {
  return (
    <StrictMode>
      <MotionConfig reducedMotion="user">
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <BootScreen />
          <SessionProvider
            loading={<Boot />}
            failed={(error, retry) => {
              const denied = [401, 403].includes(errorStatus(error));
              return <Boot><div className="boot"><span className="brand-mark">avn.</span><h1>{denied ? 'You don’t have access yet.' : 'Couldn’t open your workspace.'}</h1><LoadError error={error} onRetry={retry} /></div></Boot>;
            }}
          >
            <NutBotProvider><DefinitionGroup><RouterProvider router={router} /></DefinitionGroup></NutBotProvider>
          </SessionProvider>
        </ToastProvider>
      </QueryClientProvider>
      </MotionConfig>
    </StrictMode>
  );
}
