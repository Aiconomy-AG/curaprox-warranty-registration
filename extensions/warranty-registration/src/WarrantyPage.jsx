import '@shopify/ui-extensions/preact';
import {useTranslate, useLanguage} from '@shopify/ui-extensions/customer-account/preact';
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';

/**
 * Hydrosonic warranty registration — customer account My-Account page.
 *
 * Talks to the AICO backend (Modules/Warranty):
 *   GET  /api/shopify/warranty-registrations  -> the customer's own registrations
 *   POST /api/shopify/warranty-registrations  -> register a product (multipart, incl. invoice)
 *
 * Auth: the Shopify session token as `Authorization: Bearer <token>`. The backend
 * derives the customer id from the token — we never send it.
 */

// Public HTTPS origin of the AICO backend. Shopify's extension sandbox can't
// reach 127.0.0.1, so local sail is exposed via a cloudflared quick tunnel.
// NOTE: quick-tunnel URLs are ephemeral — if the tunnel restarts, update this.
const AICO_API_ORIGIN = 'https://aicoapp.aico.swiss/83641';
const REGISTRATIONS_PATH = '/api/shopify/warranty-registrations';

// This one extension build is installed on both stores (Switzerland/Europe and
// UAE). The customer-account page can't read its own shop at runtime, so market
// is NOT set here — the backend derives it from the verified shop domain and
// both stamps new rows and scopes the list with it, so a store only ever shows
// its own region's registrations.
//
// The customer name and email are likewise not collected here — registration is
// logged-in-only, so the backend reads both from the authenticated Shopify
// account behind the session token. The form carries only the fields agreed in
// the August scope: model, serial, purchase date, store and the invoice.

const EMPTY_FORM = {
    hydrosonic_model: '',
    purchase_date: '',
    store: '',
    serial_number: '',
};

// Same fixed format the backend enforces (e.g. PU00052): two letters + five
// digits. Checked client-side so a malformed serial gets an inline hint before
// the round-trip; the backend regex stays the source of truth.
const SERIAL_PATTERN = /^[A-Z]{2}\d{5}$/;

// True when a 'YYYY-MM-DD' value is after today (local). Mirrors the backend's
// `before_or_equal:today` rule so a future purchase date gets an inline hint.
function isFutureDate(value) {
    const [year, month, day] = String(value).split('-').map(Number);
    if (!year || !month || !day) return false;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return new Date(year, month - 1, day) > today;
}

// Map a backend JSON:API 422 body to per-field translation keys. The backend
// returns { errors: [{ source: { pointer }, detail }, ...] }; FormRequest
// failures key the pointer by the snake_case field. We match on the field token
// (pointer or detail) so the mapping survives either a pointer- or
// parameter-shaped error, and fall back to nothing for non-field errors (e.g.
// market/customerEmail config problems), which the caller shows as a generic
// banner.
function fieldErrorsFrom422(json) {
    const errors = Array.isArray(json?.errors) ? json.errors : [];
    const out = {};
    for (const error of errors) {
        const source = error?.source ?? {};
        const haystack = `${source.pointer ?? source.parameter ?? ''} ${error?.detail ?? ''}`.toLowerCase();
        if (haystack.includes('serial')) out.serial_number = 'error.field.serialFormat';
            // The client blocks empty dates before submit, so a server date error is a
        // future purchase date (the only other thing the backend rejects).
        else if (haystack.includes('purchase') || haystack.includes('date')) out.purchase_date = 'error.field.dateFuture';
        else if (haystack.includes('invoice')) out.invoice = 'error.field.invoice';
        else if (haystack.includes('store')) out.store = 'error.field.store';
        else if (haystack.includes('model')) out.hydrosonic_model = 'error.field.model';
    }
    return out;
}

