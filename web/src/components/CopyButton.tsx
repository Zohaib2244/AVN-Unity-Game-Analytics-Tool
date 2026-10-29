// A copy icon that confirms itself: the icon turns into a tick for a moment and a toast says what was copied.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Button } from '@avn/ui';
import { Ico } from '@/components/icons';
import { useNotify } from '@/components/feedback';
import { copyText } from '@/lib/store';

export function CopyButton({ text, label, done }: { text: string; label: string; done: string }): ReactElement {
  const { toast } = useNotify();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    if (!(await copyText(text))) { toast('Select the text and copy it manually.'); return; }
    setCopied(true); toast(done);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <Button variant="ghost" size="sm" className={copied ? 'copy-done' : undefined} aria-label={copied ? 'Copied' : label} title={copied ? 'Copied' : label} onClick={() => void copy()}>
      <Ico name={copied ? 'check' : 'copy'} size={16} />
    </Button>
  );
}
