// api/create-invoice.js
// Vercel Serverless Function (Node, zero-config) — Donald Scott NYC Scheren-Kampagne.
//
// Nimmt den Warenkorb + Kontaktdaten vom Frontend (scheren/index.html) entgegen,
// berechnet die Preise SERVERSEITIG neu (Schutz gegen Manipulation im Browser),
// legt einen Stripe-Kunden und eine Stripe-Rechnung an (Praefix "WEB-", 20 % AT-USt
// fix ueber die hinterlegte Tax Rate — keine Stripe-Tax-Automatik) und gibt den
// client_secret des zugehoerigen PaymentIntent zurueck, damit die Seite Apple Pay /
// Google Pay / Karte direkt eingebettet anzeigen kann (kein Verlassen der Seite).
//
// Braucht die Vercel-Umgebungsvariable STRIPE_SECRET_KEY (Restricted Key, rk_live_...).
// Das Secret steht NIRGENDS im Code — nur in process.env.
//
// WICHTIG: Die Modell-Liste unten ist eine Kopie der MODELS-Daten aus scheren/index.html.
// Aendert sich dort Sortiment/Preis/Rabattstatus, MUSS diese Kopie mitgezogen werden —
// sonst weichen Anzeige- und Rechnungspreis voneinander ab.

const TAX_RATE_ID = 'txr_1UBtutGamm77mtPPVKwqhS69'; // "USt AT 20% (WEB)", fix, exklusive

// id -> { n: Name, size, p: Salon-Brutto-Listenpreis (EUR), kein_rabatt: true wenn von den 10% ausgenommen }
const MODELS = {
  titan:    { n: 'Titan',          size: '6.0″',       p: 495, kein_rabatt: true },
  dama:     { n: 'Dama',           size: '6.0″',       p: 795, kein_rabatt: true },
  iconic:   { n: 'Iconic',         size: '6.0″',       p: 445 },
  twister:  { n: 'Twister',        size: '6.0″',       p: 445 },
  empire:   { n: 'Empire',         size: '7.0″',       p: 445 },
  finepro:  { n: 'Fine Pro',       size: '6.5″',       p: 375 },
  prime:    { n: 'Prime',          size: '6.0 / 6.5″',  p: 355 },
  aero:     { n: 'Aero',           size: '6.0″',       p: 355 },
  craftpro: { n: 'Craft Pro',      size: '6.2″',       p: 375 },
  rawpro:   { n: 'Raw Pro',        size: '6.0″',       p: 375 },
  precise:  { n: 'Precise',        size: '5.0″',       p: 295 },
  dsarc:    { n: 'DS Arc',         size: '7.5″',       p: 295 },
  fade:     { n: 'Fade',           size: '6.0″',       p: 395 },
  shark:    { n: 'Shark',          size: '6.0″',       p: 395 },
  feather:  { n: 'Feather',        size: '6.0″',       p: 375 },
  texture:  { n: 'Texture',        size: '6.0″',       p: 325 },
  lefty:    { n: 'Lefty',          size: '6.0″',       p: 355 },
  leftytc:  { n: 'Lefty Texture',  size: '6.0″',       p: 325 },
};

// Salon-Netto nach 10 % Aktionsrabatt — identische Formel wie akt() im Frontend.
function akt(m) {
  return m.kein_rabatt ? m.p : Math.round(m.p * 0.9 * 100) / 100;
}

const STRIPE_API = 'https://api.stripe.com/v1';

async function stripeCall(path, params, method = 'POST') {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY fehlt in der Vercel-Umgebung');
  }
  const opts = {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(key + ':').toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  };
  let url = `${STRIPE_API}/${path}`;
  if (params) {
    const body = new URLSearchParams(params).toString();
    if (method === 'GET') {
      url += '?' + body;
    } else {
      opts.body = body;
    }
  }
  const r = await fetch(url, opts);
  const data = await r.json();
  if (!r.ok) {
    const msg = data && data.error ? data.error.message : `Stripe-Fehler (${r.status})`;
    const err = new Error(msg);
    err.stripe = data;
    throw err;
  }
  return data;
}

