import { createFileRoute, redirect } from '@tanstack/react-router';

// Pricing no longer has its own page (an extra hop hurts conversion); old links 301 to the home page pricing section. The dialog is in ~/site/pricing.
export const Route = createFileRoute('/pricing')({
  beforeLoad: () => {
    throw redirect({ to: '/', hash: 'pricing', statusCode: 301 });
  },
});
