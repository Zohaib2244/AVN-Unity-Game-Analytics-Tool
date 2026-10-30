// A copy icon that confirms success in place, without a toast.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Button } from '@avn/ui';
import { Ico } from '@/components/icons';
import { useNotify } from '@/components/feedback';
import { copyText } from '@/lib/store';

export function CopyButton({ text, label, done }: { text: string; label: string; done: string }): ReactElement {
  const { toast } = useNotify();
  const reducedMotion = useReducedMotion();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    if (!(await copyText(text))) { toast('Select the text and copy it manually.'); return; }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <Button variant="ghost" size="sm" className={copied ? 'copy-done' : undefined} aria-label={copied ? 'Copied' : label} title={copied ? 'Copied' : label} onClick={() => void copy()}>
      <motion.span key={copied ? 'copied' : 'copy'} className="copy-icon" initial={reducedMotion ? false : { opacity: 0, scale: 0.75 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: reducedMotion ? 0 : 0.16 }}>
        <Ico name={copied ? 'check' : 'copy'} size={16} />
      </motion.span>
      <span className="sr-only" role="status">{copied ? done : ''}</span>
    </Button>
  );
}
