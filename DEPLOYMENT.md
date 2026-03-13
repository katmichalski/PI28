# Deployment Guide (Vercel)

## Vercel Settings
- Framework: Vite
- Build Command: npm run build
- Output Directory: dist

## SPA Routing
`vercel.json` rewrites all routes to `/` so React Router can handle client-side navigation.

## Env Vars
Only vars prefixed with `VITE_` are exposed to the client bundle.
Use `.env.local` for local dev and Vercel Environment Variables for Preview/Production.

## Troubleshooting
- If deep links 404 → confirm `vercel.json` rewrites.
- If PDF worker fails → ensure `GlobalWorkerOptions.workerSrc` is set using a `?url` worker import.


# Deployment (Vercel)

This repo contains:
- client/ (Vite + React)
- server/ (Express API)

## Frontend (client/)
Create a Vercel Project with:
- Root Directory: client
- Build Command: npm run build
- Output Directory: dist

SPA routing is handled via client/vercel.json rewrites.

## API (server/)
Create a second Vercel Project with:
- Root Directory: server

The Express app must export the Express `app` for Vercel.

## Environment Variables
Frontend:
- VITE_API_BASE_URL = https://<your-api-project>.vercel.app
