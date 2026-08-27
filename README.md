This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

1. **Import** [github.com/savindushenal/supportchat](https://github.com/savindushenal/supportchat) in [Vercel → New Project](https://vercel.com/new).
2. **Framework Preset** must be **Next.js** (not “Other”). Leave **Output Directory** empty.
3. **Root Directory** = `.` (repo root).
4. Add **Environment Variables** from `.env.example` (Production + Preview). Set `NEXT_PUBLIC_APP_URL` to your Vercel URL, e.g. `https://your-project.vercel.app`.
5. Click **Deploy** and wait until status is **Ready**.
6. Open the **Production** URL from the Deployments tab — do not guess the URL.

If you see `404: NOT_FOUND` with `Code: NOT_FOUND`, Vercel has **no deployment at that URL** (wrong link, deleted deploy, or build failed). Check **Deployments → Build Logs** and redeploy.

Check out [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