// The backend returns purchase_date + warranty_end but not the warranty term or
// an active/expired flag — both are derived here from those dates so the card
// badge ("Active · 3-year warranty") needs no extra backend field. A Shopify
// registration extends cover to 3 years; a migrated 2-year row shows 2.
function warrantyTermYears(purchaseDate, warrantyEnd) {
    const start = new Date(purchaseDate).getTime();
    const end = new Date(warrantyEnd).getTime();
    if (Number.isNaN(start) || Number.isNaN(end)) return null;
    return Math.round((end - start) / (365.25 * 24 * 60 * 60 * 1000));
}

function isWarrantyActive(warrantyEnd) {
    const end = new Date(warrantyEnd).getTime();
    if (Number.isNaN(end)) return false;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return end >= today;
}

// '2024-01-12' / ISO datetime -> '12 Jan 2024', localized to the buyer language.
// Falls back to the raw value if the date can't be parsed.
function formatDate(value, locale) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value ?? '';
    try {
        return new Intl.DateTimeFormat(locale || undefined, {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
        }).format(date);
    } catch (_e) {
        return String(value);
    }
}

export default async () => {
    render(<WarrantyPage/>, document.body);
};

async function authHeader() {
    const token = await shopify.sessionToken.get();
    return {Authorization: `Bearer ${token}`};
}

