import * as Sentry from '@sentry/nextjs';
import { scrubBreadcrumb, scrubEvent } from '@/lib/sentry/scrub';

/**
 * Sentry på klientsiden — nettleser OG WKWebView-en i iOS-appen.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FILNAVNET ER IKKE VALGFRITT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `sentry.client.config.ts` er en DØD fil i dette prosjektet. Next 16 bygger med
 * Turbopack, og SDK-en advarer selv: «When using Turbopack
 * sentry.client.config.ts will no longer work». Verdiinjeksjonen matcher
 * bokstavelig `instrumentation-client.(js|ts)`.
 *
 * Har du BEGGE filene, kalles Sentry.init() to ganger.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ HVORFOR HVER ENESTE dataCollection-NØKKEL ER SATT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Verifisert i node_modules/@sentry/core/.../resolveDataCollectionOptions.js:
 *
 *     const base = options.dataCollection != null
 *       ? DEFAULTS                                  // ← ALT er true
 *       : defaultPiiToCollectionOptions(sendDefaultPii);
 *     userInfo: dc.userInfo ?? base.userInfo        // ← uspesifisert = true
 *
 * Et DELVIS objekt slår altså PÅ cookies, headere, forespørselsinnhold,
 * query-parametere og databaseverdier. Skriver du `{ userInfo: false }` og tror
 * du har skrudd av innsamling, har du gjort det motsatte. Halvveis er verre enn
 * ingenting — derfor står alle elleve nøklene her.
 *
 * Dette er også grunnlaget for at App Privacy hos Apple kan si
 * «Diagnostics — Not Linked to You». Endrer du noe her, må erklæringen endres.
 */

/**
 * Hvilken plattform kjører vi på?
 *
 * Capacitor injiserer `window.Capacitor` som WKUserScript ved dokumentstart,
 * altså FØR denne fila kjører. Uten denne taggen er en feil fra iOS-appen umulig
 * å skille fra mobil Safari — capacitor.config.ts setter ingen egen user agent.
 */
function runtimePlatform(): 'ios' | 'android' | 'web' {
  if (typeof window === 'undefined') return 'web';
  const platform = (window as unknown as { Capacitor?: { getPlatform?: () => string } })
    .Capacitor?.getPlatform?.();
  return platform === 'ios' || platform === 'android' ? platform : 'web';
}

/**
 * Hardt tak per sidelasting.
 *
 * Gratisplanen tar 5 000 hendelser i måneden og svarer så 429 — ingen regning,
 * men full blindhet resten av perioden. Per-DSN rate limiting er en
 * Business-funksjon, så dette taket er den eneste bremsen vi har mot at én
 * render-løkke spiser hele måneden på minutter.
 */