// Baut die x-www-form-urlencoded-Parameter fuer verschachtelte Felder wie address[line1].
function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === 'object') flatten(item, `${key}[${i}]`, out);
        else out[`${key}[${i}]`] = item;
      });
    } else if (typeof v === 'object') {
      flatten(v, key, out);
    } else {
      out[key] = v;
    }
  }
  return out;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Nur POST erlaubt.' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const cart = body.cart || {};
    const vorname = (body.vorname || '').trim();
    const nachname = (body.nachname || '').trim();
    const adresse = (body.adresse || '').trim();
    const salon = (body.salon || '').trim();
    const tel = (body.tel || '').trim();
    const gravur = (body.gravur || '').trim();
    const msg = (body.msg || '').trim();

    if (!vorname || !nachname || !adresse || !salon) {
      res.status(400).json({ error: 'Vorname, Nachname, Adresse und Salon sind Pflichtfelder.' });
      return;
    }

    const ids = Object.keys(cart).filter((id) => Number(cart[id]) > 0);
    if (!ids.length) {
      res.status(400).json({ error: 'Der Warenkorb ist leer.' });
      return;
    }

    const lines = [];
    for (const id of ids) {
      const m = MODELS[id];
      const qty = Math.floor(Number(cart[id]));
      if (!m || !Number.isFinite(qty) || qty < 1 || qty > 50) {
        res.status(400).json({ error: `Ungueltige Position im Warenkorb: ${id}` });
        return;
      }
      lines.push({ id, m, qty, unitPrice: akt(m) });
    }

    // 1) Kunde anlegen (kein gespeicherter Kunde/E-Mail vorhanden — bewusst pro Bestellung neu,
    //    das Formular fragt keine E-Mail ab).
    const customerParams = flatten(
      {
        name: `${vorname} ${nachname}`,
        phone: tel || undefined,
        description: `Salon: ${salon}`,
        address: { line1: adresse },
        metadata: {
          quelle: 'scheren-kampagne',
          salon,
          gravur: gravur || undefined,
          nachricht: msg || undefined,
        },
      },
      '',
      {}
    );
    const customer = await stripeCall('customers', customerParams);

    // 2) Rechnung zuerst als Entwurf anlegen — Praefix WEB- kommt aus den Konto-
    //    Einstellungen, keine Stripe-Tax-Automatik.
    const invoiceParams = flatten(
      {
        customer: customer.id,
        currency: 'eur',
        collection_method: 'charge_automatically',
        auto_advance: 'false',
        description: 'Scheren-Bestellung — Donald Scott NYC',
        'automatic_tax[enabled]': 'false',
        metadata: {
          quelle: 'scheren-kampagne',
          salon,
          gravur: gravur || undefined,
          nachricht: msg || undefined,
        },
      },
      '',
      {}
    );
    const invoice = await stripeCall('invoices', invoiceParams);

    // 3) Je Warenkorb-Position eine Invoice-Item DIREKT an diese Rechnung haengen
    //    (explizit ueber invoice=..., nicht ueber automatisches Einsammeln offener
    //    Positionen — das war in Tests nicht zuverlaessig).
    for (const line of lines) {
      const params = flatten(
        {
          customer: customer.id,
          invoice: invoice.id,
          currency: 'eur',
          unit_amount: Math.round(line.unitPrice * 100),
          quantity: line.qty,
          description: `${line.m.n} ${line.m.size}${line.m.kein_rabatt ? ' (Neuheit, ohne Aktionsrabatt)' : ''}`,
          'tax_rates[0]': TAX_RATE_ID,
        },
        '',
        {}
      );
      await stripeCall('invoiceitems', params);
    }

    // 4) Finalisieren — erzeugt den PaymentIntent zur Gesamtsumme.
    const finalized = await stripeCall(
      `invoices/${invoice.id}/finalize`,
      { 'expand[0]': 'payment_intent' }
    );

    if (!finalized.payment_intent || !finalized.payment_intent.client_secret) {
      throw new Error('Stripe hat keinen PaymentIntent zur Rechnung geliefert.');
    }

    res.status(200).json({
      clientSecret: finalized.payment_intent.client_secret,
      invoiceId: finalized.id,
      invoiceNumber: finalized.number,
      amountTotal: finalized.amount_due,
      hostedInvoiceUrl: finalized.hosted_invoice_url,
    });
  } catch (err) {
    console.error('create-invoice fehlgeschlagen:', err.message, err.stripe || '');
    res.status(500).json({ error: 'Die Zahlung konnte nicht vorbereitet werden. Bitte per WhatsApp bestellen oder spaeter erneut versuchen.' });
  }
};
