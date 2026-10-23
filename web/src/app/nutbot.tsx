// NutBot, the assistant every AVN tool shares. The shell shows its launcher and the Ctrl+J shortcut;
// the panel itself lives in src/pages/nutbot (see assistant.md in the avn-ux skill).
import { createContext, useCallback, useContext, useMemo, useState, type ReactElement, type ReactNode } from 'react';

type NutBot = { open: boolean; setOpen: (open: boolean) => void; toggle: () => void; /** False until the server says the assistant can be used on this page. */ usable: boolean; setUsable: (usable: boolean) => void; ask: (text: string) => void; pending: string | null; takePending: () => string | null };
const NutBotContext = createContext<NutBot | null>(null);

export function NutBotProvider({ children }: { children: ReactNode }): ReactElement {
  const [open, setOpen] = useState(false);
  const [usable, setUsable] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const ask = useCallback((text: string) => { setPending(text); setOpen(true); }, []);
  const takePending = useCallback(() => { const text = pending; setPending(null); return text; }, [pending]);
  const value = useMemo(() => ({ open, setOpen, toggle, usable, setUsable, ask, pending, takePending }), [open, toggle, usable, ask, pending, takePending]);
  return <NutBotContext.Provider value={value}>{children}</NutBotContext.Provider>;
}

export function useNutBot(): NutBot {
  const value = useContext(NutBotContext);
  if (!value) throw new Error('useNutBot must be used inside <NutBotProvider>');
  return value;
}
