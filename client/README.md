# ProjectInvoice (Client)

This is the **frontend** for ProjectInvoice, built with **React + Vite**.

It is designed to be deployed as a **static site** (no Node/Express web service needed). The app talks to a separate backend API.

## Requirements

- Node.js 18+ recommended

## Run locally

```bash
npm install
npm run dev
```

## Configure the API base URL

Create a `.env` file (see `.env.example`) and set:

```bash
VITE_API_BASE_URL=https://api.yourdomain.com
```

- Use the backend **origin** only (no trailing slash).
- The UI will call endpoints like `/api/plan`, so the final request becomes:
  `https://api.yourdomain.com/api/plan`

## Build (static)

```bash
npm run build
```

Vite outputs a static bundle in `dist/`.

To preview the production build locally:

```bash
npm run preview
```

## Deploy

Deploy the contents of `dist/` to any static host (Vercel static, Netlify, Cloudflare Pages, S3/CloudFront, etc.).

If you use client-side routing, ensure your host rewrites all routes to `index.html`.
