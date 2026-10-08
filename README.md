# Cookbook template

This is a white-label family cookbook. Lisa's Recipe Book is the default book. A second book, Demo Cookbook, is already configured for `demo.` subdomains.

Names, colors, the canonical hostname, and which payment desk is turned on live in `shared/brand-config.js`. Run `npm run emit-config` after you change the default book so `public/config.js` matches.

```bash
npm start
npm test
```

The book listens on port 4173. Pages are deployed from `public/` to the Cloudflare Pages project named in the config (`lisas-recipe-book`). The API on Cloudflare is `functions/`.

## A new book

Add a tenant in `shared/brand-config.js` with its own `brand`, `theme`, `hosts`, `payments`, and `locations`. A hostname whose first label matches a tenant id, such as `demo.example.com`, opens that book. Accounts, messages, and plates a cook adds stay on that book. The shared sample plates stay readable everywhere.

`setup: "admins"` only lets the emails in `adminEmails` change the name, colors, and custom domain from Book setup. `setup: "members"` lets any signed-in cook of that book do it. Lisa's book is locked to admins, and the admin list starts empty.

Point a custom domain at the Pages project, then save that hostname in Book setup. The book stores the hostname only. It does not create DNS records.

## Payments

Square and Cash App are separate switches on each book. Checkout needs a signed-in cook. Card numbers are never sent to this app.

- Square uses `SQUARE_ACCESS_TOKEN` and `SQUARE_LOCATION_ID`. `SQUARE_WEBHOOK_SIGNATURE_KEY` verifies `POST /api/payments/webhook/square`. Sandbox is the default. Set the portal `environment` to `production` only when you mean to.
- Cash App uses a public `$cashtag` on the portal, or `CASHAPP_CASHTAG`. The book opens `https://cash.app/$cashtag/amount`. `CASHAPP_WEBHOOK_SECRET` verifies `POST /api/payments/webhook/cashapp` (`x-cookbook-signature`, hex HMAC-SHA256 of the raw body).

## Place

`GET /api/location/menu` maps a coarse latitude and longitude to a region and returns cuisines and menu sections. It does not store the pin. The page asks for the device place only after permission is already granted, or when someone taps “Use this kitchen's place.”