const MAX_EVENTS_PER_PAGE_LOAD = 10;
let sentThisPageLoad = 0;

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // DSN-en settes KUN i Vercel Production. Dermed er Sentry automatisk av i dev
  // og på preview-deploys — uten å være avhengig av NEXT_PUBLIC_VERCEL_ENV, som
  // bare finnes hvis «Automatically expose System Environment Variables» står på.
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  environment: 'production',

  // ── Minimal datainnsamling. Se blokken øverst før du rører noe her. ──────
  dataCollection: {
    userInfo: false, // ingen id, e-post, brukernavn eller ip_address
    cookies: false,
    httpHeaders: { request: false, response: false },
    httpBodies: [], // tom liste = ingen forespørsels- eller svarinnhold
    urlQueryParams: false, // ?lat=…&lng=… ER presis posisjon
    graphQL: { document: false, variables: false },
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    // Standard er TRUE selv med sendDefaultPii: false. Lokale variabler i en
    // stack frame inneholder typisk hele Supabase-brukerobjektet.
    stackFrameVariables: false,
    frameContextLines: 5 // vår egen kildekode rundt feilen — ikke persondata
  },

  sendClientReports: false,
  enableLogs: false,
  // tracesSampleRate settes bevisst IKKE. Ingen tracing ⇒ ingen «Performance
  // Data» mot Apple. Skrur du den på, må App Privacy oppdateres samtidig.
  sampleRate: 1.0, // få brukere ⇒ vi vil ha 100 % av de ekte feilene
  maxBreadcrumbs: 20, // ned fra 100

  integrations: (defaults) => [
    ...defaults.filter(
      (integration) =>
        // BrowserSession sender en sesjon ved HVER sidelasting. Det er «Usage
        // Data» hos Apple, og vi har ikke erklært Usage Data. Navnet er
        // verifisert: browserSessionIntegration → name: 'BrowserSession'.
        integration.name !== 'BrowserSession' &&
        // Erstattes under med en snevrere variant.
        integration.name !== 'Breadcrumbs' &&
        // Ligger IKKE i standardlista i 10.69.0 (tracing kommer bare hvis
        // tracesSampleRate settes). Filteret står som vern mot at en senere
        // versjon legger den inn.
        integration.name !== 'BrowserTracing'
    ),
    // Ingen klikksporing (dom), ingen navigasjonshistorikk (history), ingen
    // konsollfangst. Bare fetch — det er den som faktisk forklarer en krasj.
    Sentry.breadcrumbsIntegration({
      console: false,
      dom: false,
      history: false,
      xhr: false,
      fetch: true,
      sentry: true
    })
  ],

  initialScope: {
    tags: { runtime: runtimePlatform() }
  },

  denyUrls: [/^chrome-extension:\/\//i, /^moz-extension:\/\//i, /^safari-(web-)?extension:\/\//i],

  ignoreErrors: [
    // ── WebKit/WKWebView ────────────────────────────────────────────────
    // DETTE er strengene iOS-appen gir når dekningen ryker i skogen. En kopiert
    // Chrome-liste bygget rundt «Failed to fetch» filtrerer bort NØYAKTIG
    // INGENTING på den plattformen dette handler om.
    'Load failed',
    'The network connection was lost',
    'The Internet connection appears to be offline',
    'A server with the specified hostname could not be found',
    'Request timed out',
    // ── Chromium/Firefox (nettsiden) ────────────────────────────────────
    'Failed to fetch',
    'NetworkError when attempting to fetch resource',
    'AbortError',
    'The user aborted a request',
    'The operation was aborted',
    // ── Chunk-lasting ───────────────────────────────────────────────────
    // Smeller ved HVER deploy for åpne faner og webviews, og sier ingenting om
    // kodekvalitet. Historisk den vanligste kvotespiseren.
    'ChunkLoadError',
    'Loading chunk',
    'Loading CSS chunk',
    'Failed to fetch dynamically imported module',
    'error loading dynamically imported module',
    // ── Støy uten handlingsrom ──────────────────────────────────────────
    /^Script error\.?$/,
    'ResizeObserver loop',
    // Microsofts lenkeskanner (Outlook/Teams «Safe Links») kjører sitt eget
    // skript på siden når noen åpner en lenke fra en e-post, og krasjer i det.
    // Ikke vår kode, null brukere rammet — sett første gang 2026-09-05 på
    // /soppforhold/goteborg, altså en åpnet presse-lenke. Kjent støy i Sentry-
    // dokumentasjonen.
    'Object Not Found Matching Id',
    // Supabase auth-js tar en Navigator LockManager-lås rundt sesjonsfornying,
    // med «ifAvailable». Holder en annen fane av samme opprinnelse låsen i
    // akkurat det øyeblikket, kaster biblioteket en uhåndtert avvisning og
    // prøver igjen selv. Ingen bruker merker det; kjent støy oppstrøms
    // (supabase/auth-js). Sett første gang 2026-09-10 på /apenhet, 0 brukere.
    /Navigator LockManager lock/,
    'NavigatorLockAcquireTimeoutError',
    // Offline-kartcachen fyller Cache API på små telefoner.
    'QuotaExceededError'
  ],

  beforeSend(event) {
    if (sentThisPageLoad >= MAX_EVENTS_PER_PAGE_LOAD) return null;
    sentThisPageLoad += 1;
    // Belte og seler oppå dataCollection — se @/lib/sentry/scrub. Delt med
    // server og edge, slik at de tre ikke kan gli fra hverandre igjen.
    return scrubEvent(event);
  },

  /**
   * Appen runder bevisst av koordinater før de sendes videre, nettopp for at
   * meterpresis GPS ikke skal havne i noen forespørselslogg. Uten dette ville
   * fetch-brødsmulene reversert den beslutningen.
   *
   * Merk at det IKKE holder å stryke query-strengen her: kartfliser har
   * posisjonen i selve stien (`/{z}/{y}/{x}`), og de kastes derfor i sin helhet.
   */
  beforeBreadcrumb: scrubBreadcrumb
});

/**
 * ⚠️ IKKE legg til `onRouterTransitionStart` — selv om bygget ber om det.
 *
 * Hvert `npm run build` skriver ut:
 *
 *   [@sentry/nextjs] ACTION REQUIRED: To instrument navigations, the Sentry SDK
 *   requires you to export an `onRouterTransitionStart` hook …
 *
 * «ACTION REQUIRED» er misvisende her. Hooken finnes for å måle NAVIGASJON,
 * altså tracing. Vi setter bevisst ikke `tracesSampleRate` (se over), fordi
 * tracing er «Performance Data» hos Apple — og App Privacy for denne appen
 * erklærer Crash Data og Other Diagnostic Data, ikke Performance Data.
 *
 * Advarselen er altså riktig å la stå. Skal den bort, må App Privacy i App Store
 * Connect og tabellen i docs/app-store-metadata.md endres i samme slengen.
 */
