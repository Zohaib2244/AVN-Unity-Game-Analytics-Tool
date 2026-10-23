import type { ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import { Heading } from '@/components/feedback';

export function NotFoundPage(): ReactElement {
  return <><Heading title="Page not found" subtitle="This page or game isn’t in your workspace." /><Link className="button" to="/">Back to games</Link></>;
}
