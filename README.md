# Curaprox Product Registration

Shopify **Customer Account UI extension** for Hydrosonic warranty registration.
Adds a full page to the customer's **My Account** where a buyer can register a
Hydrosonic device (extending its warranty to 3 years) and see their own past
registrations. Data is stored in the AICO backend, not in Shopify.

Extension-only app — no App Bridge, no Direct API, no metaobjects. The extension
talks to the AICO warranty API over `fetch()` with a Shopify session token.

## Extension

Single extension: [`extensions/warranty-registration`](./extensions/warranty-registration).

- **Target:** `customer-account.page.render` (full page, addable to the account nav menu).
- **Stack:** Preact + Shopify web components (`s-*`), API version `2026-04`.
- **Capabilities:** `network_access = true` (calls the AICO backend), `api_access = false` (no Storefront/Admin API from the extension).
- **UI:** `src/WarrantyPage.jsx` — registration form (Name, Hydrosonic model, serial, purchase date, store, invoice upload) + list of the buyer's own registrations.
- **i18n:** `locales/{en.default,de,fr,it}.json`. English is the default/fallback (covers UAE). Language is buyer-driven, independent of market.

## Backend contract

The extension gets a session token via `await shopify.sessionToken.get()` and sends
it as `Authorization: Bearer <token>` to the AICO backend (`Modules/Warranty`):

- `GET  /api/shopify/warranty-registrations` — the buyer's own registrations.
- `POST /api/shopify/warranty-registrations` — register a product (multipart: name, hydrosonic_model, serial_number, purchase_date, store, invoice file).

The buyer's **email** and the store's **market (CH/UAE)** are derived server-side
from the verified shop — the extension never sends them. One app is installed on
both the CH/Europe and UAE stores; the backend distinguishes them by verified shop.

The backend base URL is set in `src/WarrantyPage.jsx` (`AICO_API_ORIGIN`).

## Development

```shell
shopify app dev
```

Requires:
- The store on the **new customer accounts** experience (legacy accounts won't render the extension).
- The extension added to the account nav: Admin → **Settings → Customer accounts → Customize** → add the `warranty-registration` page to the menu.
- A reachable `AICO_API_ORIGIN` (local backend exposed via tunnel, or a staging URL).

## Deploy

```shell
shopify app deploy
```

Deploys the extension to the app's released version so it can be placed in the
customer-account editor on each store.
