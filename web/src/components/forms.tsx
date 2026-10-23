// Forms: one submit at a time, the button shows it is working, errors land in the form's alert line.
import { useCallback, useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import { errorMessage, isAbort } from '@/api/client';

export type Values = Record<string, string>;

/** `submit` receives the form's values; while it runs `busy` is true; a thrown error becomes `error`. */
export function useSubmit(submit: (values: Values, form: HTMLFormElement) => Promise<void> | void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const onSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const values = Object.fromEntries([...new FormData(form).entries()].map(([key, value]) => [key, typeof value === 'string' ? value : ''])) as Values;
    setError(''); setBusy(true);
    try { await submit(values, form); }
    catch (caught) { if (!isAbort(caught)) setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }, [busy, submit]);
  return { onSubmit, busy, error, setError };
}

export function FormError({ error }: { error: string }): ReactElement {
  return <div className="error" role="alert">{error}</div>;
}

export function Field({ label, htmlFor, help, children }: { label: ReactNode; htmlFor?: string; help?: ReactNode; children: ReactNode }): ReactElement {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {help ? <p>{help}</p> : null}
    </div>
  );
}