function WarrantyPage() {
    const translate = useTranslate();

    const [loading, setLoading] = useState(true);
    const [items, setItems] = useState([]);
    const [loadError, setLoadError] = useState(false);

    const [form, setForm] = useState({...EMPTY_FORM});
    const [invoice, setInvoice] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    // Holds a translation key (not a literal) so the message re-renders in the
    // buyer's current language.
    const [formErrorKey, setFormErrorKey] = useState(null);
    // Per-field translation keys, keyed by the backend field name (snake_case).
    const [fieldErrors, setFieldErrors] = useState({});
    const [success, setSuccess] = useState(false);
    // The registration form is hidden until the buyer taps "New device".
    const [showForm, setShowForm] = useState(false);

    const fieldError = (name) => (fieldErrors[name] ? translate(fieldErrors[name]) : undefined);

    function openForm() {
        setSuccess(false);
        setFormErrorKey(null);
        setFieldErrors({});
        setShowForm(true);
    }

    function closeForm() {
        setForm({...EMPTY_FORM});
        setInvoice(null);
        setFormErrorKey(null);
        setFieldErrors({});
        setShowForm(false);
    }

    async function loadRegistrations() {
        setLoading(true);
        setLoadError(false);
        try {
            const res = await fetch(AICO_API_ORIGIN + REGISTRATIONS_PATH, {
                headers: {...(await authHeader()), Accept: 'application/json'},
            });
            if (!res.ok) throw new Error(String(res.status));
            const json = await res.json();
            setItems(Array.isArray(json.data) ? json.data : []);
        } catch (_e) {
            setLoadError(true);
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        loadRegistrations();
    }, []);

    const bind = (field) => (event) =>
        setForm((prev) => ({...prev, [field]: event.currentTarget.value}));

    async function onSubmit(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        setFormErrorKey(null);
        setSuccess(false);
        setFieldErrors({});

        // Client-side validation mirrors the backend rules so the buyer sees the
        // exact field(s) at fault before the round-trip.
        const clientErrors = {};
        if (!form.hydrosonic_model.trim()) clientErrors.hydrosonic_model = 'error.field.model';
        if (!form.serial_number.trim()) clientErrors.serial_number = 'error.field.serialRequired';
        else if (!SERIAL_PATTERN.test(form.serial_number.trim())) clientErrors.serial_number = 'error.field.serialFormat';
        if (!form.purchase_date) clientErrors.purchase_date = 'error.field.date';
        else if (isFutureDate(form.purchase_date)) clientErrors.purchase_date = 'error.field.dateFuture';
        if (!form.store.trim()) clientErrors.store = 'error.field.store';
        if (!invoice) clientErrors.invoice = 'error.field.invoice';

        if (Object.keys(clientErrors).length) {
            // Inline per-field errors are self-explanatory — no summary banner.
            setFieldErrors(clientErrors);
            return;
        }

        setSubmitting(true);
        try {
            const body = new FormData();
            Object.entries(form).forEach(([key, value]) => body.append(key, value));
            body.append('invoice', invoice);

            const res = await fetch(AICO_API_ORIGIN + REGISTRATIONS_PATH, {
                method: 'POST',
                headers: await authHeader(), // no Content-Type: browser sets the multipart boundary
                body,
            });

            if (res.status === 201) {
                setSuccess(true);
                setForm({...EMPTY_FORM});
                setInvoice(null);
                setShowForm(false);
                await loadRegistrations();
            } else if (res.status === 422) {
                const json = await res.json().catch(() => null);
                const serverFieldErrors = fieldErrorsFrom422(json);
                if (Object.keys(serverFieldErrors).length) {
                    setFieldErrors(serverFieldErrors);
                } else {
                    // 422 with no field we render (e.g. store misconfigured server-side).
                    setFormErrorKey('error.generic');
                }
            } else if (res.status === 401) {
                setFormErrorKey('error.sessionExpired');
            } else {
                setFormErrorKey('error.generic');
            }
        } catch (_e) {
            setFormErrorKey('error.network');
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <s-page heading={showForm ? translate('page.heading') : undefined}>
            <s-stack direction="block" gap="large">
                {success && (
                    <s-banner tone="success">
                        <s-text>{translate('success')}</s-text>
                    </s-banner>
                )}

                {showForm && (
                    <s-section heading={translate('register.heading')}>
                        {formErrorKey && (
                            <s-banner tone="critical">
                                <s-text>{translate(formErrorKey)}</s-text>
                            </s-banner>
                        )}

                        <s-form onSubmit={onSubmit}>
                            <s-stack direction="block" gap="base">
                                <s-text-field
                                    label={translate('field.model')}
                                    name="hydrosonic_model"
                                    value={form.hydrosonic_model}
                                    onInput={bind('hydrosonic_model')}
                                    error={fieldError('hydrosonic_model')}
                                    required
                                />
                                <s-text-field
                                    label={translate('field.serial')}
                                    name="serial_number"
                                    placeholder="PU00052"
                                    value={form.serial_number}
                                    onInput={bind('serial_number')}
                                    error={fieldError('serial_number')}
                                    required
                                />
                                <s-date-field
                                    label={translate('field.purchaseDate')}
                                    name="purchase_date"
                                    value={form.purchase_date}
                                    onInput={bind('purchase_date')}
                                    error={fieldError('purchase_date')}
                                    required
                                />
                                <s-text-field
                                    label={translate('field.store')}
                                    name="store"
                                    value={form.store}
                                    onInput={bind('store')}
                                    error={fieldError('store')}
                                    required
                                />
                                <s-drop-zone
                                    name="invoice"
                                    accept=".pdf,.jpg,.jpeg,.png"
                                    label={invoice ? invoice.name : translate('dropzone.prompt')}
                                    error={fieldError('invoice')}
                                    required
                                    onChange={(event) => {
                                        const el = /** @type {{files?: readonly File[]}} */ (event.currentTarget);
                                        setInvoice(el.files?.[0] ?? null);
                                    }}
                                />

                                <s-stack direction="inline" gap="base">
                                    <s-button type="submit" variant="primary" disabled={submitting}>
                                        {submitting ? translate('register.submitting') : translate('register.submit')}
                                    </s-button>
                                    <s-button variant="secondary" disabled={submitting} onClick={closeForm}>
                                        {translate('register.cancel')}
                                    </s-button>
                                </s-stack>
                            </s-stack>
                        </s-form>
                    </s-section>
                )}

                <RegistrationsList
                    loading={loading}
                    error={loadError}
                    items={items}
                    onRetry={loadRegistrations}
                    onNewDevice={openForm}
                    formOpen={showForm}
                />
            </s-stack>
        </s-page>
    );
}

function RegistrationsList({loading, error, items, onRetry, onNewDevice, formOpen}) {
    const translate = useTranslate();
    const locale = useLanguage()?.isoCode;
    const heading = translate('list.heading');

    const header = (
        <s-stack direction="inline" gap="base" justifyContent="space-between" alignItems="center">
            <s-stack direction="block" gap="none">
                <s-heading>{heading}</s-heading>
                {!loading && !error && (
                    <s-text color="subdued">{translate('list.count', {count: items.length})}</s-text>
                )}
            </s-stack>
            <s-button variant="primary" disabled={formOpen} onClick={onNewDevice}>
                {translate('list.newDevice')}
            </s-button>
        </s-stack>
    );

    let body;
    if (loading) {
        body = <s-spinner accessibilityLabel={translate('list.loading')}/>;
    } else if (error) {
        body = (
            <s-banner tone="critical">
                <s-stack direction="block" gap="base">
                    <s-text>{translate('list.error')}</s-text>
                    <s-button onClick={onRetry}>{translate('list.retry')}</s-button>
                </s-stack>
            </s-banner>
        );
    } else if (!items.length) {
        body = <s-paragraph>{translate('list.empty')}</s-paragraph>;
    } else {
        // A single faint container groups all products; individual cards inside are
        // separated by dividers rather than their own borders.
        body = (
            <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="base">
                    {items.map((item, index) => (
                        <s-stack key={item.id} direction="block" gap="base">
                            {index > 0 && <s-divider/>}
                            <RegistrationCard attributes={item.attributes || {}} locale={locale} translate={translate}/>
                        </s-stack>
                    ))}
                </s-stack>
            </s-box>
        );
    }

    return (
        <s-stack direction="block" gap="base">
            {header}
            {body}
            <s-banner tone="info">
                <s-text>
                    <s-text type="strong">{translate('coverage.title')}</s-text>
                    {translate('coverage.body')}
                </s-text>
            </s-banner>
        </s-stack>
    );
}

function RegistrationCard({attributes, locale, translate}) {
    const active = isWarrantyActive(attributes.warrantyEnd);
    const years = warrantyTermYears(attributes.purchaseDate, attributes.warrantyEnd);
    const statusKey = active ? 'list.status.active' : 'list.status.expired';

    return (
        <s-box paddingBlock="base">
            <s-stack direction="inline" gap="base" justifyContent="space-between" alignItems="start">
                <s-stack direction="inline" gap="base" alignItems="start">
                    <s-box padding="base" borderRadius="base" background="subdued">
                        <s-icon
                            type={active ? 'check-circle-filled' : 'x-circle'}
                            tone={active ? 'success' : 'critical'}
                            size="large"
                        />
                    </s-box>
                    <s-stack direction="block" gap="small-500">
                        <s-stack direction="inline" gap="small-500" alignItems="center">
                            <s-heading>{attributes.hydrosonicModel || translate('list.modelFallback')}</s-heading>
                            {attributes.source === 'prestashop_migration' && (
                                <s-badge tone="neutral">{translate('list.imported')}</s-badge>
                            )}
                        </s-stack>
                        <s-badge tone={active ? 'neutral' : 'critical'}>
                            {translate(statusKey, {years: years ?? '—'})}
                        </s-badge>
                        <s-text color="subdued">
                            {translate('list.serialRegistered', {
                                serial: attributes.serialNumber,
                                date: formatDate(attributes.createdAt, locale),
                            })}
                        </s-text>
                        <s-text color="subdued">
                            {translate('list.warrantyEnd', {value: formatDate(attributes.warrantyEnd, locale)})}
                        </s-text>
                    </s-stack>
                </s-stack>
                <s-stack direction="block" gap="small-500" alignItems="end">
                    {/* TEMP: warranty claim button hidden — restore before shipping */}
                    {false && <s-button variant="secondary" disabled={!active}>{translate('list.warrantyClaim')}</s-button>}
                    <s-text color="subdued">{translate('list.claimPlaceholder')}</s-text>
                </s-stack>
            </s-stack>
        </s-box>
    );
}
