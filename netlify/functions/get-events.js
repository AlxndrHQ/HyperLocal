// Netlify Function: /.netlify/functions/get-events
// Sprint 47: audited field contract, Luma future-only filter, rich logging
// Field contract (all sources return these keys):
//   id, name, venue, addr, hood, time, price, avail, trending, featured,
//   tags[], genre, vertical, source, ticketUrl, image_url, organizer,
//   lat (number|null), lng (number|null)
// Deploy: netlify/functions/get-events.js

const EVENTBRITE_TOKEN = process.env.EVENTBRITE_TOKEN || '';

// Known metro centers — add zips here to support new areas
const METRO_COORDS = {
  '10001': { lat: 40.7128,  lng: -74.0060,  name: 'New York' },
  '20001': { lat: 38.9072,  lng: -77.0369,  name: 'Washington DC' },
  '20715': { lat: 38.9534,  lng: -76.7341,  name: 'Bowie' },
  '20716': { lat: 38.9357,  lng: -76.7141,  name: 'Bowie' },
  '20720': { lat: 38.9784,  lng: -76.7741,  name: 'Bowie/Mitchellville' },
  '20721': { lat: 38.9612,  lng: -76.7541,  name: 'Mitchellville' },
  '20745': { lat: 38.8076,  lng: -76.9975,  name: 'National Harbor' },
  '20601': { lat: 38.6318,  lng: -76.9797,  name: 'Waldorf' },
  '23510': { lat: 36.8508,  lng: -76.2859,  name: 'Norfolk' },
  '60601': { lat: 41.8781,  lng: -87.6298,  name: 'Chicago' },
  '90210': { lat: 34.0522,  lng: -118.2437, name: 'Los Angeles' },
  '33101': { lat: 25.7617,  lng: -80.1918,  name: 'Miami' },
  '30301': { lat: 33.7490,  lng: -84.3880,  name: 'Atlanta' },
};

