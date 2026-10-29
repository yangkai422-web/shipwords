import { defineSite } from '@shipwords/core/site';

// FaceRiff: meme video generator. First meme: Tiny Desk AI (adapted from sites/tinydeskai-example).
// All config for this site. Price amounts are in the smallest currency unit (cents). Never change ids after launch.
// Same flow as competing sites: sign in, then buy, then generate. No guest trial and no sign-up bonus.
export default defineSite({
  id: 'faceriff',
  name: 'FaceRiff',
  url: 'https://faceriff.com',
  locales: ['en'],
  defaultLocale: 'en',
  // Same price for 1–5 people; one video = 10 credits. Each video costs about $3.06 upstream (Kling 4.0, 720p, one run).
  products: [
    {
      id: 'video_1',
      kind: 'credits',
      name: '1 video',
      price: { amount: 998, currency: 'usd' },
      credits: 10,
      expiresDays: null,
    },
    {
      id: 'video_3',
      kind: 'credits',
      name: '3 videos',
      price: { amount: 2499, currency: 'usd' },
      credits: 30,
      expiresDays: null,
    },
    {
      id: 'video_10',
      kind: 'credits',
      name: '10 videos',
      price: { amount: 5999, currency: 'usd' },
      credits: 100,
      expiresDays: null,
    },
  ],
  signup: { bonusCredits: 0, bonusExpiresDays: null, bonusPerIpDaily: 0 },
  guest: { dailyPerDevice: 0, dailyPerIp: 0, dailySiteBudget: 0, minRecaptchaScore: 0.5 },
  billing: { provider: 'paypal' },
  analytics: {},
});
