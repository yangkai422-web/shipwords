import type { ReactNode } from 'react';
import { m } from '~/paraglide/messages.js';

// Shared layout for the privacy, terms, refund and DMCA pages: long poster-paper card (DESIGN.md "Content pages").
// The contact address forwards to the support inbox via Email Routing (README).
// The policy date is common_legal_policy_date in messages/common; update both en and zh when a policy changes.

export const SUPPORT_EMAIL = 'support@faceriff.com';

export function LegalPage({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <article className="sheet legal">
      <h1>{title}</h1>
      <p className="muted mono">{m.common_legal_updated({ date: m.common_legal_policy_date() })}</p>
      <p className="legal-intro">{intro}</p>
      {children}
      <p className="legal-contact">
        {m.common_legal_questions()} <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    </article>
  );
}