// City name → canonical ZIP for proxy resolution
const CITY_ZIP = {
  'bowie': '20715', 'national harbor': '20745', 'waldorf': '20601',
  'washington': '20001', 'dc': '20001', 'new york': '10001', 'nyc': '10001',
  'chicago': '60601', 'miami': '33101', 'los angeles': '90210', 'atlanta': '30301',
  'norfolk': '23510',
};

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const p = event.queryStringParameters || {};

  // ── Resolve center coordinates ──
  let lat, lng, metroName, zip;

  if (p.lat && p.lng) {
    lat = parseFloat(p.lat);
    lng = parseFloat(p.lng);
    metroName = p.name || 'Area';
    zip = p.zip || '20001';
  } else {
    // Normalise city name → ZIP
    const cityKey = (p.city || '').toLowerCase();
    if (cityKey && CITY_ZIP[cityKey]) {
      zip = CITY_ZIP[cityKey];
    } else {
      zip = p.zip || '20001'; // default DC, not NYC
    }
    // Normalise Bowie sub-ZIPs to one lookup key
    const BOWIE = { '20716': '20715', '20720': '20715', '20721': '20715' };
    if (BOWIE[zip]) zip = BOWIE[zip];
    const metro = METRO_COORDS[zip] || METRO_COORDS['20001'];
    lat = metro.lat; lng = metro.lng; metroName = metro.name;
  }

  const vertical = p.vertical || 'all';
  const allEvents = [];
  const errors = [];
  const sourceCounts = {};

  console.log(`[get-events] zip=${zip} lat=${lat} lng=${lng} metro=${metroName} vertical=${vertical}`);

  // ── 1. Eventbrite ──────────────────────────────────────────────
  if (EVENTBRITE_TOKEN) {
    try {
      // start_date.range_start ensures only upcoming events
      const now = new Date().toISOString().split('.')[0] + 'Z';
      const url = `https://www.eventbriteapi.com/v3/events/search/`
        + `?location.latitude=${lat}&location.longitude=${lng}&location.within=20mi`
        + `&sort_by=best&expand=venue,organizer,ticket_availability`
        + `&start_date.range_start=${now}`
        + `&token=${EVENTBRITE_TOKEN}&page_size=25`;

      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        errors.push(`eventbrite: HTTP ${res.status}`);
      } else {
        const data = await res.json();
        (data.events || []).forEach((ev, i) => {
          const vLat = ev.venue?.latitude  ? parseFloat(ev.venue.latitude)  : null;
          const vLng = ev.venue?.longitude ? parseFloat(ev.venue.longitude) : null;
          allEvents.push({
            id:        5000 + i,
            name:      ev.name?.text || 'Event',
            venue:     ev.venue?.name || 'Venue TBD',
            addr:      ev.venue?.address?.address_1
                       || ev.venue?.address?.localized_address_display || '',
            hood:      ev.venue?.address?.city || metroName,
            time:      ev.start?.local
                         ? new Date(ev.start.local).toLocaleTimeString('en-US',
                             { hour: 'numeric', minute: '2-digit' })
                         : 'TBA',
            price:     ev.is_free
                         ? 'Free'
                         : '$' + (ev.ticket_availability?.minimum_ticket_price?.major_value || '?'),
            avail:     50, trending: false, featured: false,
            tags:      [(ev.category?.name || 'EVENT').toUpperCase()],
            genre:     ev.category?.name || 'Live',
            vertical:  mapVertical(ev.category?.name),
            source:    'eventbrite',
            ticketUrl: ev.url || '',
            image_url: ev.logo?.url || ev.logo?.original?.url || null,
            organizer: ev.organizer?.name || null,
            lat:       vLat,
            lng:       vLng,
          });
        });
        sourceCounts.eventbrite = allEvents.filter(e => e.source === 'eventbrite').length;
      }
    } catch (e) {
      errors.push('eventbrite: ' + e.message);
    }
  } else {
    errors.push('eventbrite: EVENTBRITE_TOKEN not set — set in Netlify env vars');
  }

  // ── 2. Posh ────────────────────────────────────────────────────
  // Note: undocumented API — shape may change without warning
  try {
    const poshRes = await fetch(
      `https://posh.vip/api/explore/events?latitude=${lat}&longitude=${lng}&radius=25&limit=15`,
      {
        headers: { Accept: 'application/json', 'User-Agent': 'HyperLocal/1.0' },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!poshRes.ok) {
      errors.push(`posh: HTTP ${poshRes.status}`);
    } else {
      const text = await poshRes.text();
      if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
        const poshData = JSON.parse(text);
        const events = poshData.events || poshData.data || (Array.isArray(poshData) ? poshData : []);
        const before = allEvents.length;
        events.forEach((ev, i) => {
          const vLat = ev.venue?.lat || ev.latitude || null;
          const vLng = ev.venue?.lng || ev.longitude || null;
          allEvents.push({
            id:        6000 + i,
            name:      ev.name || ev.title || 'Posh Event',
            venue:     ev.venue?.name || ev.venueName || 'Venue TBD',
            addr:      ev.venue?.address || '',
            hood:      ev.city || metroName,
            time:      ev.startTime
                         ? new Date(ev.startTime).toLocaleTimeString('en-US',
                             { hour: 'numeric', minute: '2-digit' })
                         : 'TBA',
            price:     ev.minPrice ? '$' + ev.minPrice : 'Free',
            avail:     60, trending: false, featured: false,
            tags:      ['POSH'],
            genre:     'Social',
            vertical:  'afterdark',
            source:    'posh',
            ticketUrl: ev.slug ? `https://posh.vip/e/${ev.slug}` : '',
            image_url: ev.coverImageUrl || ev.flyer || null,
            organizer: ev.organizerName || null,
            poshSlug:  ev.slug || null,
            lat:       vLat ? parseFloat(vLat) : null,
            lng:       vLng ? parseFloat(vLng) : null,
          });
        });
        sourceCounts.posh = allEvents.length - before;
      } else {
        errors.push('posh: non-JSON response (likely blocked)');
      }
    }
  } catch (e) {
    errors.push('posh: ' + e.message);
  }

  // ── 3. Luma ────────────────────────────────────────────────────
  try {
    // after= ensures only future events are returned
    const after = new Date().toISOString();
    const lumaRes = await fetch(
      `https://api.lu.ma/public/v1/calendar/list-events`
      + `?pagination_limit=20&geo_latitude=${lat}&geo_longitude=${lng}&geo_radius_km=40`
      + `&after=${encodeURIComponent(after)}`,
      {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!lumaRes.ok) {
      errors.push(`luma: HTTP ${lumaRes.status}`);
    } else {
      const lumaData = await lumaRes.json();
      const before = allEvents.length;
      (lumaData.entries || []).forEach((item, i) => {
        const ev  = item.event || item;
        const vLat = item.geo_address_info?.latitude  || null;
        const vLng = item.geo_address_info?.longitude || null;
        allEvents.push({
          id:        7000 + i,
          name:      ev.name || 'Luma Event',
          venue:     item.geo_address_info?.address || 'Online',
          addr:      item.geo_address_info?.full_address || '',
          hood:      metroName,
          time:      ev.start_at
                       ? new Date(ev.start_at).toLocaleTimeString('en-US',
                           { hour: 'numeric', minute: '2-digit' })
                       : 'TBA',
          price:     ev.ticket_info?.is_free !== false
                       ? 'Free'
                       : '$' + (ev.ticket_info?.min_ticket_price || '?'),
          avail:     70, trending: false, featured: false,
          tags:      ['LUMA'],
          genre:     'Networking',
          vertical:  mapVertical(ev.tags?.[0]),
          source:    'luma',
          ticketUrl: `https://lu.ma/${ev.url || ev.api_id || ''}`,
          image_url: ev.cover_url || null,
          organizer: ev.hosts?.[0]?.name || null,
          lat:       vLat ? parseFloat(vLat) : null,
          lng:       vLng ? parseFloat(vLng) : null,
        });
      });
      sourceCounts.luma = allEvents.length - before;
    }
  } catch (e) {
    errors.push('luma: ' + e.message);
  }

  // ── Filter by vertical & log summary ──────────────────────────
  const filtered = vertical === 'all'
    ? allEvents
    : allEvents.filter(ev => ev.vertical === vertical);

  const withCoords    = filtered.filter(e => e.lat && e.lng).length;
  const needsGeocode  = filtered.filter(e => !e.lat && !e.lng && (e.addr || e.venue)).length;

  console.log(
    `[get-events] done — total:${filtered.length} withCoords:${withCoords}`
    + ` needsGeocode:${needsGeocode} sources:${JSON.stringify(sourceCounts)}`
    + (errors.length ? ` errors:${JSON.stringify(errors)}` : '')
  );

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      events:      filtered,
      total:       filtered.length,
      withCoords,
      needsGeocode,
      zip, lat, lng,
      metro:       metroName,
      sources:     sourceCounts,
      errors:      errors.length ? errors : undefined,
      timestamp:   new Date().toISOString(),
    }),
  };
};

// ── Vertical mapper ──────────────────────────────────────────────
function mapVertical(category) {
  if (!category) return 'terminal';
  const c = category.toLowerCase();
  if (c.includes('food') || c.includes('culinary') || c.includes('drink') || c.includes('dining')) return 'themenu';
  if (c.includes('music') || c.includes('nightlife') || c.includes('concert') || c.includes('dj')) return 'afterdark';
  if (c.includes('business') || c.includes('network') || c.includes('tech') || c.includes('startup')) return 'professional';
  if (c.includes('religion') || c.includes('spiritual') || c.includes('faith') || c.includes('church')) return 'worship';
  if (c.includes('art') || c.includes('film') || c.includes('comedy') || c.includes('theatre')) return 'theladder';
  return 'terminal';
}
